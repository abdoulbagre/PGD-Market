import { CatalogStorageError, readCatalog } from "../lib/catalog/_catalog.mjs";
import { getPublicProducts } from "../lib/catalog/_catalog-model.mjs";

const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=30",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff"
};

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...RESPONSE_HEADERS, ...headers }
  });

const errorResponse = (error) => {
  if (error instanceof CatalogStorageError && error.code === "CATALOG_NOT_FOUND") {
    return jsonResponse(503, {
      success: false,
      error: "CATALOG_NOT_INITIALIZED",
      message: "The product catalog is not available yet."
    });
  }

  if (error instanceof CatalogStorageError && error.code === "CATALOG_CORRUPT") {
    return jsonResponse(503, {
      success: false,
      error: "CATALOG_INVALID",
      message: "The product catalog is temporarily unavailable."
    });
  }

  return jsonResponse(503, {
    success: false,
    error: "CATALOG_UNAVAILABLE",
    message: "The product catalog is temporarily unavailable."
  });
};

const projectPublicProduct = (product) => ({
  id: product.id,
  name: { fr: product.name.fr, en: product.name.en },
  description: { fr: product.description.fr, en: product.description.en },
  price: product.price,
  currency: product.currency,
  image: product.image,
  category: product.category
});

export function createPublicCatalogHandler({
  catalogReader = readCatalog,
  publicProductFilter = getPublicProducts
} = {}) {
  return async function publicCatalogHandler(request) {
    if (request.method !== "GET") {
      return jsonResponse(405, {
        success: false,
        error: "METHOD_NOT_ALLOWED",
        message: "Only GET is allowed."
      }, { Allow: "GET" });
    }

    try {
      const { catalog } = await catalogReader();
      const products = publicProductFilter(catalog.products).map(projectPublicProduct);
      return jsonResponse(200, {
        success: true,
        products,
        count: products.length
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export default async function publicCatalogHandler(request) {
  return createPublicCatalogHandler()(request);
}
