import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { isPurchasable } from "../backend/services/catalog/_catalog-model.mjs";

const require = createRequire(import.meta.url);
const { createPaymentHandler } = require("../backend/functions/create-payment.js");

const product = (overrides = {}) => ({
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: { fr: "Produit FR", en: "Product EN" },
  description: { fr: "Description FR", en: "Product description" },
  price: 4200,
  currency: "XOF",
  image: "assets/images/1.jpg",
  category: "Guides",
  chariowProductId: "prd_server_product",
  available: true,
  published: true,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});

const event = (overrides = {}) => ({
  httpMethod: "POST",
  body: JSON.stringify({
    nom: "Client Exemple",
    email: "client@example.com",
    phone: "123456789",
    phoneCountryCode: "BF",
    produitId: product().id,
    currency: "XOF",
    ...overrides
  })
});

const createHandler = ({
  products = [product()],
  catalogError,
  fetchImpl,
  purchasable = isPurchasable
} = {}) => {
  let catalogReads = 0;
  const paymentRequests = [];
  const handler = createPaymentHandler({
    catalogReader: async () => {
      catalogReads += 1;
      if (catalogError) throw catalogError;
      return { catalog: { products }, isPurchasable: purchasable };
    },
    fetchImpl: async (url, options) => {
      paymentRequests.push({ url, options });
      return fetchImpl
        ? fetchImpl(url, options)
        : {
            ok: true,
            status: 200,
            json: async () => ({
              data: { payment: { checkout_url: "https://checkout.example/session" } }
            })
          };
    },
    env: {
      CHARIOW_API_KEY: "unit-test-key",
      CHARIOW_API_BASE_URL: "https://chariow.invalid/v1",
      URL: "https://shop.example"
    }
  });
  return { handler, paymentRequests, get catalogReads() { return catalogReads; } };
};

test("checkout resolves server price and Chariow ID and preserves the Chariow contract", async () => {
  const fixture = createHandler();
  const response = await fixture.handler(event({
    price: 1,
    chariowProductId: "prd_browser_value"
  }));
  const body = JSON.parse(response.body);
  const request = fixture.paymentRequests[0];
  const chariowPayload = JSON.parse(request.options.body);

  assert.equal(fixture.catalogReads, 1);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(body, { checkout_url: "https://checkout.example/session" });
  assert.equal(request.url, "https://chariow.invalid/v1/checkout");
  assert.equal(chariowPayload.product_id, "prd_server_product");
  assert.equal(chariowPayload.product_id, product().chariowProductId);
  assert.equal("price" in chariowPayload, false);
  assert.equal(chariowPayload.payment_currency, "XOF");
  assert.equal(chariowPayload.first_name, "Client");
  assert.equal(chariowPayload.last_name, "Exemple");
  assert.equal(chariowPayload.redirect_url, "https://shop.example/success.html");
  assert.equal(chariowPayload.custom_metadata.produit_id, product().id);
  assert.equal("chariowProductId" in chariowPayload, false);
});

test("unknown products are rejected without contacting Chariow", async () => {
  const fixture = createHandler();
  const response = await fixture.handler(event({
    produitId: "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90"
  }));

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error, "Produit introuvable.");
  assert.equal(fixture.paymentRequests.length, 0);
});

test("products unavailable for sale are rejected without contacting Chariow", async () => {
  const fixture = createHandler({
    products: [product({ available: false })]
  });
  const response = await fixture.handler(event());

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "Produit indisponible à la vente.");
  assert.equal(fixture.paymentRequests.length, 0);
});

test("products without a server Chariow ID are rejected", async () => {
  const fixture = createHandler({
    products: [product({ chariowProductId: null, available: false })],
    purchasable: () => true
  });
  const response = await fixture.handler(event({
    chariowProductId: "prd_browser_value"
  }));

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "Produit indisponible à la vente.");
  assert.equal(fixture.paymentRequests.length, 0);
});

test("products with an invalid server Chariow ID are rejected", async () => {
  const fixture = createHandler({
    products: [product({ chariowProductId: "browser-like-value" })]
  });
  const response = await fixture.handler(event());

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "Produit indisponible à la vente.");
  assert.equal(fixture.paymentRequests.length, 0);
});

test("browser-supplied price cannot make an invalid server price purchasable", async () => {
  const fixture = createHandler({
    products: [product({ price: 0 })]
  });
  const response = await fixture.handler(event({ price: 4200 }));

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "Produit indisponible à la vente.");
  assert.equal(fixture.paymentRequests.length, 0);
});

test("catalog read failures fail closed without contacting Chariow", async () => {
  const fixture = createHandler({
    catalogError: Object.assign(new Error("storage unavailable"), {
      code: "CATALOG_UNAVAILABLE"
    })
  });
  const response = await fixture.handler(event());

  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error, "Le catalogue est temporairement indisponible.");
  assert.equal(fixture.paymentRequests.length, 0);
});
