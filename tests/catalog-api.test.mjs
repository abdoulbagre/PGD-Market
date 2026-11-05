import assert from "node:assert/strict";
import test from "node:test";
import {
  CatalogStorageError,
  deleteCatalogProduct,
  initializeCatalog,
  readCatalog,
  writeCatalog
} from "../netlify/functions/_catalog.mjs";
import { createCatalogHandler } from "../netlify/functions/catalog.mjs";

const ADMIN = { id: "admin-user", roles: ["admin"] };
const MEMBER = { id: "member-user", roles: ["member"] };
const INITIAL_ETAG = '"version-1"';
const NOW = "2026-02-01T00:00:00.000Z";
const SITE_CONTEXT = {
  deploy: { context: "production" },
  site: { id: "2e63bd1a-3d35-4bcb-b572-4d8b22e70bbf" }
};

const product = (overrides = {}) => ({
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: { fr: "Produit FR", en: "Product EN" },
  description: { fr: "Description FR", en: "Description EN" },
  price: 4200,
  currency: "XOF",
  image: "assets/images/1.jpg",
  category: "Guides",
  chariowProductId: "prd_existing_123",
  available: true,
  published: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});

test("HTTP headers and body cannot substitute for Netlify execution context", async () => {
  const fixture = await createFixture();
  fixture.operations.reads = 0;
  const request = new Request("https://shop.example/.netlify/functions/catalog", {
    method: "POST",
    headers: {
      origin: "https://shop.example",
      "content-type": "application/json",
      "if-match": INITIAL_ETAG,
      "x-netlify-deploy-context": "production"
    },
    body: JSON.stringify({
      ...editableProduct(),
      context: SITE_CONTEXT
    })
  });
  const response = await fixture.handler(request, null);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "PRODUCTION_CONTEXT_REQUIRED");
  assert.equal(fixture.operations.reads, 0);
  assert.equal(fixture.operations.writes, 0);
});

const initialCatalog = (products = [
  product(),
  product({
    id: "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90",
    name: { fr: "Deuxième produit", en: "Second product" },
    image: "assets/images/2.jpg",
    chariowProductId: "prd_existing_456"
  })
]) => ({
  schemaVersion: 2,
  updatedAt: "2026-01-01T00:00:00.000Z",
  products
});

test("concurrent conditional writes return an explicit 412 without leaking storage details", async () => {
  const fixture = await createFixture();
  const write = fixture.catalogStorage.writeCatalog;
  fixture.catalogStorage.writeCatalog = (catalog, options) => {
    fixture.store.setRaw(JSON.stringify(initialCatalog()), '"external-version"');
    return write(catalog, options);
  };
  const response = await fixture.handler(makeRequest("POST", {
    body: editableProduct()
  }));
  await assertSanitizedError(response, {
    status: 412,
    code: "CATALOG_CONFLICT",
    secret: "private"
  });
});

const editableProduct = (overrides = {}) => ({
  name: { fr: "Nouveau produit", en: "New product" },
  description: { fr: "Description", en: "Description" },
  price: 2500,
  currency: "XOF",
  image: "assets/images/new.jpg",
  category: "Guides",
  chariowProductId: "prd_new_789",
  available: true,
  published: true,
  ...overrides
});

const createMemoryStore = (operations) => {
  let record = null;
  let version = 0;
  return {
    async getWithMetadata() {
      operations.reads += 1;
      if (operations.readError) throw operations.readError;
      if (!record) return null;
      return {
        data: record.rawData ?? JSON.stringify(record.value),
        metadata: record.metadata,
        etag: record.etag
      };
    },
    async setJSON(_key, value, options = {}) {
      operations.writes += 1;
      if (operations.writeError) throw operations.writeError;
      if (options.onlyIfNew && record) return { modified: false };
      if (options.onlyIfMatch && options.onlyIfMatch !== record?.etag) {
        return { modified: false };
      }

      version += 1;
      record = {
        value: JSON.parse(JSON.stringify(value)),
        metadata: options.metadata,
        etag: `"version-${version}"`
      };
      return { modified: true, etag: record.etag };
    },
    setRaw(data, etag = '"version-raw"') {
      record = { rawData: data, metadata: {}, etag };
    }
  };
};

