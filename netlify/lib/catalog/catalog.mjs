import { randomUUID } from "node:crypto";
import { verifyRequestOrigin } from "@netlify/identity";
import { AuthAccessError, requireAdmin } from "../../functions/_auth.mjs";
import {
  CatalogStorageError,
  readCatalog,
  writeCatalog
} from "./_catalog.mjs";
import { validateProduct } from "./_catalog-model.mjs";

const EXPECTED_SITE_ID = "2e63bd1a-3d35-4bcb-b572-4d8b22e70bbf";
const MAX_BODY_BYTES = 32 * 1024;
const PRODUCT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREATE_FIELDS = new Set([
  "id",
  "name",
  "description",
  "price",
  "currency",
  "image",
  "category",
  "chariowProductId",
  "available",
  "published"
]);
const EDITABLE_FIELDS = new Set([
  "id",
  "name",
  "description",
  "price",
  "currency",
  "image",
  "category",
  "chariowProductId",
  "available",
  "published"
]);
const REQUIRED_CREATE_FIELDS = [
  "name",
  "description",
  "price",
  "currency",
  "image",
  "chariowProductId",
  "available",
  "published"
];
const PRODUCT_FILTERS = new Set([
  "active",
  "unavailable",
  "published",
  "unpublished",
  "archived"
]);
const DELETE_CONFIRMATION_PREFIX = "DELETE PRODUCT ";
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff"
};

class CatalogApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "CatalogApiError";
    this.status = status;
    this.code = code;
  }
}

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const formatEtag = (etag) =>
  etag.startsWith('"') && etag.endsWith('"') ? etag : `"${etag}"`;

const isArchived = (product) =>
  product.archivedAt !== undefined && product.archivedAt !== null;

const filterProducts = (products, filter) => {
  if (filter && !PRODUCT_FILTERS.has(filter)) {
    throw new CatalogApiError(400, "INVALID_FILTER", "The product filter is invalid.");
  }
  if (filter === "archived") return products.filter(isArchived);

  const activeProducts = products.filter((product) => !isArchived(product));
  switch (filter) {
    case "active":
      return activeProducts.filter((product) => product.available);
    case "unavailable":
      return activeProducts.filter((product) => !product.available);
    case "published":
      return activeProducts.filter((product) => product.published);
    case "unpublished":
      return activeProducts.filter((product) => !product.published);
    default:
      return activeProducts;
  }
};

const assertKnownQuery = (url, allowed) => {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new CatalogApiError(400, "INVALID_QUERY", "The catalog query is invalid.");
    }
  }
};

const verifyProductionContext = (context) => {
  if (
    context?.deploy?.context !== "production" ||
    context?.site?.id !== EXPECTED_SITE_ID
  ) {
    throw new AuthAccessError(403, "PRODUCTION_CONTEXT_REQUIRED");
  }
};

const readJsonBody = async (request) => {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new CatalogApiError(415, "UNSUPPORTED_CONTENT_TYPE", "Send a JSON request.");
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new CatalogApiError(413, "REQUEST_TOO_LARGE", "The request is too large.");
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new CatalogApiError(400, "INVALID_REQUEST", "The request body is invalid.");
  }

  const chunks = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalLength += value.byteLength;
    if (totalLength > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new CatalogApiError(413, "REQUEST_TOO_LARGE", "The request is too large.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CatalogApiError(400, "INVALID_REQUEST", "The request body is invalid.");
  }
};

const validatePayload = (payload, allowedFields, requiredFields = []) => {
  if (
    !isRecord(payload) ||
    Object.keys(payload).length === 0 ||
    Object.keys(payload).some((field) => !allowedFields.has(field)) ||
    requiredFields.some((field) => !Object.hasOwn(payload, field))
  ) {
    throw new CatalogApiError(400, "INVALID_PRODUCT", "The product fields are invalid.");
  }
};

const getProductId = (request) => {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !PRODUCT_ID_PATTERN.test(id)) {
    throw new CatalogApiError(400, "INVALID_PRODUCT_ID", "A valid product ID is required.");
  }
  return id;
};

const getExpectedEtag = (request) => {
  const etag = request.headers.get("if-match");
  if (!etag) {
    throw new CatalogApiError(428, "ETAG_REQUIRED", "Reload the catalog before changing it.");
  }
  if (etag.startsWith("W/") || etag === "*" || !/^"[\x21\x23-\x7e]*"$/.test(etag)) {
    throw new CatalogApiError(400, "INVALID_ETAG", "The catalog ETag is invalid.");
  }
  return etag;
};

