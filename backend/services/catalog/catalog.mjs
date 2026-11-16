import { verifyRequestOrigin } from "@netlify/identity";
import { AuthAccessError, requireAdmin } from "../../functions/_auth.mjs";
import { fetchChariowProducts } from "../chariow/products.mjs";
import { projectAdminProduct } from "../chariow/public-products.mjs";
import {
  CatalogStorageError,
  readRatings,
  writeRating
} from "./_catalog.mjs";
import { validateChariowProductId, validateRating } from "./_ratings-model.mjs";

const EXPECTED_SITE_ID = "2e63bd1a-3d35-4bcb-b572-4d8b22e70bbf";
const MAX_BODY_BYTES = 1024;
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

const formatEtag = (etag) =>
  etag.startsWith('"') && etag.endsWith('"') ? etag : `"${etag}"`;

const verifyTargetSiteContext = (context) => {
  if (context?.site?.id !== EXPECTED_SITE_ID) {
    throw new AuthAccessError(403, "PGD_SITE_REQUIRED");
  }
};

const verifyProductionContext = (context) => {
  if (context?.deploy?.context !== "production") {
    throw new AuthAccessError(403, "PRODUCTION_CONTEXT_REQUIRED");
  }
  verifyTargetSiteContext(context);
};

const getExpectedEtag = (request) => {
  const etag = request.headers.get("if-match");
  if (!etag) {
    throw new CatalogApiError(428, "ETAG_REQUIRED", "Reload ratings before changing them.");
  }
  if (etag.startsWith("W/") || etag === "*" || !/^"[\x21\x23-\x7e]*"$/.test(etag)) {
    throw new CatalogApiError(400, "INVALID_ETAG", "The ratings ETag is invalid.");
  }
  return etag.slice(1, -1);
};

const readJsonBody = async (request) => {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new CatalogApiError(415, "UNSUPPORTED_CONTENT_TYPE", "Send a JSON request.");
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new CatalogApiError(413, "REQUEST_TOO_LARGE", "The request is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new CatalogApiError(413, "REQUEST_TOO_LARGE", "The request is too large.");
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CatalogApiError(400, "INVALID_REQUEST", "The request body is invalid.");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    !Object.hasOwn(payload, "rating")
  ) {
    throw new CatalogApiError(400, "INVALID_RATING", "Only a PGD rating can be changed.");
  }
  try {
    validateRating(payload.rating);
  } catch (error) {
    throw new CatalogApiError(400, error.code, error.message);
  }
  return payload;
};

const responseForCatalog = (
  ratings,
  products,
  status = 200,
  product = null,
  canEditRatings = false
) =>
  jsonResponse(status, {
    schemaVersion: ratings.schemaVersion,
    updatedAt: ratings.updatedAt,
    products,
    metadata: {
      schemaVersion: ratings.schemaVersion,
      updatedAt: ratings.updatedAt,
      totalProducts: products.length,
      returnedProducts: products.length,
      canEditRatings
    },
    product
  }, ratings.etag ? { ETag: formatEtag(ratings.etag) } : {});

