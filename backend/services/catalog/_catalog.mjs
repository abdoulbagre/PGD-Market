import { getStore } from "@netlify/blobs";
import { buildLegacyCatalog, validateCatalog } from "./_catalog-model.mjs";

export const CATALOG_STORE_NAME = "pgd-market-catalog";
export const CATALOG_KEY = "catalog-v1";
export const CATALOG_SCHEMA_VERSION = 2;
const SCHEMA_VERSION = CATALOG_SCHEMA_VERSION;

export class CatalogStorageError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "CatalogStorageError";
    this.code = code;
    this.status = status;
  }
}

const jsonRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const CATALOG_SEED_PRODUCT_FIELDS = [
  "id",
  "name",
  "description",
  "price",
  "currency",
  "image",
  "category",
  "chariowProductId",
  "available",
  "published",
  "archivedAt"
];

const getCatalogStore = () =>
  getStore({ name: CATALOG_STORE_NAME, consistency: "strong" });

const metadataFor = (catalog) => ({
  schemaVersion: catalog.schemaVersion,
  updatedAt: catalog.updatedAt
});

export function validateStoredCatalog(catalog) {
  if (
    !jsonRecord(catalog) ||
    Object.keys(catalog).some((key) => !["schemaVersion", "updatedAt", "products"].includes(key)) ||
    catalog.schemaVersion !== SCHEMA_VERSION ||
    typeof catalog.updatedAt !== "string" ||
    Number.isNaN(Date.parse(catalog.updatedAt)) ||
    new Date(catalog.updatedAt).toISOString() !== catalog.updatedAt ||
    !Array.isArray(catalog.products) ||
    catalog.products.length === 0
  ) {
    throw new CatalogStorageError("CATALOG_INVALID", 400, "Catalog structure is invalid.");
  }

  try {
    validateCatalog(catalog.products);
  } catch (error) {
    throw new CatalogStorageError(
      "CATALOG_INVALID",
      400,
      `Catalog products failed validation: ${error.code || "INVALID_PRODUCT"}.`
    );
  }

  return catalog;
}

export function prepareInitialCatalogFromLegacy({
  publicProducts,
  serverProducts,
  referenceCurrency,
  now = new Date().toISOString()
}) {
  const products = buildLegacyCatalog({
    publicProducts,
    serverProducts,
    referenceCurrency
  }).map((product) => ({
    ...product,
    createdAt: now,
    updatedAt: now
  }));

  return validateStoredCatalog({
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now,
    products
  });
}

export function prepareInitialCatalogFromSeed(seed, { now = new Date().toISOString() } = {}) {
  if (
    !jsonRecord(seed) ||
    Object.keys(seed).some((key) => key !== "products") ||
    !Array.isArray(seed.products) ||
    seed.products.length === 0
  ) {
    throw new CatalogStorageError("CATALOG_INVALID", 400, "Catalog seed is invalid.");
  }

  const products = seed.products.map((product) => {
    if (
      !jsonRecord(product) ||
      Object.keys(product).some((key) => !CATALOG_SEED_PRODUCT_FIELDS.includes(key)) ||
      CATALOG_SEED_PRODUCT_FIELDS.some((key) => !Object.hasOwn(product, key))
    ) {
      throw new CatalogStorageError("CATALOG_INVALID", 400, "Catalog seed product is invalid.");
    }

    return {
      ...product,
      createdAt: now,
      updatedAt: now
    };
  });

  return validateStoredCatalog({
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now,
    products
  });
}

export async function readCatalog({ store } = {}) {
  let entry;
  try {
    entry = await (store ?? getCatalogStore()).getWithMetadata(CATALOG_KEY, {
      consistency: "strong",
      type: "text"
    });
  } catch {
    throw new CatalogStorageError(
      "CATALOG_UNAVAILABLE",
      503,
      "Catalog storage is unavailable."
    );
  }

  if (entry === null) {
    throw new CatalogStorageError(
      "CATALOG_NOT_FOUND",
      404,
      "Catalog has not been initialized."
    );
  }

  let catalog;
  try {
    catalog = JSON.parse(entry.data);
  } catch {
    throw new CatalogStorageError(
      "CATALOG_CORRUPT",
      500,
      "Stored catalog is not valid JSON."
    );
  }

  try {
    validateStoredCatalog(catalog);
  } catch {
    throw new CatalogStorageError(
      "CATALOG_CORRUPT",
      500,
      "Stored catalog does not match the supported schema."
    );
  }

  if (
    entry.metadata?.schemaVersion !== undefined &&
    entry.metadata.schemaVersion !== catalog.schemaVersion
  ) {
    throw new CatalogStorageError(
      "CATALOG_CORRUPT",
      500,
      "Stored catalog metadata does not match the catalog."
    );
  }

  if (typeof entry.etag !== "string" || entry.etag.length === 0) {
    throw new CatalogStorageError(
      "CATALOG_CORRUPT",
      500,
      "Stored catalog has no version identifier."
    );
  }

  return { catalog, etag: entry.etag };
}