const assertCurrentEtag = (requestEtag, currentEtag) => {
  if (requestEtag !== formatEtag(currentEtag)) {
    throw new CatalogStorageError(
      "CATALOG_CONFLICT",
      412,
      "The catalog changed. Reload it before trying again."
    );
  }
};

const makeCatalogResponse = (catalog, products, etag, product) =>
  jsonResponse(200, {
    schemaVersion: catalog.schemaVersion,
    updatedAt: catalog.updatedAt,
    products,
    metadata: {
      schemaVersion: catalog.schemaVersion,
      updatedAt: catalog.updatedAt,
      totalProducts: catalog.products.length,
      returnedProducts: products.length
    },
    product: product ?? null
  }, { ETag: formatEtag(etag) });

const makeMutationResponse = (result, product, status = 200) =>
  jsonResponse(status, {
    schemaVersion: result.catalog.schemaVersion,
    updatedAt: result.catalog.updatedAt,
    products: result.catalog.products,
    metadata: {
      schemaVersion: result.catalog.schemaVersion,
      updatedAt: result.catalog.updatedAt,
      totalProducts: result.catalog.products.length,
      returnedProducts: result.catalog.products.length
    },
    product: product ?? null
  }, { ETag: formatEtag(result.etag) });

const createProduct = (input, timestamp, createId) => {
  validatePayload(input, CREATE_FIELDS, REQUIRED_CREATE_FIELDS);
  const id = input.id ?? createId();
  if (typeof id !== "string" || !PRODUCT_ID_PATTERN.test(id)) {
    throw new CatalogApiError(400, "INVALID_PRODUCT_ID", "A valid product ID is required.");
  }
  return validateProduct({
    ...input,
    id,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  });
};

const updateProduct = (input, current, timestamp) => {
  validatePayload(input, EDITABLE_FIELDS);
  if (input.id !== undefined && input.id !== current.id) {
    throw new CatalogApiError(400, "IMMUTABLE_PRODUCT_ID", "A product ID cannot be changed.");
  }
  if (
    input.chariowProductId !== undefined &&
    input.chariowProductId !== current.chariowProductId
  ) {
    throw new CatalogApiError(400, "CHARIOW_ID_IMMUTABLE", "The Chariow product ID cannot be changed.");
  }
  return validateProduct({
    ...current,
    ...input,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: timestamp,
    archivedAt: current.archivedAt ?? null
  });
};

const errorResponse = (error) => {
  if (error instanceof AuthAccessError) {
    const messages = {
      AUTHENTICATION_REQUIRED: "Administrator authentication is required.",
      ADMIN_ROLE_REQUIRED: "Administrator role is required.",
      AUTH_UNAVAILABLE: "Authentication service is unavailable.",
      PRODUCTION_CONTEXT_REQUIRED: "This operation is available only in the PGD Market production context."
    };
    return jsonResponse(error.status, {
      error: error.code,
      message: messages[error.code] || "The request could not be authorized."
    });
  }

  if (error instanceof CatalogApiError) {
    return jsonResponse(error.status, {
      error: error.code,
      message: error.message
    });
  }

  if (error instanceof CatalogStorageError) {
    const messages = {
      CATALOG_NOT_FOUND: "The catalog is not initialized.",
      CATALOG_CORRUPT: "The stored catalog is invalid.",
      CATALOG_UNAVAILABLE: "Catalog storage is unavailable.",
      CATALOG_WRITE_UNAVAILABLE: "Catalog storage is unavailable.",
      CATALOG_WRITE_UNCONFIRMED: "The catalog write could not be confirmed.",
      CATALOG_CONFLICT: "The catalog changed. Reload it before trying again.",
      CATALOG_ALREADY_EXISTS: "The catalog already exists.",
      PRODUCT_NOT_FOUND: "The product was not found.",
      PRODUCT_REMOVAL_REQUIRES_EXPLICIT_OPERATION: "Product removal must be explicit.",
      LAST_PRODUCT_CANNOT_BE_DELETED: "The last catalog product cannot be deleted."
    };
    return jsonResponse(error.status >= 500 ? 503 : error.status, {
      error: error.code,
      message: messages[error.code] || "The catalog operation could not be completed."
    });
  }

  if (error?.name === "CatalogModelError") {
    return jsonResponse(400, {
      error: error.code || "INVALID_PRODUCT",
      message: "The product data is invalid."
    });
  }

  if (error?.status === 403) {
    return jsonResponse(403, {
      error: "ORIGIN_FORBIDDEN",
      message: "This request origin is not allowed."
    });
  }

  return jsonResponse(503, {
    error: "CATALOG_UNAVAILABLE",
    message: "The catalog operation is unavailable."
  });
};

