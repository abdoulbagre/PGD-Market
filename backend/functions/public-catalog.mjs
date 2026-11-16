import { connectLambda } from "@netlify/blobs";
import { fetchChariowProducts } from "../services/chariow/products.mjs";
import { projectPublicProduct } from "../services/chariow/public-products.mjs";
import {
  CatalogStorageError,
  readRatings
} from "../services/catalog/_catalog.mjs";

const response = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  },
  body: JSON.stringify(body)
});

export function createPublicCatalogHandler({
  connectBlobs = connectLambda,
  fetchProducts = () =>
    fetchChariowProducts({ apiKey: process.env.CHARIOW_ADMIN_API_KEY }),
  readRatings: readRatingsImpl = readRatings
} = {}) {
  return async function publicCatalogHandler(event = {}) {
    if (event.httpMethod && event.httpMethod !== "GET") {
      return response(
        405,
        { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } },
        { Allow: "GET" }
      );
    }

    try {
      connectBlobs(event);
      const [products, ratingsRecord] = await Promise.all([
        fetchProducts(),
        readRatingsImpl()
      ]);

      const publicProducts = products
        .map((product) =>
          projectPublicProduct(product, ratingsRecord.ratings[product.id] ?? 0)
        )
        .filter(Boolean);

      return response(200, {
        success: true,
        count: publicProducts.length,
        products: publicProducts
      });
    } catch (error) {
      if (error instanceof CatalogStorageError) {
        return response(error.status, {
          error: {
            code: error.code,
            message: "The product catalog is temporarily unavailable."
          }
        });
      }

      console.error("Could not load the public Chariow catalog.", error);
      return response(503, {
        error: {
          code: "CATALOG_UNAVAILABLE",
          message: "The product catalog is temporarily unavailable."
        }
      });
    }
  };
}

export const handler = createPublicCatalogHandler();
