import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CATALOG_TARGET,
  CatalogOperatorError,
  runCatalogInitialization
} from "../scripts/initialize-catalog.mjs";
import {
  CatalogStorageError,
  initializeCatalogFromLegacy,
  readCatalog
} from "../netlify/functions/_catalog.mjs";
import {
  createCatalogInitializationHandler
} from "../netlify/functions/initialize-catalog.mjs";

const require = createRequire(import.meta.url);
const serverProducts = require("../netlify/functions/_products.js").products;
const publicSource = await readFile(
  new URL("../public/assets/js/products.js", import.meta.url),
  "utf8"
);
const publicModule = await import(
  `data:text/javascript;base64,${Buffer.from(publicSource).toString("base64")}`
);
const englishLocale = JSON.parse(await readFile(
  new URL("../public/locales/en.json", import.meta.url),
  "utf8"
));

const legacyData = {
  publicProducts: publicModule.products,
  serverProducts,
  englishTranslations: englishLocale.products,
  referenceCurrency: "XOF"
};
const environment = {
  CONTEXT: "production",
  NETLIFY_BLOBS_CONTEXT: Buffer.from(JSON.stringify({
    siteID: "test-site-id",
    token: "test-token"
  })).toString("base64")
};

const makeMemoryStore = () => {
  let record = null;
  let writes = 0;
  let successfulWrites = 0;
  return {
    async getWithMetadata() {
      if (!record) return null;
      return {
        data: JSON.stringify(record.value),
        metadata: record.metadata,
        etag: record.etag
      };
    },
    async setJSON(key, value, options = {}) {
      writes += 1;
      if (options.onlyIfNew && record) return { modified: false };
      successfulWrites += 1;
      record = {
        value: structuredClone(value),
        metadata: options.metadata,
        etag: "memory-etag-1"
      };
      return { modified: true, etag: record.etag };
    },
    get writes() {
      return writes;
    },
    get successfulWrites() {
      return successfulWrites;
    }
  };
};

const createDependencies = (overrides = {}) => {
  const store = overrides.store ?? makeMemoryStore();
  return {
    store,
    dependencies: {
      verifySite: async () => {},
      loadLegacyData: async () => legacyData,
      readCatalog: () => readCatalog({ store }),
      initializeCatalogFromLegacy: (data) =>
        initializeCatalogFromLegacy(data, { store }),
      prompt: async () => "not confirmed",
      log: () => {},
      ...overrides.dependencies
    }
  };
};

const missingCatalog = () =>
  new CatalogStorageError("CATALOG_NOT_FOUND", 404, "Catalog has not been initialized.");

const unavailableCatalog = () =>
  new CatalogStorageError("CATALOG_UNAVAILABLE", 503, "Catalog storage is unavailable.");

const corruptCatalog = () =>
  new CatalogStorageError("CATALOG_CORRUPT", 500, "Stored catalog is invalid.");

const INITIALIZATION_SECRET = "test-only-initialization-secret-32";
const initializationEnvironment = {
  CONTEXT: "production",
  CATALOG_INITIALIZATION_SECRET: INITIALIZATION_SECRET,
  NETLIFY_BLOBS_CONTEXT: Buffer.from(JSON.stringify({
    siteID: "2e63bd1a-3d35-4bcb-b572-4d8b22e70bbf",
    token: "test-only-token"
  })).toString("base64")
};
const initializationContext = {
  deploy: { context: "production" },
  site: {
    id: "2e63bd1a-3d35-4bcb-b572-4d8b22e70bbf",
    name: "pgd-market",
    url: "https://pgd-market.netlify.app"
  }
};

const createInitializationRequest = ({ body = "{}", headers = {} } = {}) => new Request(
  "https://pgd-market.netlify.app/.netlify/functions/initialize-catalog",
  {
    method: "POST",
    headers: {
      Origin: "https://pgd-market.netlify.app",
      "Content-Type": "application/json",
      ...headers
    },
    body
  }
);