const createFixture = async ({
  user = ADMIN,
  products,
  allowedOrigin = "https://shop.example",
  seed = true
} = {}) => {
  const operations = { reads: 0, writes: 0, originChecks: 0 };
  const store = createMemoryStore(operations);
  if (seed) {
    await initializeCatalog(initialCatalog(products), { store });
  }
  operations.reads = 0;
  operations.writes = 0;

  const identityApi = {
    refreshSession: async () => {},
    getUser: async () => user
  };
  const verifyOrigin = (request) => {
    operations.originChecks += 1;
    if (request.headers.get("origin") !== allowedOrigin) {
      const error = new Error("Origin is forbidden");
      error.status = 403;
      throw error;
    }
  };
  const catalogStorage = {
    readCatalog: () => readCatalog({ store }),
    writeCatalog: (catalog, options) => writeCatalog(catalog, { ...options, store }),
    deleteCatalogProduct: (id, options) =>
      deleteCatalogProduct(id, { ...options, store })
  };
  const handler = createCatalogHandler({
    identityApi,
    verifyOrigin,
    catalogStorage,
    now: () => NOW,
    createId: () => "91e2d3c4-5f6a-4789-ab01-23456789cdef"
  });

  return {
    handler: (request, context = SITE_CONTEXT) => handler(request, context),
    store,
    operations,
    catalogStorage
  };
};

const makeRequest = (method, {
  url = "https://shop.example/.netlify/functions/catalog",
  body,
  etag = INITIAL_ETAG,
  origin = "https://shop.example"
} = {}) => {
  const headers = new Headers();
  if (method !== "GET") {
    if (origin !== null) headers.set("origin", origin);
    if (etag !== null) headers.set("if-match", etag.startsWith('"') ? etag : `"${etag}"`);
  }
  let requestBody = body;
  if (method === "DELETE" && body === undefined) {
    const id = new URL(url).searchParams.get("id");
    requestBody = { confirmation: `DELETE PRODUCT ${id}` };
  }
  if (requestBody !== undefined) headers.set("content-type", "application/json");
  return new Request(url, {
    method,
    headers,
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody)
  });
};

const assertNoStore = (response) =>
  assert.equal(response.headers.get("cache-control"), "no-store");

test("GET denies anonymous users and does not access catalog storage", async () => {
  const fixture = await createFixture({ user: null });
  fixture.operations.reads = 0;
  fixture.operations.writes = 0;

  const response = await fixture.handler(makeRequest("GET"));
  assert.equal(response.status, 401);
  assert.equal(fixture.operations.reads, 0);
  assert.equal(fixture.operations.writes, 0);
  assertNoStore(response);
});

test("GET denies authenticated users without the admin role", async () => {
  const fixture = await createFixture({ user: MEMBER });
  fixture.operations.reads = 0;

  const response = await fixture.handler(makeRequest("GET"));
  assert.equal(response.status, 403);
  assert.equal(fixture.operations.reads, 0);
  assertNoStore(response);
});

test("catalog access rejects non-production and incomplete Netlify contexts before storage access", async (t) => {
  for (const [name, context] of [
    ["deploy preview", { ...SITE_CONTEXT, deploy: { context: "deploy-preview" } }],
    ["branch deploy", { ...SITE_CONTEXT, deploy: { context: "branch-deploy" } }],
    ["wrong site", { ...SITE_CONTEXT, site: { id: "another-site" } }],
    ["missing context", null]
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture();
      fixture.operations.reads = 0;
      const response = await fixture.handler(makeRequest("GET"), context);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, "PRODUCTION_CONTEXT_REQUIRED");
      assert.equal(fixture.operations.reads, 0);
      assertNoStore(response);
    });
  }
});