export function createCatalogHandler({
  identityApi,
  verifyOrigin = verifyRequestOrigin,
  catalogStorage = { readCatalog, writeCatalog },
  createId = randomUUID,
  now = () => new Date().toISOString()
} = {}) {
  const persistCatalog = (catalog, etag, deletedProductId) => {
    if (catalogStorage.writeCatalog) {
      return catalogStorage.writeCatalog(catalog, { etag });
    }
    if (deletedProductId && catalogStorage.deleteCatalogProduct) {
      return catalogStorage.deleteCatalogProduct(deletedProductId, {
        expectedEtag: etag
      });
    }
    return catalogStorage.saveCatalog(catalog, { expectedEtag: etag });
  };

  return async function catalogHandler(request, context) {
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      return jsonResponse(
        405,
        { error: "METHOD_NOT_ALLOWED", message: "This method is not allowed." },
        { Allow: "GET, POST, PUT, PATCH, DELETE" }
      );
    }

    try {
      if (request.method !== "GET") verifyOrigin(request);
      if (identityApi) await requireAdmin(identityApi);
      else await requireAdmin();
      verifyProductionContext(context);

      const url = new URL(request.url);
      if (request.method === "GET") {
        assertKnownQuery(url, new Set(["status"]));
        const status = url.searchParams.get("status") || undefined;
        if (status && !PRODUCT_FILTERS.has(status)) {
          throw new CatalogApiError(400, "INVALID_FILTER", "The product filter is invalid.");
        }
        const { catalog, etag } = await catalogStorage.readCatalog();
        return makeCatalogResponse(catalog, filterProducts(catalog.products, status), etag);
      }

      const expectedEtag = getExpectedEtag(request);
      const payload = await readJsonBody(request);
      const { catalog, etag } = await catalogStorage.readCatalog();
      assertCurrentEtag(expectedEtag, etag);

      if (request.method === "POST") {
        const product = createProduct(payload, now(), createId);
        if (catalog.products.some((existing) => existing.id === product.id)) {
          throw new CatalogApiError(409, "PRODUCT_ID_CONFLICT", "A product with this ID already exists.");
        }
        const nextCatalog = {
          ...catalog,
          updatedAt: now(),
          products: [...catalog.products, product]
        };
        const result = await persistCatalog(nextCatalog, etag);
        return makeMutationResponse(result, product, 201);
      }

      const productId = getProductId(request);
      const productIndex = catalog.products.findIndex(({ id }) => id === productId);
      if (productIndex === -1) {
        throw new CatalogStorageError("PRODUCT_NOT_FOUND", 404, "Product does not exist.");
      }
      const currentProduct = catalog.products[productIndex];
      const timestamp = now();
      let updatedProduct;
      let products;

      if (request.method === "PUT") {
        validatePayload(payload, EDITABLE_FIELDS);
        if (isArchived(currentProduct)) {
          throw new CatalogApiError(409, "PRODUCT_ARCHIVED", "Restore the product before editing it.");
        }
        updatedProduct = updateProduct(payload, currentProduct, timestamp);
        products = [...catalog.products];
        products[productIndex] = updatedProduct;
      } else if (request.method === "PATCH") {
        if (
          !isRecord(payload) ||
          Object.keys(payload).length !== 1 ||
          !["archive", "restore"].includes(payload.action)
        ) {
          throw new CatalogApiError(400, "INVALID_ACTION", "Choose archive or restore.");
        }
        const archived = isArchived(currentProduct);
        if (
          (payload.action === "archive" && archived) ||
          (payload.action === "restore" && !archived)
        ) {
          throw new CatalogApiError(409, "INVALID_ARCHIVE_STATE", "The product is already in the requested state.");
        }
        updatedProduct = validateProduct({
          ...currentProduct,
          archivedAt: payload.action === "archive" ? timestamp : null,
          updatedAt: timestamp
        });
        products = [...catalog.products];
        products[productIndex] = updatedProduct;
      } else {
        if (
          !isRecord(payload) ||
          Object.keys(payload).length !== 1 ||
          payload.confirmation !== `${DELETE_CONFIRMATION_PREFIX}${productId}`
        ) {
          throw new CatalogApiError(400, "CONFIRMATION_REQUIRED", "Confirm the product ID to delete it.");
        }
        if (catalog.products.length <= 1) {
          throw new CatalogStorageError(
            "LAST_PRODUCT_CANNOT_BE_DELETED",
            409,
            "The last catalog product cannot be deleted."
          );
        }
        products = catalog.products.filter(({ id }) => id !== productId);
      }

      const nextCatalog = { ...catalog, updatedAt: timestamp, products };
      const result = await persistCatalog(
        nextCatalog,
        etag,
        request.method === "DELETE" ? productId : undefined
      );
      return makeMutationResponse(result, updatedProduct);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