const createInitializationFixture = ({
  store = makeMemoryStore(),
  environment = initializationEnvironment,
  context = initializationContext,
  authorizeAdmin = async () => ({ roles: ["admin"] }),
  verifyOrigin = () => {},
  catalogReader = () => readCatalog({ store }),
  initialize = (data) => initializeCatalogFromLegacy(data, { store }),
  loadLegacyData: loadData = async () => legacyData
} = {}) => {
  const handler = createCatalogInitializationHandler({
    authorizeAdmin,
    verifyOrigin,
    catalogReader,
    initialize,
    loadLegacyData: loadData,
    environment
  });
  return { handler, store, context };
};

test("simulation accepts only the confirmed missing-catalog result", async () => {
  const { dependencies } = createDependencies({
    dependencies: { readCatalog: async () => { throw missingCatalog(); } }
  });
  const result = await runCatalogInitialization({ environment, dependencies });
  assert.equal(result.status, "simulation");
  assert.equal(result.catalog.schemaVersion, 2);
  assert.equal(result.catalog.products.length, 2);
});

test("existing catalog stops before preparing or writing", async () => {
  const { store, dependencies } = createDependencies({
    dependencies: {
      readCatalog: async () => ({ catalog: {}, etag: "existing" }),
      loadLegacyData: async () => assert.fail("legacy data should not be loaded")
    }
  });
  await assert.rejects(
    runCatalogInitialization({ environment, dependencies }),
    { code: "CATALOG_ALREADY_EXISTS" }
  );
  assert.equal(store.writes, 0);
});

test("storage unavailability stops instead of treating it as absence", async () => {
  const { store, dependencies } = createDependencies({
    dependencies: { readCatalog: async () => { throw unavailableCatalog(); } }
  });
  await assert.rejects(
    runCatalogInitialization({ environment, dependencies }),
    { code: "CATALOG_UNAVAILABLE" }
  );
  assert.equal(store.writes, 0);
});

test("corrupt catalog stops without initializing", async () => {
  const { store, dependencies } = createDependencies({
    dependencies: { readCatalog: async () => { throw corruptCatalog(); } }
  });
  await assert.rejects(
    runCatalogInitialization({ environment, dependencies }),
    { code: "CATALOG_CORRUPT" }
  );
  assert.equal(store.writes, 0);
});

test("invalid initial data is rejected before any write", async () => {
  const { store, dependencies } = createDependencies({
    dependencies: {
      loadLegacyData: async () => ({
        ...legacyData,
        serverProducts: legacyData.serverProducts.map((product) =>
          product.id === "550e8400-e29b-41d4-a716-446655440000"
            ? { ...product, prix: 1 }
            : product
        )
      })
    }
  });
  await assert.rejects(
    runCatalogInitialization({ environment, dependencies }),
    { code: "INITIAL_CATALOG_INVALID" }
  );
  assert.equal(store.writes, 0);
});

test("wrong environment stops before site verification or storage access", async () => {
  let verified = false;
  const { store, dependencies } = createDependencies({
    dependencies: {
      verifySite: async () => { verified = true; },
      readCatalog: async () => { throw missingCatalog(); }
    }
  });
  await assert.rejects(
    runCatalogInitialization({
      environment: { ...environment, CONTEXT: "deploy-preview" },
      dependencies
    }),
    { code: "WRONG_ENVIRONMENT" }
  );
  assert.equal(verified, false);
  assert.equal(store.writes, 0);
});

test("incorrect confirmation cancels without writing", async () => {
  const { store, dependencies } = createDependencies({
    dependencies: {
      readCatalog: async () => { throw missingCatalog(); },
      prompt: async () => "INITIALISER pgd-market-catalog "
    }
  });
  const result = await runCatalogInitialization({
    argv: ["--apply"],
    environment,
    dependencies
  });
  assert.equal(result.status, "cancelled");
  assert.equal(store.writes, 0);
});