export async function initializeCatalog(catalog, { store } = {}) {
  const preparedCatalog = validateStoredCatalog(catalog);
  let result;

  try {
    result = await (store ?? getCatalogStore()).setJSON(
      CATALOG_KEY,
      preparedCatalog,
      {
        onlyIfNew: true,
        metadata: metadataFor(preparedCatalog)
      }
    );
  } catch {
    throw new CatalogStorageError(
      "CATALOG_WRITE_UNAVAILABLE",
      503,
      "Catalog storage is unavailable."
    );
  }

  if (!result.modified) {
    throw new CatalogStorageError(
      "CATALOG_ALREADY_EXISTS",
      409,
      "Catalog already exists; initialization did not change it."
    );
  }
  if (typeof result.etag !== "string" || result.etag.length === 0) {
    throw new CatalogStorageError(
      "CATALOG_WRITE_UNCONFIRMED",
      503,
      "Catalog initialization could not be confirmed."
    );
  }

  return { catalog: preparedCatalog, etag: result.etag };
}

export async function initializeCatalogFromLegacy(legacyData, options = {}) {
  const catalog = prepareInitialCatalogFromLegacy(legacyData);
  return initializeCatalog(catalog, options);
}

const requireEtag = (etag) => {
  if (typeof etag !== "string" || etag.length === 0) {
    throw new CatalogStorageError(
      "ETAG_REQUIRED",
      428,
      "The current catalog ETag is required."
    );
  }
};

export async function writeCatalog(catalog, { etag, store } = {}) {
  requireEtag(etag);
  const preparedCatalog = validateStoredCatalog(catalog);
  let result;
  try {
    result = await (store ?? getCatalogStore()).setJSON(
      CATALOG_KEY,
      preparedCatalog,
      {
        onlyIfMatch: etag,
        metadata: metadataFor(preparedCatalog)
      }
    );
  } catch {
    throw new CatalogStorageError(
      "CATALOG_WRITE_UNAVAILABLE",
      503,
      "Catalog storage is unavailable."
    );
  }

  if (!result.modified) {
    throw new CatalogStorageError(
      "CATALOG_CONFLICT",
      412,
      "Catalog changed since it was read."
    );
  }
  if (typeof result.etag !== "string" || result.etag.length === 0) {
    throw new CatalogStorageError(
      "CATALOG_WRITE_UNCONFIRMED",
      503,
      "Catalog write could not be confirmed."
    );
  }

  return { catalog: preparedCatalog, etag: result.etag };
}

export async function saveCatalog(catalog, { expectedEtag, store } = {}) {
  requireEtag(expectedEtag);
  const current = await readCatalog({ store });
  if (current.etag !== expectedEtag) {
    throw new CatalogStorageError(
      "CATALOG_CONFLICT",
      412,
      "Catalog changed since it was read."
    );
  }

  const preparedCatalog = validateStoredCatalog(catalog);
  const currentIds = new Set(current.catalog.products.map(({ id }) => id));
  const nextIds = new Set(preparedCatalog.products.map(({ id }) => id));
  if ([...currentIds].some((id) => !nextIds.has(id))) {
    throw new CatalogStorageError(
      "PRODUCT_REMOVAL_REQUIRES_EXPLICIT_OPERATION",
      409,
      "Catalog updates cannot silently remove existing products."
    );
  }

  const timestamp = new Date().toISOString();
  const currentProducts = new Map(current.catalog.products.map((product) => [product.id, product]));
  const products = preparedCatalog.products.map((product) => {
    const previous = currentProducts.get(product.id);
    if (!previous) return product;

    const contentChanged = Object.keys(product)
      .filter((key) => key !== "createdAt" && key !== "updatedAt")
      .some((key) => JSON.stringify(product[key]) !== JSON.stringify(previous[key]));

    return {
      ...product,
      createdAt: previous.createdAt,
      updatedAt: contentChanged ? timestamp : previous.updatedAt
    };
  });
  const nextCatalog = validateStoredCatalog({
    ...preparedCatalog,
    updatedAt: timestamp,
    products
  });

  return writeCatalog(nextCatalog, { etag: expectedEtag, store });
}

export async function deleteCatalogProduct(productId, { expectedEtag, store } = {}) {
  requireEtag(expectedEtag);

  const current = await readCatalog({ store });
  if (current.etag !== expectedEtag) {
    throw new CatalogStorageError(
      "CATALOG_CONFLICT",
      412,
      "Catalog changed since it was read."
    );
  }

  const deletedProduct = current.catalog.products.find(({ id }) => id === productId);
  if (!deletedProduct) {
    throw new CatalogStorageError("PRODUCT_NOT_FOUND", 404, "Product does not exist.");
  }
  if (current.catalog.products.length === 1) {
    throw new CatalogStorageError(
      "LAST_PRODUCT_CANNOT_BE_DELETED",
      409,
      "The last catalog product cannot be deleted."
    );
  }

  const timestamp = new Date().toISOString();
  const nextCatalog = validateStoredCatalog({
    ...current.catalog,
    updatedAt: timestamp,
    products: current.catalog.products.filter(({ id }) => id !== productId)
  });

  const result = await writeCatalog(nextCatalog, { etag: expectedEtag, store });
  return { ...result, deletedProduct };
}