test("GET returns the full catalog and its ETag to an administrator", async () => {
  const fixture = await createFixture();
  const response = await fixture.handler(makeRequest("GET"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.products.length, 2);
  assert.equal(response.headers.get("etag"), INITIAL_ETAG);
  assertNoStore(response);
});

test("GET filters archived products and rejects unknown query parameters", async () => {
  const fixture = await createFixture({
    products: [
      product({ archivedAt: NOW }),
      product({
        id: "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90",
        name: { fr: "Deuxième produit", en: "Second product" },
        image: "assets/images/2.jpg",
        chariowProductId: "prd_existing_456"
      })
    ]
  });
  const archived = await fixture.handler(makeRequest("GET", {
    url: "https://shop.example/.netlify/functions/catalog?status=archived"
  }));
  assert.deepEqual((await archived.json()).products.map(({ id }) => id), [product().id]);

  const invalidFilter = await fixture.handler(makeRequest("GET", {
    url: "https://shop.example/.netlify/functions/catalog?status=unknown"
  }));
  assert.equal(invalidFilter.status, 400);
  const readsAfterInvalidFilter = fixture.operations.reads;
  const unknownQuery = await fixture.handler(makeRequest("GET", {
    url: "https://shop.example/.netlify/functions/catalog?unexpected=true"
  }));
  assert.equal(unknownQuery.status, 400);
  assert.equal(fixture.operations.reads, readsAfterInvalidFilter);
});

test("POST denies anonymous users before checking origin or accessing storage", async () => {
  const fixture = await createFixture({ user: null });
  fixture.operations.reads = 0;
  fixture.operations.writes = 0;

  const response = await fixture.handler(makeRequest("POST", {
    body: editableProduct()
  }));
  assert.equal(response.status, 401);
  assert.equal(fixture.operations.reads, 0);
  assert.equal(fixture.operations.writes, 0);
  assert.equal(fixture.operations.originChecks, 1);
  assertNoStore(response);
});

test("mutating methods reject untrusted origins before catalog access", async () => {
  const fixture = await createFixture();
  fixture.operations.reads = 0;
  fixture.operations.writes = 0;

  const requests = [
    makeRequest("POST", {
      body: editableProduct(),
      origin: "https://attacker.example"
    }),
    makeRequest("PUT", {
      url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
      body: editableProduct({ chariowProductId: product().chariowProductId }),
      origin: "https://attacker.example"
    }),
    makeRequest("PATCH", {
      url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
      body: { action: "archive" },
      origin: "https://attacker.example"
    }),
    makeRequest("DELETE", {
      url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
      origin: "https://attacker.example"
    })
  ];

  for (const request of requests) {
    const response = await fixture.handler(request);
    assert.equal(response.status, 403);
    assertNoStore(response);
  }
  assert.equal(fixture.operations.reads, 0);
  assert.equal(fixture.operations.writes, 0);
});

test("POST, PUT, and DELETE reject requests without Origin before storage access", async () => {
  for (const [method, requestOptions] of [
    ["POST", { body: editableProduct() }],
    ["PUT", {
      url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
      body: editableProduct({ chariowProductId: product().chariowProductId })
    }],
    ["PATCH", {
      url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
      body: { action: "archive" }
    }],
    ["DELETE", {
      url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`
    }]
  ]) {
    const fixture = await createFixture();
    fixture.operations.reads = 0;
    fixture.operations.writes = 0;
    const response = await fixture.handler(makeRequest(method, {
      ...requestOptions,
      origin: null
    }));

    assert.equal(response.status, 403, `${method} without Origin`);
    assert.equal(fixture.operations.reads, 0, `${method} must not read storage`);
    assert.equal(fixture.operations.writes, 0, `${method} must not write storage`);
    assertNoStore(response);
  }
});

test("POST rejects an untrusted origin before authorization or catalog access", async () => {
  const fixture = await createFixture();
  fixture.operations.reads = 0;
  fixture.operations.writes = 0;

  const response = await fixture.handler(makeRequest("POST", {
    body: editableProduct(),
    origin: "https://attacker.example"
  }));
  assert.equal(response.status, 403);
  assert.equal(fixture.operations.reads, 0);
  assert.equal(fixture.operations.writes, 0);
  assertNoStore(response);
});

test("POST denies authenticated non-admins before catalog access", async () => {
  const fixture = await createFixture({ user: MEMBER });
  fixture.operations.reads = 0;
  fixture.operations.writes = 0;

  const response = await fixture.handler(makeRequest("POST", {
    body: editableProduct()
  }));
  assert.equal(response.status, 403);
  assert.equal(fixture.operations.reads, 0);
  assert.equal(fixture.operations.writes, 0);
  assertNoStore(response);
});

test("POST creates a validated product using a generated UUID and conditional save", async () => {
  const fixture = await createFixture();
  const response = await fixture.handler(makeRequest("POST", {
    body: editableProduct()
  }));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.products.length, 3);
  assert.equal(body.products[2].id, "91e2d3c4-5f6a-4789-ab01-23456789cdef");
  assert.equal(body.products[2].createdAt, NOW);
  assert.equal(body.products[2].updatedAt, NOW);
  assert.equal(response.headers.get("etag"), '"version-2"');
  assertNoStore(response);
});

test("mutations require an ETag and reject invalid canonical product data", async () => {
  const fixture = await createFixture();
  const missingEtag = await fixture.handler(makeRequest("POST", {
    body: editableProduct(),
    etag: null
  }));
  assert.equal(missingEtag.status, 428);

  const invalidProduct = await fixture.handler(makeRequest("POST", {
    body: editableProduct({ price: 0 })
  }));
  assert.equal(invalidProduct.status, 400);
  assert.equal(fixture.operations.writes, 0);
});

test("oversized mutation bodies are rejected before catalog access", async () => {
  const fixture = await createFixture();
  fixture.operations.reads = 0;
  const response = await fixture.handler(new Request(
    "https://shop.example/.netlify/functions/catalog",
    {
      method: "POST",
      headers: {
        origin: "https://shop.example",
        "if-match": INITIAL_ETAG,
        "content-type": "application/json"
      },
      body: "x".repeat(32 * 1024 + 1)
    }
  ));
  assert.equal(response.status, 413);
  assert.equal(fixture.operations.reads, 0);
  assert.equal(fixture.operations.writes, 0);
});

test("POST rejects duplicate and privilege fields without writing", async () => {
  const fixture = await createFixture();
  const duplicateResponse = await fixture.handler(makeRequest("POST", {
    body: { ...editableProduct(), id: product().id }
  }));
  assert.equal(duplicateResponse.status, 409);

  const privilegeResponse = await fixture.handler(makeRequest("POST", {
    body: { ...editableProduct(), role: "admin" }
  }));
  assert.equal(privilegeResponse.status, 400);
  assert.equal(fixture.operations.writes, 0);
});

test("PUT rejects an unknown product and reports stale ETags as conflicts", async () => {
  const fixture = await createFixture();
  const missingResponse = await fixture.handler(makeRequest("PUT", {
    url: "https://shop.example/.netlify/functions/catalog?id=00000000-0000-4000-8000-000000000000",
    body: editableProduct({ chariowProductId: "prd_existing_123" })
  }));
  assert.equal(missingResponse.status, 404);

  const staleResponse = await fixture.handler(makeRequest("PUT", {
    url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
    body: editableProduct({ chariowProductId: "prd_existing_123" }),
    etag: "stale-version"
  }));
  assert.equal(staleResponse.status, 412);
  assert.equal(fixture.operations.writes, 0);
});

test("PUT denies authenticated non-admins before catalog access", async () => {
  const fixture = await createFixture({ user: MEMBER });
  fixture.operations.reads = 0;
  fixture.operations.writes = 0;

  const response = await fixture.handler(makeRequest("PUT", {
    url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
    body: editableProduct({ chariowProductId: product().chariowProductId })
  }));
  assert.equal(response.status, 403);
  assert.equal(fixture.operations.reads, 0);
  assert.equal(fixture.operations.writes, 0);
  assertNoStore(response);
});

test("PUT preserves product identity, dates, and the existing Chariow ID", async () => {
  const fixture = await createFixture();
  const response = await fixture.handler(makeRequest("PUT", {
    url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
    body: {
      ...editableProduct({ chariowProductId: "prd_existing_123" }),
      price: 4900
    }
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.products[0].id, product().id);
  assert.equal(body.products[0].createdAt, product().createdAt);
  assert.equal(body.products[0].chariowProductId, product().chariowProductId);
  assert.equal(body.products[0].price, 4900);
  assertNoStore(response);
});

test("PUT rejects changes to an existing Chariow ID", async () => {
  const fixture = await createFixture();
  const response = await fixture.handler(makeRequest("PUT", {
    url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
    body: editableProduct({ chariowProductId: "prd_replaced_123" })
  }));
  assert.equal(response.status, 400);
  assert.equal(fixture.operations.writes, 0);
});

test("DELETE rejects missing products and stale ETags", async () => {
  const fixture = await createFixture();
  const missingResponse = await fixture.handler(makeRequest("DELETE", {
    url: "https://shop.example/.netlify/functions/catalog?id=00000000-0000-4000-8000-000000000000"
  }));
  assert.equal(missingResponse.status, 404);

  const staleResponse = await fixture.handler(makeRequest("DELETE", {
    url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
    etag: "stale-version"
  }));
  assert.equal(staleResponse.status, 412);
  assert.equal(fixture.operations.writes, 0);
});

test("DELETE denies authenticated non-admins before catalog access", async () => {
  const fixture = await createFixture({ user: MEMBER });
  fixture.operations.reads = 0;
  fixture.operations.writes = 0;

  const response = await fixture.handler(makeRequest("DELETE", {
    url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`
  }));
  assert.equal(response.status, 403);
  assert.equal(fixture.operations.reads, 0);
  assert.equal(fixture.operations.writes, 0);
  assertNoStore(response);
});

test("DELETE removes one product conditionally but refuses to empty the catalog", async () => {
  const fixture = await createFixture();
  const response = await fixture.handler(makeRequest("DELETE", {
    url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.metadata.schemaVersion, 2);
  assert.equal(body.product, null);
  assert.equal(body.products.length, 1);
  assertNoStore(response);

  const singleProductFixture = await createFixture({ products: [product()] });
  singleProductFixture.operations.writes = 0;
  const lastProductResponse = await singleProductFixture.handler(makeRequest("DELETE", {
    url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`
  }));
  assert.equal(lastProductResponse.status, 409);
  assert.equal(singleProductFixture.operations.writes, 0);
});

test("DELETE requires the exact product confirmation", async () => {
  const fixture = await createFixture();
  for (const body of [{}, { confirmation: "DELETE PRODUCT another-id" }]) {
    const response = await fixture.handler(makeRequest("DELETE", {
      url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
      body
    }));
    assert.equal(response.status, 400);
  }
  assert.equal(fixture.operations.writes, 0);
});

test("PATCH archives and restores products using the current ETag", async () => {
  const fixture = await createFixture({
    products: [
      product({ available: false, published: false }),
      product({
        id: "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90",
        name: { fr: "Deuxième produit", en: "Second product" },
        image: "assets/images/2.jpg",
        chariowProductId: "prd_existing_456"
      })
    ]
  });
  const url = `https://shop.example/.netlify/functions/catalog?id=${product().id}`;
  const archivedResponse = await fixture.handler(makeRequest("PATCH", {
    url,
    body: { action: "archive" }
  }));
  const archivedBody = await archivedResponse.json();
  assert.equal(archivedResponse.status, 200);
  assert.equal(archivedBody.product.archivedAt, NOW);
  assert.equal(archivedBody.product.available, false);

  const archiveList = await fixture.handler(makeRequest("GET", {
    url: "https://shop.example/.netlify/functions/catalog?status=archived"
  }));
  assert.deepEqual((await archiveList.json()).products.map(({ id }) => id), [product().id]);

  const restoredResponse = await fixture.handler(makeRequest("PATCH", {
    url,
    body: { action: "restore" },
    etag: archivedResponse.headers.get("etag")
  }));
  const restoredBody = await restoredResponse.json();
  assert.equal(restoredResponse.status, 200);
  assert.equal(restoredBody.product.archivedAt, null);
  assert.equal(restoredBody.product.available, false);
  assert.equal(restoredBody.product.published, false);
  assert.notEqual(restoredResponse.headers.get("etag"), archivedResponse.headers.get("etag"));
});

test("PATCH rejects invalid archive transitions and stale ETags without writing", async (t) => {
  for (const [name, action, etag, expectedStatus] of [
    ["unknown action", "delete", INITIAL_ETAG, 400],
    ["already archived", "archive", INITIAL_ETAG, 409],
    ["stale ETag", "archive", "stale-version", 412]
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({
        products: [
          product({
            ...(name === "already archived" ? { archivedAt: NOW } : {})
          }),
          product({
            id: "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90",
            name: { fr: "Deuxième produit", en: "Second product" },
            image: "assets/images/2.jpg",
            chariowProductId: "prd_existing_456"
          })
        ]
      });
      const response = await fixture.handler(makeRequest("PATCH", {
        url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
        body: { action },
        etag
      }));
      assert.equal(response.status, expectedStatus);
      assert.equal(fixture.operations.writes, 0);
    });
  }
});

test("catalog operations return a consistent catalog shape, ETag, and no-store headers", async () => {
  const fixture = await createFixture();
  const expectedShape = ["metadata", "product", "products", "schemaVersion", "updatedAt"];
  const responses = [];

  responses.push(await fixture.handler(makeRequest("GET")));
  const postResponse = await fixture.handler(makeRequest("POST", {
    body: editableProduct()
  }));
  responses.push(postResponse);
  const putResponse = await fixture.handler(makeRequest("PUT", {
    url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
    body: editableProduct({
      chariowProductId: product().chariowProductId,
      price: 4700
    }),
    etag: postResponse.headers.get("etag")
  }));
  responses.push(putResponse);
  const patchResponse = await fixture.handler(makeRequest("PATCH", {
    url: `https://shop.example/.netlify/functions/catalog?id=${product().id}`,
    body: { action: "archive" },
    etag: putResponse.headers.get("etag")
  }));
  responses.push(patchResponse);
  const deleteResponse = await fixture.handler(makeRequest("DELETE", {
    url: "https://shop.example/.netlify/functions/catalog?id=7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90",
    etag: patchResponse.headers.get("etag")
  }));
  responses.push(deleteResponse);

  assert.deepEqual(
    responses.map(({ status }) => status),
    [200, 201, 200, 200, 200]
  );
  const bodies = await Promise.all(responses.map((response) => response.json()));
  for (const [index, body] of bodies.entries()) {
    assert.deepEqual(Object.keys(body).sort(), expectedShape, `method index ${index}`);
    assert.ok(Array.isArray(body.products));
    assert.ok(responses[index].headers.get("etag"));
    assertNoStore(responses[index]);
  }
  assert.equal(bodies[0].products.length, 2);
  assert.equal(bodies[1].products.length, 3);
  assert.equal(bodies[2].products.length, 3);
  assert.equal(bodies[3].products.length, 3);
  assert.equal(bodies[4].products.length, 2);
  assert.ok(bodies[3].products.some(({ id }) =>
    id === "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90"
  ));
  assert.ok(bodies[3].products.some(({ id }) =>
    id === "91e2d3c4-5f6a-4789-ab01-23456789cdef"
  ));
});

const assertSanitizedError = async (response, { status, code, secret }) => {
  assert.equal(response.status, status);
  const body = await response.text();
  const parsed = JSON.parse(body);
  assert.equal(parsed.error, code);
  assert.equal(body.includes(secret), false);
  assert.equal(body.includes("stack"), false);
  assertNoStore(response);
  return parsed;
};

test("GET reports an absent catalog explicitly without substituting an empty catalog", async () => {
  const fixture = await createFixture({ seed: false });
  const response = await fixture.handler(makeRequest("GET"));
  const body = await assertSanitizedError(response, {
    status: 404,
    code: "CATALOG_NOT_FOUND",
    secret: "secret"
  });
  assert.equal(Object.hasOwn(body, "products"), false);
});

test("GET reports corrupt catalog data without exposing stored contents", async () => {
  const fixture = await createFixture();
  fixture.store.setRaw('{"secret":"private catalog data"}');
  const response = await fixture.handler(makeRequest("GET"));
  await assertSanitizedError(response, {
    status: 503,
    code: "CATALOG_CORRUPT",
    secret: "private catalog data"
  });
});

test("GET reports Netlify Blobs unavailability and unexpected read errors safely", async () => {
  const unavailableFixture = await createFixture();
  unavailableFixture.operations.readError = new Error("private storage endpoint secret");
  const unavailableResponse = await unavailableFixture.handler(makeRequest("GET"));
  await assertSanitizedError(unavailableResponse, {
    status: 503,
    code: "CATALOG_UNAVAILABLE",
    secret: "private storage endpoint secret"
  });

  const readErrorFixture = await createFixture();
  readErrorFixture.catalogStorage.readCatalog = async () => {
    throw new Error("internal read stack secret");
  };
  const readErrorResponse = await readErrorFixture.handler(makeRequest("GET"));
  await assertSanitizedError(readErrorResponse, {
    status: 503,
    code: "CATALOG_UNAVAILABLE",
    secret: "internal read stack secret"
  });
});

test("POST reports save failures without leaking storage error details", async () => {
  const fixture = await createFixture();
  fixture.operations.writeError = new Error("private save endpoint secret");
  const response = await fixture.handler(makeRequest("POST", {
    body: editableProduct()
  }));
  await assertSanitizedError(response, {
    status: 503,
    code: "CATALOG_WRITE_UNAVAILABLE",
    secret: "private save endpoint secret"
  });
});

test("all unsupported methods return 405 without accessing storage", async () => {
  const fixture = await createFixture();
  fixture.operations.reads = 0;
  fixture.operations.writes = 0;
  const response = await fixture.handler(makeRequest("OPTIONS"));

  assert.equal(response.status, 405);
  assert.equal(fixture.operations.reads, 0);
  assert.equal(fixture.operations.writes, 0);
  assertNoStore(response);
});