test("confirmed initialization verifies the stored catalog and ETag", async () => {
  const store = makeMemoryStore();
  const { dependencies } = createDependencies({
    store,
    dependencies: {
      readCatalog: async () => {
        if (store.writes === 0) throw missingCatalog();
        return readCatalog({ store });
      },
      prompt: async () => "INITIALISER pgd-market-catalog"
    }
  });
  const result = await runCatalogInitialization({
    argv: ["--apply"],
    environment,
    dependencies
  });
  assert.equal(result.status, "initialized");
  assert.equal(result.etag, "memory-etag-1");
  assert.equal(result.catalog.products.length, 2);
  assert.equal(store.writes, 1);
});

test("uncertain write is reread once and never retried", async () => {
  const store = makeMemoryStore();
  let initializationCalls = 0;
  const { dependencies } = createDependencies({
    store,
    dependencies: {
      readCatalog: async () => {
        if (store.writes === 0) throw missingCatalog();
        return readCatalog({ store });
      },
      prompt: async () => "INITIALISER pgd-market-catalog",
      initializeCatalogFromLegacy: async (data) => {
        initializationCalls += 1;
        await initializeCatalogFromLegacy(data, { store });
        throw new CatalogStorageError(
          "CATALOG_WRITE_UNCONFIRMED",
          503,
          "Initialization could not be confirmed."
        );
      }
    }
  });

  await assert.rejects(
    runCatalogInitialization({ argv: ["--apply"], environment, dependencies }),
    { code: "WRITE_OUTCOME_UNCERTAIN" }
  );
  assert.equal(initializationCalls, 1);
  assert.equal(store.writes, 1);
});

test("post-write verification mismatch is reported without a corrective write", async () => {
  const store = makeMemoryStore();
  const { dependencies } = createDependencies({
    store,
    dependencies: {
      readCatalog: async () => {
        if (store.writes === 0) throw missingCatalog();
        const result = await readCatalog({ store });
        result.catalog.products[0].price += 1;
        return result;
      },
      prompt: async () => "INITIALISER pgd-market-catalog"
    }
  });
  await assert.rejects(
    runCatalogInitialization({ argv: ["--apply"], environment, dependencies }),
    { code: "INITIAL_CATALOG_MISMATCH" }
  );
  assert.equal(store.writes, 1);
});

test("site identity mismatch prevents any catalog read", async () => {
  let read = false;
  const { store, dependencies } = createDependencies({
    dependencies: {
      verifySite: async () => {
        throw new CatalogOperatorError("SITE_IDENTITY_MISMATCH", "wrong site");
      },
      readCatalog: async () => {
        read = true;
        throw missingCatalog();
      }
    }
  });
  await assert.rejects(
    runCatalogInitialization({ environment, dependencies }),
    { code: "SITE_IDENTITY_MISMATCH" }
  );
  assert.equal(read, false);
  assert.equal(store.writes, 0);
});

test("Netlify API identity is checked before catalog access", async () => {
  let requestedURL;
  const { dependencies } = createDependencies({
    dependencies: {
      verifySite: undefined,
      readCatalog: async () => { throw missingCatalog(); }
    }
  });
  const result = await runCatalogInitialization({
    environment,
    dependencies: {
      ...dependencies,
      fetch: async (url) => {
        requestedURL = String(url);
        return {
          ok: true,
          json: async () => ({
            id: "test-site-id",
            url: `https://${CATALOG_TARGET.siteHost}`
          })
        };
      }
    }
  });
  assert.equal(result.status, "simulation");
  assert.equal(
    requestedURL,
    "https://api.netlify.com/api/v1/sites/test-site-id"
  );
});

