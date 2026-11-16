import assert from "node:assert/strict";
import test from "node:test";
import { createCatalogHandler } from "../backend/services/catalog/catalog.mjs";
import {
  CatalogStorageError,
  EMPTY_RATINGS_ETAG
} from "../backend/services/catalog/_catalog.mjs";

const siteContext = {
  site: { id: "2e63bd1a-3d35-4bcb-b572-4d8b22e70bbf" },
  deploy: { context: "production" }
};
const productId = "prd_product_one";
const chariowProduct = (id = productId) => ({
  id,
  name: "Chariow product",
  description: "Chariow description",
  status: "draft",
  type: "downloadable",
  pricing: { current_price: { value: 2500, currency: "XOF" } },
  pictures: { cover: "https://cdn.chariow.com/image.jpg" },
  quantity: null
});

function createFixture({ products = [chariowProduct()], ratings = {}, etag = "etag-1" } = {}) {
  const calls = { writes: [], reads: 0 };
  const handler = createCatalogHandler({
    identityApi: { getUser: async () => ({ roles: ["admin"] }) },
    verifyOrigin() {},
    fetchProducts: async () => products,
    readRatings: async () => {
      calls.reads += 1;
      return {
        schemaVersion: 1,
        updatedAt: "2026-03-01T10:00:00.000Z",
        ratings,
        etag,
        initialized: true
      };
    },
    writeRating: async (id, rating, options) => {
      calls.writes.push({ id, rating, options });
      if (options.etag !== etag) {
        throw new CatalogStorageError("RATINGS_CONFLICT", 412, "stale etag");
      }
      return {
        schemaVersion: 1,
        updatedAt: "2026-03-01T10:01:00.000Z",
        ratings: { ...ratings, [id]: rating },
        etag: "etag-2",
        initialized: true
      };
    }
  });
  return { handler, calls };
}

const getRequest = () =>
  new Request("https://pgd-market.netlify.app/.netlify/functions/catalog");

