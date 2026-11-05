import assert from "node:assert/strict";
import test from "node:test";
import { CatalogStorageError } from "../netlify/lib/catalog/_catalog.mjs";
import { createPublicCatalogHandler } from "../netlify/functions/public-catalog.mjs";

const ORIGIN = "https://pgd-market.netlify.app";
const product = (overrides = {}) => ({
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: { fr: "Produit FR", en: "Product EN" },
  description: { fr: "Description FR", en: "Description EN" },
  price: 4200,
  currency: "XOF",
  image: "assets/images/1.jpg",
  category: "Guides",
  chariowProductId: "prd_hidden_reference",
  available: true,
  published: true,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});
const catalog = (products = [product()]) => ({
  schemaVersion: 2,
  updatedAt: "2026-01-02T00:00:00.000Z",
  products
});
const request = (method = "GET") =>
  new Request(`${ORIGIN}/.netlify/functions/public-catalog`, { method });
const handlerFor = (value) => createPublicCatalogHandler({
  catalogReader: async () => ({ catalog: value })
});

test("public GET includes only visible products and projects public fields", async () => {
  const value = catalog([
    product(),
    product({
      id: "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90",
      archivedAt: "2026-01-02T00:00:00.000Z"
    }),
    product({
      id: "8f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c91",
      available: false
    }),
    product({
      id: "9f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c92",
      available: false,
      published: false
    }),
    product({
      id: "0f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c93",
      chariowProductId: null,
      available: false
    })
  ]);
  const response = await handlerFor(value)(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    success: true,
    count: 1,
    products: [{
      id: value.products[0].id,
      name: value.products[0].name,
      description: value.products[0].description,
      price: 4200,
      currency: "XOF",
      image: "assets/images/1.jpg",
      category: "Guides"
    }]
  });
  assert.deepEqual(Object.keys(body.products[0]).sort(), [
    "category", "currency", "description", "id", "image", "name", "price"
  ]);
  assert.doesNotMatch(JSON.stringify(body), /chariow|archivedAt|createdAt|updatedAt|schemaVersion|delivery|fichier/i);
});

test("public endpoint rejects non-GET methods without reading storage", async () => {
  let reads = 0;
  const handler = createPublicCatalogHandler({
    catalogReader: async () => {
      reads += 1;
      return { catalog: catalog() };
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
  const response = await handlerFor(catalog())(request());
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, s-maxage=30, stale-while-revalidate=30"
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("public endpoint reports sanitized catalog errors", async (t) => {
  for (const [code, expectedCode] of [
    ["CATALOG_NOT_FOUND", "CATALOG_NOT_INITIALIZED"],
    ["CATALOG_CORRUPT", "CATALOG_INVALID"],
    ["CATALOG_UNAVAILABLE", "CATALOG_UNAVAILABLE"]
  ]) {
    await t.test(code, async () => {
      const handler = createPublicCatalogHandler({
        catalogReader: async () => {
          throw new CatalogStorageError(code, 503, "private storage details");
        }
      });
      const response = await handler(request());
      const body = await response.json();

      assert.equal(response.status, 503);
      assert.equal(body.error, expectedCode);
      assert.doesNotMatch(JSON.stringify(body), /private storage details|stack|secret|token/i);
    });
  }
});