test("target metadata remains the expected production store and key", () => {
  assert.deepEqual(CATALOG_TARGET, {
    siteHost: "pgd-market.netlify.app",
    store: "pgd-market-catalog",
    key: "catalog-v1",
    schemaVersion: 2,
    environment: "production"
  });
});

test("one-off function refuses unauthenticated callers before catalog access", async () => {
  let catalogReads = 0;
  const fixture = createInitializationFixture({
    authorizeAdmin: async () => {
      throw Object.assign(new Error("not authenticated"), { status: 401 });
    }
  });
  const handler = createCatalogInitializationHandler({
    authorizeAdmin: async () => {
      throw Object.assign(new Error("not authenticated"), { status: 401 });
    },
    verifyOrigin: () => {},
    catalogReader: async () => {
      catalogReads += 1;
      throw missingCatalog();
    },
    environment: initializationEnvironment
  });
  const response = await handler(createInitializationRequest(), fixture.context);

  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), { result: "refused" });
  assert.equal(catalogReads, 0);
});

test("one-off function rejects non-production or mismatched site context", async (t) => {
  for (const [label, context] of [
    ["deploy context", { ...initializationContext, deploy: { context: "deploy-preview" } }],
    ["site ID", { ...initializationContext, site: { ...initializationContext.site, id: "wrong-site" } }],
    ["Blobs site ID", {
      ...initializationContext,
      site: initializationContext.site
    }]
  ]) {
    await t.test(label, async () => {
      let catalogReads = 0;
      const environment = label === "Blobs site ID"
        ? {
            ...initializationEnvironment,
            NETLIFY_BLOBS_CONTEXT: Buffer.from(JSON.stringify({
              siteID: "wrong-site",
              token: "test-only-token"
            })).toString("base64")
          }
        : initializationEnvironment;
      const fixture = createInitializationFixture({ environment });
      const handler = createCatalogInitializationHandler({
        authorizeAdmin: async () => ({ roles: ["admin"] }),
        verifyOrigin: () => {},
        catalogReader: async () => {
          catalogReads += 1;
          throw missingCatalog();
        },
        environment
      });
      const response = await handler(createInitializationRequest(), context);

      assert.equal(response.statusCode, 403);
      assert.deepEqual(JSON.parse(response.body), { result: "refused" });
      assert.equal(catalogReads, 0);
      assert.equal(fixture.store.writes, 0);
    });
  }
});

test("one-off function refuses to run without the authorization secret", async () => {
  const environment = { ...initializationEnvironment };
  delete environment.CATALOG_INITIALIZATION_SECRET;
  let catalogReads = 0;
  const handler = createCatalogInitializationHandler({
    authorizeAdmin: async () => ({ roles: ["admin"] }),
    verifyOrigin: () => {},
    catalogReader: async () => {
      catalogReads += 1;
      throw missingCatalog();
    },
    environment
  });
  const response = await handler(createInitializationRequest(), initializationContext);

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { result: "refused" });
  assert.equal(catalogReads, 0);
});

test("one-off function requires the server secret but does not require a client secret header", async () => {
  const fixture = createInitializationFixture();
  const request = createInitializationRequest();
  assert.equal(request.headers.has("x-catalog-initialization-secret"), false);
  const initialized = await fixture.handler(request, fixture.context);
  assert.equal(initialized.statusCode, 200);
  assert.deepEqual(JSON.parse(initialized.body), { result: "initialized" });

  const environment = { ...initializationEnvironment };
  delete environment.CATALOG_INITIALIZATION_SECRET;
  let catalogReads = 0;
  const unconfigured = createInitializationFixture({
    environment,
    catalogReader: async () => {
      catalogReads += 1;
      throw missingCatalog();
    }
  });
  const response = await unconfigured.handler(
    createInitializationRequest({
      headers: { "x-catalog-initialization-secret": "browser-supplied-value" }
    }),
    unconfigured.context
  );

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { result: "refused" });
  assert.equal(catalogReads, 0);
});

