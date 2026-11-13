import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import catalogSeed from "../backend/data/catalog-seed.json" with { type: "json" };
import {
  assertImmutableProductId,
  buildLegacyCatalog,
  getPublicProducts,
  hasValidChariowProductId,
  isPubliclyVisible,
  isPurchasable,
  validateCatalog,
  validateProduct
} from "../backend/functions/_catalog-model.mjs";
import {
  initializeCatalog,
  initializeCatalogFromLegacy,
  prepareInitialCatalogFromSeed,
  prepareInitialCatalogFromLegacy,
  readCatalog,
  saveCatalog
} from "../backend/functions/_catalog.mjs";

const require = createRequire(import.meta.url);
const serverProducts = require("../backend/functions/_products.js").products;
const publicSource = await readFile(
  new URL("../frontend/storefront/assets/js/products.js", import.meta.url),
  "utf8"
);
const publicModule = await import(
  `data:text/javascript;base64,${Buffer.from(publicSource).toString("base64")}`
);
const products = buildLegacyCatalog({
  publicProducts: publicModule.products,
  serverProducts,
  referenceCurrency: "XOF"
});

const makeMemoryStore = ({ beforeSet } = {}) => {
  let record = null;
  let version = 0;
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
      if (beforeSet) await beforeSet({ record, options });
      if (options.onlyIfNew && record) return { modified: false };
      if (options.onlyIfMatch && options.onlyIfMatch !== record?.etag) {
        return { modified: false };
      }

      version += 1;
      record = {
        value: JSON.parse(JSON.stringify(value)),
        metadata: options.metadata,
        etag: `version-${version}`
      };
      return { modified: true, etag: record.etag };
    },
    setRecord(value, etag = "external-version") {
      record = { value, etag, metadata: { schemaVersion: value.schemaVersion } };
    }
  };
};

const initialCatalog = () => ({
  schemaVersion: 2,
  updatedAt: "2026-01-02T00:00:00.000Z",
  products: products.map((product) => ({
    ...product,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }))
});

test("keeps exactly the two eligible catalog IDs and reference prices", () => {
  assert.equal(products.length, 2);
  assert.deepEqual(
    products.map(({ id }) => id),
    [
      "550e8400-e29b-41d4-a716-446655440000",
      "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90"
    ]
  );
  assert.deepEqual(
    products.map(({ price }) => price),
    [4200, 3000]
  );
  assert.equal(new Set(products.map(({ id }) => id)).size, 2);
});

test("removes the three ineligible products from the public source and canonical data", () => {
  const removedIds = [
    "3b12f1df-5232-4e7a-9f2d-8c1a6b5e4d30",
    "a8d7c6b5-4e3f-42a1-b9c8-7d6e5f4a3b21",
    "91e2d3c4-5f6a-4789-ab01-23456789cdef"
  ];
  const catalogIds = new Set(products.map(({ id }) => id));
  const publicSourceIds = new Set(publicModule.products.map(({ id }) => id));

  for (const id of removedIds) {
    assert.equal(catalogIds.has(id), false);
    assert.equal(publicSourceIds.has(id), false);
  }
  assert.equal(publicModule.products.length, 2);
});

test("preserves French product text and Chariow IDs", () => {
  assert.deepEqual(
    products.filter(({ chariowProductId }) => chariowProductId)
      .map(({ id, chariowProductId }) => [id, chariowProductId]),
    serverProducts.map(({ id, chariowProductId }) => [id, chariowProductId])
  );
  for (const legacyProduct of publicModule.products) {
    const product = products.find(({ id }) => id === legacyProduct.id);
    assert.equal(product.name, legacyProduct.nom);
    assert.equal(product.description, legacyProduct.description);
  }
});

test("keeps image, French description, and category data for public display", () => {
  for (const legacyProduct of publicModule.products) {
    const product = products.find(({ id }) => id === legacyProduct.id);
    assert.equal(product.image, legacyProduct.image);
    assert.equal(product.category, legacyProduct.categorie);
    assert.equal(product.description, legacyProduct.description);
  }
  assert.deepEqual(products.map(({ image }) => image), [
    "assets/images/1.jpg",
    "assets/images/2.jpg"
  ]);
  assert.deepEqual(products.map(({ category }) => category), ["", ""]);
});

