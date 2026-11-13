import assert from "node:assert/strict";
import test from "node:test";
import { createPublicCatalogHandler } from "../backend/functions/public-catalog.mjs";
import { ChariowApiError } from "../backend/services/chariow/products.mjs";

const ORIGIN = "https://pgd-market.netlify.app";
const firstProductId = "prd_5lj7fz8k";
const secondProductId = "prd_ln1r0vbr";
const chariowProduct = (overrides = {}) => ({
  id: firstProductId,
  name: "Produit Chariow",
  description: "Description Chariow",
  type: "downloadable",
  status: "published",
  is_free: false,
  has_variant_pricing: false,
  category: { value: "guides", label: "Guides" },
  pictures: {
    cover: "https://cdn.chariow.com/products/cover.jpg",
    thumbnail: "https://cdn.chariow.com/products/thumbnail.jpg"
  },
  pricing: {
    type: "fixed",
    current_price: { value: 4200.5, currency: "XOF" }
  },
  quantity: null,
  ...overrides
});
const request = (method = "GET") =>
  new Request(`${ORIGIN}/.netlify/functions/public-catalog`, { method });
const handlerFor = (products, options = {}) => createPublicCatalogHandler({
  productReader: async () => products,
  env: { CHARIOW_ADMIN_API_KEY: "server-only-key", ...options.env }
});

test("public GET keeps the Chariow ID canonical and returns exact legacy mappings separately", async () => {
  const source = chariowProduct();
  const response = await handlerFor([source])(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    success: true,
    count: 1,
    products: [{
      id: firstProductId,
      legacyPgdId: "550e8400-e29b-41d4-a716-446655440000",
      name: source.name,
      description: source.description,
      price: 4200.5,
      currency: "XOF",
      image: source.pictures.cover,
      category: "Guides"
    }]
  });
  assert.doesNotMatch(JSON.stringify(body), /server-only-key|Authorization|delivery|fichier/i);
});

test("public catalog selects the current price and falls back to the local image safely", async () => {
  const source = chariowProduct({
    id: secondProductId,
    pictures: { cover: "http://insecure.example/image.jpg", thumbnail: null },
    pricing: {
      type: "fixed",
      current_price: { value: 15.75, currency: "EUR" },
      effective: { value: 15.75, currency: "EUR" }
    }
  });
  const response = await handlerFor([source])(request());
  const body = await response.json();

  assert.equal(body.products[0].id, secondProductId);
  assert.equal(body.products[0].legacyPgdId, "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90");
  assert.equal(body.products[0].price, 15.75);
  assert.equal(body.products[0].currency, "EUR");
  assert.equal(body.products[0].image, "assets/images/2.jpg");
});

test("public catalog excludes unsupported products but includes new Chariow products", async () => {
  const newProduct = chariowProduct({ id: "prd_new_product" });
  const response = await handlerFor([
    chariowProduct({ status: "draft" }),
    chariowProduct({ id: "550e8400-e29b-41d4-a716-446655440000" }),
    chariowProduct({ id: secondProductId, has_variant_pricing: true }),
    chariowProduct({ id: secondProductId, is_free: true }),
    chariowProduct({ id: secondProductId, type: "service" }),
    chariowProduct({ id: secondProductId, pricing: { type: "what_you_want" } }),
    chariowProduct({ id: secondProductId, quantity: { remaining: { value: 0 } } }),
    newProduct
  ])(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.count, 1);
  assert.deepEqual(body.products[0], {
    id: "prd_new_product",
    legacyPgdId: null,
    name: newProduct.name,
    description: newProduct.description,
    price: 4200.5,
    currency: "XOF",
    image: newProduct.pictures.cover,
    category: "Guides"
  });
});

test("public endpoint rejects non-GET methods without contacting Chariow", async () => {
  let reads = 0;
  const handler = createPublicCatalogHandler({
    productReader: async () => {
      reads += 1;
      return [];
    }
  });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await handler(request(method));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  }
  assert.equal(reads, 0);
});

test("public responses use the documented cache and security headers", async () => {
  const response = await handlerFor([])(request());
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, s-maxage=30, stale-while-revalidate=30"
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("upstream failures are sanitized and configuration values are not exposed", async (t) => {
  for (const error of [
    new ChariowApiError(503, "CHARIOW_CONFIGURATION_MISSING", "private configuration"),
    new ChariowApiError(503, "CHARIOW_SCOPE_MISSING", "private scope detail"),
    new ChariowApiError(504, "CHARIOW_TIMEOUT", "private timeout detail")
  ]) {
    await t.test(error.code, async () => {
      const response = await createPublicCatalogHandler({
        productReader: async () => { throw error; }
      })(request());
      const body = await response.json();

      assert.equal(response.status, error.status === 504 ? 504 : 503);
      assert.equal(body.error, error.code);
      assert.doesNotMatch(JSON.stringify(body), /private|secret|token|key/i);
    });
  }
});