test("one-off function refuses authenticated non-admin users", async () => {
  let catalogReads = 0;
  const fixture = createInitializationFixture({
    authorizeAdmin: async () => {
      throw Object.assign(new Error("not an admin"), { status: 403 });
    },
    catalogReader: async () => {
      catalogReads += 1;
      throw missingCatalog();
    }
  });
  const response = await fixture.handler(createInitializationRequest(), fixture.context);

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), { result: "refused" });
  assert.equal(catalogReads, 0);
});

test("one-off function refuses requests from an unauthorized Origin", async () => {
  let catalogReads = 0;
  const fixture = createInitializationFixture({
    verifyOrigin: () => {
      throw Object.assign(new Error("origin refused"), { status: 403 });
    },
    catalogReader: async () => {
      catalogReads += 1;
      throw missingCatalog();
    }
  });
  const response = await fixture.handler(createInitializationRequest(), fixture.context);

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), { result: "refused" });
  assert.equal(catalogReads, 0);
});

test("one-off function initializes only from server-loaded legacy data", async () => {
  const fixture = createInitializationFixture();
  const response = await fixture.handler(createInitializationRequest({
    body: JSON.stringify({ products: [{ price: 1, chariowProductId: "browser-value" }] })
  }), fixture.context);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { result: "refused" });
  assert.equal(fixture.store.writes, 0);

  const initialized = await fixture.handler(createInitializationRequest(), fixture.context);
  assert.equal(initialized.statusCode, 200);
  assert.deepEqual(JSON.parse(initialized.body), { result: "initialized" });
  assert.equal(fixture.store.writes, 1);
  assert.equal((await readCatalog({ store: fixture.store })).catalog.products.length, 2);
});

test("one-off function refuses when the server-side legacy sources are unavailable", async () => {
  const fixture = createInitializationFixture({
    loadLegacyData: async () => undefined
  });
  const response = await fixture.handler(createInitializationRequest(), fixture.context);

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { result: "refused" });
  assert.equal(fixture.store.writes, 0);
});

test("one-off function refuses when server-side source loading fails", async () => {
  const fixture = createInitializationFixture({
    loadLegacyData: async () => { throw new Error("sources unavailable"); }
  });
  const response = await fixture.handler(createInitializationRequest(), fixture.context);

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { result: "refused" });
  assert.equal(fixture.store.writes, 0);
});

test("one-off function reports an existing catalog and never overwrites it", async () => {
  const store = makeMemoryStore();
  await initializeCatalogFromLegacy(legacyData, { store });
  const fixture = createInitializationFixture({ store });
  const response = await fixture.handler(createInitializationRequest(), fixture.context);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { result: "already_exists" });
  assert.equal(fixture.store.writes, 1);
});

test("concurrent initialization attempts are serialized by onlyIfNew", async () => {
  const store = makeMemoryStore();
  let readers = 0;
  let bothReadersStarted;
  const readersReady = new Promise((resolve) => {
    bothReadersStarted = resolve;
  });
  const catalogReader = async () => {
    readers += 1;
    if (readers === 2) bothReadersStarted();
    await readersReady;
    throw missingCatalog();
  };
  const fixture = createInitializationFixture({ store, catalogReader });
  const responses = await Promise.all([
    fixture.handler(createInitializationRequest(), fixture.context),
    fixture.handler(createInitializationRequest(), fixture.context)
  ]);
  const results = responses.map((item) => ({
    status: item.statusCode,
    body: JSON.parse(item.body)
  })).sort((a, b) => a.body.result.localeCompare(b.body.result));

  assert.deepEqual(results, [
    { status: 200, body: { result: "initialized" } },
    { status: 200, body: { result: "already_exists" } }
  ].sort((a, b) => a.body.result.localeCompare(b.body.result)));
  assert.equal(store.writes, 2);
  assert.equal(store.successfulWrites, 1);
});