test("backend seed preserves the two existing products and contains no delivery data", () => {
  assert.equal(catalogSeed.products.length, 2);
  const seededCatalog = prepareInitialCatalogFromSeed(catalogSeed, {
    now: "2026-01-02T00:00:00.000Z"
  });
  assert.deepEqual(
    seededCatalog.products.map(({ id, price, currency, chariowProductId }) =>
      [id, price, currency, chariowProductId]
    ),
    products.map(({ id, price, currency, chariowProductId }) =>
      [id, price, currency, chariowProductId]
    )
  );
  assert.deepEqual(
    seededCatalog.products.map(({ name, description, image, category, available, published, archivedAt }) =>
      [name, description, image, category, available, published, archivedAt]
    ),
    products.map(({ name, description, image, category, available, published, archivedAt }) =>
      [name, description, image, category, available, published, archivedAt]
    )
  );
  assert.ok(catalogSeed.products.every((product) =>
    !("file" in product) &&
    !("files" in product) &&
    !("fichier" in product) &&
    !("fichiers" in product)
  ));
});

test("excludes all locally managed digital delivery references", () => {
  const serializedCatalog = JSON.stringify(products);
  for (const legacyProduct of publicModule.products) {
    const references = Array.isArray(legacyProduct.fichier)
      ? legacyProduct.fichier
      : [legacyProduct.fichier];
    for (const reference of references.filter(Boolean)) {
      assert.equal(serializedCatalog.includes(reference), false);
    }
  }
  for (const serverProduct of serverProducts) {
    for (const reference of serverProduct.fichiers) {
      assert.equal(serializedCatalog.includes(reference), false);
    }
  }
  assert.ok(products.every((product) => !("file" in product) && !("files" in product)));
});

test("keeps the two eligible products published, available, visible, and purchasable", () => {
  assert.deepEqual(products.map(({ published }) => published), [true, true]);
  assert.deepEqual(products.map(({ available }) => available), [true, true]);
  assert.deepEqual(products.map(isPurchasable), [true, true]);
  assert.deepEqual(products.map(isPubliclyVisible), [true, true]);
  assert.deepEqual(getPublicProducts(products, { allowUnknownDates: true }), products);
  assert.equal(products.length, 2);
});

test("public visibility requires publication, availability, and a valid Chariow ID", () => {
  const validProduct = products[0];
  assert.equal(hasValidChariowProductId(validProduct), true);
  assert.equal(isPubliclyVisible(validProduct), true);
  assert.equal(isPurchasable(validProduct), true);

  for (const unavailableProduct of [
    { ...validProduct, published: false },
    { ...validProduct, available: false },
    { ...validProduct, chariowProductId: null },
    { ...validProduct, chariowProductId: "invalid-id" }
  ]) {
    assert.equal(isPubliclyVisible(unavailableProduct), false);
    assert.equal(isPurchasable(unavailableProduct), false);
  }

  assert.equal(hasValidChariowProductId({ chariowProductId: "prd_valid_123" }), true);
  assert.equal(hasValidChariowProductId({ chariowProductId: "prd_ " }), false);
});

test("archived products are valid but never publicly visible", () => {
  const archived = {
    ...products[0],
    archivedAt: "2026-01-02T00:00:00.000Z"
  };
  assert.equal(validateProduct(archived, { allowUnknownDates: true }), archived);
  assert.equal(isPubliclyVisible(archived), false);
  assert.equal(isPurchasable(archived), false);
  assert.throws(
    () => validateProduct({ ...products[0], archivedAt: "not-a-date" }),
    { code: "INVALID_ARCHIVE_DATE" }
  );
  const active = { ...products[0], archivedAt: null };
  assert.equal(validateProduct(active, { allowUnknownDates: true }), active);
});

test("uses explicit XOF reference currency and marks unknown historical dates as null", () => {
  assert.deepEqual(products.map(({ currency }) => currency), ["XOF", "XOF"]);
  assert.ok(products.every(({ createdAt, updatedAt }) => createdAt === null && updatedAt === null));
  assert.throws(() => validateProduct(products[0]), { code: "INVALID_PRODUCT_DATES" });
});