const errorResponse = (error) => {
  if (error instanceof AuthAccessError) {
    const messages = {
      AUTHENTICATION_REQUIRED: "Administrator authentication is required.",
      ADMIN_ROLE_REQUIRED: "Administrator role is required.",
      AUTH_UNAVAILABLE: "Authentication service is unavailable.",
      PGD_SITE_REQUIRED: "This operation is available only on the PGD Market site.",
      PRODUCTION_CONTEXT_REQUIRED: "This operation is available only in the PGD Market production context."
    };
    return jsonResponse(error.status, {
      error: error.code,
      message: messages[error.code] || "The request could not be authorized."
    });
  }

  if (error instanceof CatalogApiError) {
    return jsonResponse(error.status, { error: error.code, message: error.message });
  }
  if (error instanceof CatalogStorageError) {
    const messages = {
      RATINGS_INVALID: "Stored PGD ratings are invalid.",
      RATINGS_CORRUPT: "Stored PGD ratings are invalid.",
      RATINGS_CONFIGURATION_MISSING: "PGD ratings storage is not configured.",
      RATINGS_ACCESS_DENIED: "PGD ratings storage denied access.",
      RATINGS_UNAVAILABLE: "PGD ratings storage is unavailable.",
      RATINGS_WRITE_UNCONFIRMED: "The PGD rating write could not be confirmed.",
      RATINGS_CONFLICT: "PGD ratings changed. Reload them before trying again."
    };
    return jsonResponse(error.status >= 500 ? 503 : error.status, {
      error: error.code,
      message: messages[error.code] || "The ratings operation could not be completed."
    });
  }

  if (error?.status === 403) {
    return jsonResponse(403, {
      error: "ORIGIN_FORBIDDEN",
      message: "This request origin is not allowed."
    });
  }

  if (typeof error?.code === "string" && error.code.startsWith("CHARIOW_")) {
    return jsonResponse(error.status >= 400 && error.status < 500 ? error.status : 503, {
      error: error.code,
      message: "Chariow product data is temporarily unavailable."
    });
  }

  console.error("PGD rating operation failed.", error);
  return jsonResponse(503, {
    error: "RATINGS_UNAVAILABLE",
    message: "The ratings operation is temporarily unavailable."
  });
};

export function createCatalogHandler({
  identityApi,
  verifyOrigin = verifyRequestOrigin,
  readRatings: readRatingsImpl = readRatings,
  writeRating: writeRatingImpl = writeRating,
  fetchProducts = () =>
    fetchChariowProducts({ apiKey: process.env.CHARIOW_ADMIN_API_KEY })
} = {}) {
  return async function catalogHandler(request, context) {
    if (!["GET", "PATCH"].includes(request.method)) {
      return jsonResponse(405, {
        error: "METHOD_NOT_ALLOWED",
        message: "This method is not allowed."
      }, { Allow: "GET, PATCH" });
    }

    try {
      if (request.method !== "GET") verifyOrigin(request);
      if (identityApi) await requireAdmin(identityApi);
      else await requireAdmin();
      if (request.method === "GET") verifyTargetSiteContext(context);
      else verifyProductionContext(context);

      const url = new URL(request.url);
      if ([...url.searchParams.keys()].some((key) => key !== "id") ||
          (request.method === "GET" && url.searchParams.has("id"))) {
        throw new CatalogApiError(400, "INVALID_QUERY", "The catalog query is invalid.");
      }

      if (request.method === "GET") {
        const ratings = await readRatingsImpl();
        const products = (await fetchProducts())
          .map((product) => projectAdminProduct(product, ratings.ratings[product.id] ?? 0))
          .filter(Boolean);
        const canEditRatings =
          context?.deploy?.context === "production" && Boolean(ratings.etag);
        return responseForCatalog(ratings, products, 200, null, canEditRatings);
      }

      const productId = url.searchParams.get("id");
      try {
        validateChariowProductId(productId);
      } catch (error) {
        throw new CatalogApiError(400, error.code, error.message);
      }
      const expectedEtag = getExpectedEtag(request);
      const payload = await readJsonBody(request);
      const sourceProducts = await fetchProducts();
      const sourceProduct = sourceProducts.find(({ id }) => id === productId);
      if (!sourceProduct || !projectAdminProduct(sourceProduct, payload.rating)) {
        throw new CatalogApiError(
          404,
          "CHARIOW_PRODUCT_NOT_FOUND",
          "The Chariow product is unavailable."
        );
      }

      const updatedRatings = await writeRatingImpl(productId, payload.rating, {
        etag: expectedEtag
      });
      const products = sourceProducts
        .map((product) =>
          projectAdminProduct(product, updatedRatings.ratings[product.id] ?? 0)
        )
        .filter(Boolean);
      const updatedProduct = products.find(({ id }) => id === productId);
      return responseForCatalog(
        updatedRatings,
        products,
        200,
        updatedProduct,
        Boolean(updatedRatings.etag)
      );
    } catch (error) {
      return errorResponse(error);
    }
  };
}