const patchRequest = (id, body, etag = '"etag-1"') =>
  new Request(
    `https://pgd-market.netlify.app/.netlify/functions/catalog?id=${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(etag ? { "If-Match": etag } : {})
      },
      body: JSON.stringify(body)
    }
  );

test("admin GET exposes Chariow IDs, product data, PGD rating and a strong ETag", async () => {
  const { handler } = createFixture({ ratings: { [productId]: 4 } });
  const response = await handler(getRequest(), siteContext);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"etag-1"');
  assert.equal(body.products[0].id, productId);
  assert.equal(body.products[0].rating, 4);
  assert.equal(body.products[0].price, 2500);
  assert.equal(body.products[0].currency, "XOF");
  assert.equal(body.metadata.canEditRatings, true);
});

test("admin Preview GET exposes empty ratings without enabling writes", async () => {
  let readCalls = 0;
  const handler = createCatalogHandler({
    identityApi: { getUser: async () => ({ roles: ["admin"] }) },
    verifyOrigin() {},
    fetchProducts: async () => [chariowProduct()],
    readRatings: async () => {
      readCalls += 1;
      return {
        schemaVersion: 1,
        updatedAt: null,
        ratings: {},
        etag: EMPTY_RATINGS_ETAG,
        initialized: false
      };
    }
  });
  const response = await handler(getRequest(), {
    ...siteContext,
    deploy: { context: "deploy-preview" }
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(readCalls, 1);
  assert.equal(response.headers.get("etag"), '"ratings-empty"');
  assert.equal(body.metadata.canEditRatings, false);
  assert.equal(body.products[0].rating, 0);
});

test("admin can save the first rating without a separate initialization step", async () => {
  const writes = [];
  const handler = createCatalogHandler({
    identityApi: { getUser: async () => ({ roles: ["admin"] }) },
    verifyOrigin() {},
    fetchProducts: async () => [chariowProduct()],
    readRatings: async () => ({
      schemaVersion: 1,
      updatedAt: null,
      ratings: {},
      etag: EMPTY_RATINGS_ETAG,
      initialized: false
    }),
    writeRating: async (id, rating, options) => {
      writes.push({ id, rating, options });
      return {
        schemaVersion: 1,
        updatedAt: "2026-03-01T10:01:00.000Z",
        ratings: { [id]: rating },
        etag: "created-etag",
        initialized: true
      };
    }
  });

  const initial = await handler(getRequest(), siteContext);
  const initialBody = await initial.json();
  const response = await handler(
    patchRequest(productId, { rating: 5 }, initial.headers.get("etag")),
    siteContext
  );
  const body = await response.json();

  assert.equal(initial.headers.get("etag"), '"ratings-empty"');
  assert.equal(initialBody.products[0].rating, 0);
  assert.equal(initialBody.metadata.canEditRatings, true);
  assert.equal(response.status, 200);
  assert.deepEqual(writes, [{
    id: productId,
    rating: 5,
    options: { etag: EMPTY_RATINGS_ETAG }
  }]);
  assert.equal(body.product.rating, 5);
  assert.equal(response.headers.get("etag"), '"created-etag"');
});

test("admin PATCH changes only the PGD rating keyed by canonical Chariow ID", async () => {
  const { handler, calls } = createFixture();
  const response = await handler(patchRequest(productId, { rating: 5 }), siteContext);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"etag-2"');
  assert.deepEqual(calls.writes, [{
    id: productId,
    rating: 5,
    options: { etag: "etag-1" }
  }]);
  assert.equal(body.product.id, productId);
  assert.equal(body.product.rating, 5);
});

test("admin rejects UUID product IDs, unknown Chariow IDs and commercial payload fields", async () => {
  const fixture = createFixture();
  const uuidResponse = await fixture.handler(
    patchRequest("00000000-0000-4000-8000-000000000001", { rating: 3 }),
    siteContext
  );
  const unknownResponse = await fixture.handler(
    patchRequest("prd_unknown_product", { rating: 3 }),
    siteContext
  );
  const extraFieldResponse = await fixture.handler(
    patchRequest(productId, { rating: 3, price: 1 }),
    siteContext
  );

  assert.equal(uuidResponse.status, 400);
  assert.equal(unknownResponse.status, 404);
  assert.equal(extraFieldResponse.status, 400);
  assert.equal(fixture.calls.writes.length, 0);
});

test("admin accepts a zero rating, and stale or missing ETags do not mutate data", async () => {
  const fixture = createFixture();
  const zeroResponse = await fixture.handler(
    patchRequest(productId, { rating: 0 }),
    siteContext
  );
  const staleResponse = await fixture.handler(
    patchRequest(productId, { rating: 3 }, '"stale"'),
    siteContext
  );
  const missingResponse = await fixture.handler(
    patchRequest(productId, { rating: 3 }, ""),
    siteContext
  );

  assert.equal(zeroResponse.status, 200);
  assert.equal((await zeroResponse.json()).product.rating, 0);
  assert.equal(staleResponse.status, 412);
  assert.equal(missingResponse.status, 428);
  assert.equal(fixture.calls.writes.length, 2);
});

test("admin returns an empty stable product list for an empty Chariow catalog", async () => {
  const { handler } = createFixture({ products: [] });
  const response = await handler(getRequest(), siteContext);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.products, []);
  assert.equal(body.metadata.totalProducts, 0);
});

test("production mutations require the PGD site and production deploy context", async () => {
  const { handler } = createFixture();
  const wrongSite = await handler(patchRequest(productId, { rating: 2 }), {
    ...siteContext,
    site: { id: "other-site" }
  });
  const wrongDeploy = await handler(patchRequest(productId, { rating: 2 }), {
    ...siteContext,
    deploy: { context: "deploy-preview" }
  });

  assert.equal(wrongSite.status, 403);
  assert.equal(wrongDeploy.status, 403);
});
