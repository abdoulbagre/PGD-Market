import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPaymentHandler } = require("../backend/functions/create-payment.js");

const product = (overrides = {}) => ({
  id: "prd_server_product",
  name: "Produit FR",
  description: "Description FR",
  type: "downloadable",
  status: "published",
  is_free: false,
  has_variant_pricing: false,
  pricing: {
    type: "one_time",
    current_price: { value: 4200, currency: "XOF" }
  },
  quantity: null,
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
    ...overrides
  })
});

const createHandler = ({
  chariowProduct = product(),
  productError,
  checkoutResponse,
  checkoutStatus = 200
} = {}) => {
  const productRequests = [];
  const checkoutRequests = [];
  const handler = createPaymentHandler({
    productReader: async (options) => {
      productRequests.push(options);
      if (productError) throw productError;
      return chariowProduct;
    },
    fetchImpl: async (url, options) => {
      checkoutRequests.push({ url, options });
      return new Response(JSON.stringify(checkoutResponse || {
        data: {
          step: "payment",
          payment: { checkout_url: "https://checkout.chariow.com/session" }
        }
      }), { status: checkoutStatus });
    },
    env: {
      CHARIOW_ADMIN_API_KEY: "read-test-key",
      CHARIOW_API_KEY: "checkout-test-key",
      CHARIOW_API_BASE_URL: "https://chariow.invalid/v1",
      URL: "https://shop.example"
    }
  });
  return { handler, productRequests, checkoutRequests };
};

test("checkout validates a Chariow product server-side and sends its ID without client price", async () => {
  const fixture = createHandler();
  const response = await fixture.handler(event({
    price: 1,
    currency: "EUR",
    chariowProductId: "prd_browser_value"
  }));
  const body = JSON.parse(response.body);
  const request = fixture.checkoutRequests[0];
  const chariowPayload = JSON.parse(request.options.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body, {
    status: "payment",
    checkout_url: "https://checkout.chariow.com/session"
  });
  assert.equal(fixture.productRequests.length, 1);
  assert.equal(fixture.productRequests[0].productId, product().id);
  assert.equal(fixture.productRequests[0].apiKey, "read-test-key");
  assert.equal(request.url, "https://chariow.invalid/v1/checkout");
  assert.equal(chariowPayload.product_id, product().id);
  assert.equal("price" in chariowPayload, false);
  assert.equal("currency" in chariowPayload, false);
  assert.equal(chariowPayload.payment_currency, "XOF");
  assert.equal(chariowPayload.first_name, "Client");
  assert.equal(chariowPayload.last_name, "Exemple");
  assert.equal(chariowPayload.redirect_url, "https://shop.example/success.html");
  assert.equal(chariowPayload.custom_metadata.produit_id, product().id);
  assert.equal("chariowProductId" in chariowPayload, false);
});

test("malformed and legacy PGD IDs are rejected before any API request", async (t) => {
  for (const id of ["not-a-chariow-id", "550e8400-e29b-41d4-a716-446655440000"]) {
    await t.test(id, async () => {
      const fixture = createHandler();
      const response = await fixture.handler(event({ produitId: id }));

      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).code, "INVALID_CHECKOUT_DATA");
      assert.equal(fixture.productRequests.length, 0);
      assert.equal(fixture.checkoutRequests.length, 0);
    });
  }
});

test("unknown Chariow products are rejected without starting checkout", async () => {
  const fixture = createHandler({
    productError: Object.assign(new Error("not found"), {
      code: "CHARIOW_PRODUCT_NOT_FOUND",
      status: 404
    })
  });
  const response = await fixture.handler(event());

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).code, "PRODUCT_NOT_FOUND");
  assert.equal(fixture.checkoutRequests.length, 0);
});

test("the server rejects a product response that does not match the requested ID", async () => {
  const fixture = createHandler({
    chariowProduct: product({ id: "prd_different_product" })
  });
  const response = await fixture.handler(event());

  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.body).code, "CHARIOW_INVALID_RESPONSE");
  assert.equal(fixture.checkoutRequests.length, 0);
});

test("unpublished, unsupported, variant, free, or unpriced products fail closed", async (t) => {
  const invalidProducts = [
    { status: "draft" },
    { type: "service" },
    { type: "coaching" },
    { has_variant_pricing: true },
    { is_free: true },
    { pricing: { type: "free", current_price: { value: 0, currency: "XOF" } } },
    { pricing: { type: "what_you_want", current_price: { value: 5, currency: "XOF" } } },
    { pricing: { type: "one_time", current_price: { value: 0, currency: "XOF" } } },
    { quantity: { remaining: { value: 0 } } }
  ];
  for (const [index, overrides] of invalidProducts.entries()) {
    await t.test(String(index), async () => {
      const fixture = createHandler({ chariowProduct: product(overrides) });
      const response = await fixture.handler(event());

      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).code, "PRODUCT_UNAVAILABLE");
      assert.equal(fixture.checkoutRequests.length, 0);
    });
  }
});

test("product lookup failures fail closed without contacting the checkout endpoint", async () => {
  const fixture = createHandler({
    productError: Object.assign(new Error("private upstream details"), {
      code: "CHARIOW_SCOPE_MISSING",
      status: 503
    })
  });
  const response = await fixture.handler(event());
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 503);
  assert.equal(body.code, "CHARIOW_READ_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(body), /private upstream details|read-test-key|checkout-test-key/);
  assert.equal(fixture.checkoutRequests.length, 0);
});

test("checkout handles completed and already-purchased states from Chariow", async (t) => {
  await t.test("completed", async () => {
    const fixture = createHandler({
      checkoutResponse: { data: { step: "completed", purchase: { status: "completed" } } }
    });
    const response = await fixture.handler(event());

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { status: "completed" });
  });

  await t.test("already purchased", async () => {
    const fixture = createHandler({
      checkoutResponse: {
        data: {
          step: "already_purchased",
          purchase: null,
          message: "You already own this product."
        }
      }
    });
    const response = await fixture.handler(event());
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 409);
    assert.equal(body.code, "ALREADY_PURCHASED");
    assert.match(body.error, /Chariow indique/);
  });
});

test("checkout rejects unsafe hosted URLs and sanitizes upstream HTTP errors", async (t) => {
  await t.test("unsafe URL", async () => {
    const fixture = createHandler({
      checkoutResponse: {
        data: { step: "payment", payment: { checkout_url: "https://attacker.example/session" } }
      }
    });
    const response = await fixture.handler(event());

    assert.equal(response.statusCode, 502);
    assert.equal(JSON.parse(response.body).code, "CHARIOW_INVALID_RESPONSE");
  });

  await t.test("upstream error", async () => {
    const fixture = createHandler({
      checkoutResponse: { message: "sensitive upstream message" },
      checkoutStatus: 500
    });
    const response = await fixture.handler(event());
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 502);
    assert.equal(body.code, "CHARIOW_CHECKOUT_FAILED");
    assert.doesNotMatch(JSON.stringify(body), /sensitive upstream message/);
  });
});