test("rejects duplicate IDs, invalid prices, currencies, paths, translations, and states", () => {
  assert.throws(
    () => validateCatalog([products[0], products[0]], { allowUnknownDates: true }),
    { code: "DUPLICATE_PRODUCT_ID" }
  );
  assert.throws(() => validateProduct({ ...products[0], id: "legacy-id" }), { code: "INVALID_PRODUCT_ID" });
  assert.throws(() => validateProduct({ ...products[0], price: 0 }), { code: "INVALID_PRICE" });
  assert.throws(() => validateProduct({ ...products[0], currency: "GBP" }), { code: "INVALID_CURRENCY" });
  assert.throws(() => validateProduct({ ...products[0], image: "assets/../secret.jpg" }), { code: "INVALID_IMAGE" });
  assert.throws(() => validateProduct({ ...products[0], chariowProductId: "bad id" }), { code: "INVALID_CHARIOW_ID" });
  assert.throws(() => validateProduct({ ...products[0], chariowProductId: "wrong-prefix" }), { code: "INVALID_CHARIOW_ID" });
  assert.throws(
    () => validateProduct({ ...products[0], name: "" }),
    { code: "INVALID_TRANSLATION" }
  );
  assert.throws(
    () => validateProduct({ ...products[0], available: true, published: false }),
    { code: "INVALID_PRODUCT_STATE" }
  );
  assert.throws(
    () => validateProduct({ ...products[0], available: true, chariowProductId: null }),
    { code: "INVALID_PRODUCT_STATE" }
  );
  assert.throws(
    () => validateProduct({ ...products[0], createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
    { code: "INVALID_PRODUCT_DATES" }
  );
});

test("accepts existing bilingual catalog records and retains their French values", () => {
  const legacyProduct = {
    ...products[0],
    name: { fr: "Nom français conservé", en: "Legacy English name" },
    description: {
      fr: "Description française conservée",
      en: "Legacy English description"
    }
  };
  assert.equal(validateProduct(legacyProduct, { allowUnknownDates: true }), legacyProduct);
  assert.equal(legacyProduct.name.fr, "Nom français conservé");
  assert.equal(legacyProduct.description.fr, "Description française conservée");
});

test("rejects a conflicting legacy price rather than silently changing it", () => {
  const conflictingServerProducts = serverProducts.map((product, index) =>
    index === 0 ? { ...product, prix: product.prix + 1 } : product
  );
  assert.throws(
    () => buildLegacyCatalog({
      publicProducts: publicModule.products,
      serverProducts: conflictingServerProducts,
      referenceCurrency: "XOF"
    }),
    { code: "LEGACY_PRICE_CONFLICT" }
  );
});

test("refuses to drop a product found only in the server catalog", () => {
  const serverOnlyProduct = {
    ...serverProducts[0],
    id: "a1b2c3d4-e5f6-4789-ab01-234567890123"
  };
  assert.throws(
    () => buildLegacyCatalog({
      publicProducts: publicModule.products,
      serverProducts: [...serverProducts, serverOnlyProduct],
      referenceCurrency: "XOF"
    }),
    { code: "SERVER_ONLY_PRODUCT" }
  );
});

test("rejects attempts to change an existing product ID", () => {
  assert.throws(
    () => assertImmutableProductId(products[0].id, products[1].id),
    { code: "IMMUTABLE_PRODUCT_ID" }
  );
  assert.equal(assertImmutableProductId(products[0].id, products[0].id), undefined);
});

test("prepares a dated initial catalog from the two legacy products", () => {
  const catalog = prepareInitialCatalogFromLegacy({
    publicProducts: publicModule.products,
    serverProducts,
    referenceCurrency: "XOF",
    now: "2026-01-02T00:00:00.000Z"
  });

  assert.equal(catalog.schemaVersion, 2);
  assert.deepEqual(catalog.products.map(({ id }) => id), products.map(({ id }) => id));
  assert.ok(catalog.products.every(
    ({ createdAt, updatedAt }) =>
      createdAt === "2026-01-02T00:00:00.000Z" &&
      updatedAt === "2026-01-02T00:00:00.000Z"
  ));
});

test("initializes a missing catalog and refuses to overwrite an existing one", async () => {
  const store = makeMemoryStore();
  const catalog = initialCatalog();
  const initialized = await initializeCatalog(catalog, { store });
  assert.deepEqual(initialized, { catalog, etag: "version-1" });
  assert.deepEqual(await readCatalog({ store }), initialized);

  await assert.rejects(
    initializeCatalog(initialCatalog(), { store }),
    { code: "CATALOG_ALREADY_EXISTS", status: 409 }
  );
  assert.deepEqual(await readCatalog({ store }), initialized);
});

test("initializes from legacy sources only when explicitly called", async () => {
  const store = makeMemoryStore();
  const result = await initializeCatalogFromLegacy({
    publicProducts: publicModule.products,
    serverProducts,
    referenceCurrency: "XOF",
    now: "2026-01-02T00:00:00.000Z"
  }, { store });

  assert.equal(result.catalog.products.length, 2);
  assert.deepEqual(
    result.catalog.products.map(({ chariowProductId }) => chariowProductId),
    serverProducts.map(({ chariowProductId }) => chariowProductId)
  );
});

test("updates a catalog conditionally while preserving product IDs and creation dates", async () => {
  const store = makeMemoryStore();
  await initializeCatalog(initialCatalog(), { store });
  const current = await readCatalog({ store });
  const changedCatalog = {
    ...current.catalog,
    products: current.catalog.products.map((product, index) =>
      index === 0 ? { ...product, price: product.price + 100 } : product
    )
  };
  const saved = await saveCatalog(changedCatalog, {
    expectedEtag: current.etag,
    store
  });

  assert.deepEqual(
    saved.catalog.products.map(({ id }) => id),
    products.map(({ id }) => id)
  );
  assert.equal(saved.catalog.products[0].createdAt, "2026-01-01T00:00:00.000Z");
  assert.notEqual(saved.catalog.products[0].updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(saved.catalog.products[0].price, products[0].price + 100);
});

test("rejects missing or stale ETags and concurrent writes", async () => {
  const store = makeMemoryStore();
  await initializeCatalog(initialCatalog(), { store });
  const current = await readCatalog({ store });

  await assert.rejects(
    saveCatalog(current.catalog, { store }),
    { code: "ETAG_REQUIRED", status: 428 }
  );
  await assert.rejects(
    saveCatalog(current.catalog, { expectedEtag: "stale-version", store }),
    { code: "CATALOG_CONFLICT", status: 412 }
  );

  const racingStore = makeMemoryStore({
    beforeSet: async ({ record, options }) => {
      if (options.onlyIfMatch && record?.etag === options.onlyIfMatch) {
        record.etag = "concurrent-version";
      }
    }
  });
  await initializeCatalog(initialCatalog(), { store: racingStore });
  const raceSnapshot = await readCatalog({ store: racingStore });
  await assert.rejects(
    saveCatalog(raceSnapshot.catalog, {
      expectedEtag: raceSnapshot.etag,
      store: racingStore
    }),
      { code: "CATALOG_CONFLICT", status: 412 }
  );
});

test("refuses invalid catalog data and accidental product removal", async () => {
  const store = makeMemoryStore();
  await initializeCatalog(initialCatalog(), { store });
  const current = await readCatalog({ store });

  await assert.rejects(
    initializeCatalog({ ...initialCatalog(), products: [] }, { store: makeMemoryStore() }),
    { code: "CATALOG_INVALID", status: 400 }
  );
  await assert.rejects(
    saveCatalog({
      ...current.catalog,
      products: current.catalog.products.slice(1)
    }, { expectedEtag: current.etag, store }),
    { code: "PRODUCT_REMOVAL_REQUIRES_EXPLICIT_OPERATION", status: 409 }
  );
  await assert.rejects(
    saveCatalog({
      ...current.catalog,
      products: current.catalog.products.map((product) => ({ ...product, price: 0 }))
    }, { expectedEtag: current.etag, store }),
    { code: "CATALOG_INVALID", status: 400 }
  );
});

test("distinguishes missing, unavailable, and corrupt storage", async () => {
  const missingStore = makeMemoryStore();
  await assert.rejects(
    readCatalog({ store: missingStore }),
    { code: "CATALOG_NOT_FOUND", status: 404 }
  );
  await assert.rejects(
    readCatalog({
      store: { getWithMetadata: async () => { throw new Error("storage failure"); } }
    }),
    { code: "CATALOG_UNAVAILABLE", status: 503 }
  );

  const corruptStore = makeMemoryStore();
  corruptStore.setRecord({ invalid: true }, "bad-version");
  await assert.rejects(
    readCatalog({ store: corruptStore }),
    { code: "CATALOG_CORRUPT", status: 500 }
  );

  const invalidJsonStore = {
    getWithMetadata: async () => ({
      data: "{",
      metadata: {},
      etag: "bad-json-version"
    })
  };
  await assert.rejects(
    readCatalog({ store: invalidJsonStore }),
    { code: "CATALOG_CORRUPT", status: 500 }
  );

});

test("reports storage write errors without disguising them as successful writes", async () => {
  const unavailableStore = {
    setJSON: async () => { throw new Error("storage failure"); }
  };
  await assert.rejects(
    initializeCatalog(initialCatalog(), { store: unavailableStore }),
    { code: "CATALOG_WRITE_UNAVAILABLE", status: 503 }
  );

  const store = makeMemoryStore();
  await initializeCatalog(initialCatalog(), { store });
  const current = await readCatalog({ store });
  await assert.rejects(
    saveCatalog(current.catalog, {
      expectedEtag: current.etag,
      store: { ...store, setJSON: async () => { throw new Error("storage failure"); } }
    }),
    { code: "CATALOG_WRITE_UNAVAILABLE", status: 503 }
  );
});
