const CATALOG_ENDPOINT = "/.netlify/functions/public-catalog";
const SUPPORTED_CURRENCIES = new Set(["XOF", "EUR", "USD"]);
const PRODUCT_FIELDS = new Set([
  "id",
  "name",
  "description",
  "price",
  "currency",
  "image",
  "category"
]);

export class CatalogLoadError extends Error {
  constructor(code) {
    super(code);
    this.name = "CatalogLoadError";
    this.code = code;
  }
}

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isLocalizedText = (value) =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  typeof value.fr === "string" &&
  typeof value.en === "string";

export function isPublicProduct(product) {
  return isRecord(product) &&
    Object.keys(product).length === PRODUCT_FIELDS.size &&
    Object.keys(product).every((field) => PRODUCT_FIELDS.has(field)) &&
    typeof product.id === "string" &&
    product.id.length > 0 &&
    isLocalizedText(product.name) &&
    isLocalizedText(product.description) &&
    Number.isSafeInteger(product.price) &&
    product.price > 0 &&
    SUPPORTED_CURRENCIES.has(product.currency) &&
    typeof product.image === "string" &&
    product.image.startsWith("assets/") &&
    !product.image.includes("\\") &&
    !product.image.includes("?") &&
    !product.image.includes("#") &&
    product.image.split("/").every((part) => part && part !== "." && part !== "..") &&
    typeof product.category === "string";
}

export function createCatalogClient(fetchImpl = (...args) => fetch(...args)) {
  let catalogPromise = null;
  let requestPending = false;

  async function load() {
    if (catalogPromise) return catalogPromise;

    requestPending = true;
    catalogPromise = (async () => {
      let response;
      try {
        response = await fetchImpl(CATALOG_ENDPOINT, {
          method: "GET",
          headers: { Accept: "application/json" }
        });
      } catch {
        throw new CatalogLoadError("network");
      }

      if (!response.ok) throw new CatalogLoadError("http");

      let result;
      try {
        result = await response.json();
      } catch {
        throw new CatalogLoadError("invalid-json");
      }
      if (
        !isRecord(result) ||
        result.success !== true ||
        !Array.isArray(result.products) ||
        result.count !== result.products.length ||
        !result.products.every(isPublicProduct)
      ) {
        throw new CatalogLoadError("invalid-data");
      }
      return result.products;
    })()
      .then((products) => {
        requestPending = false;
        return products;
      })
      .catch((error) => {
        requestPending = false;
        catalogPromise = null;
        throw error;
      });

    return catalogPromise;
  }

  return {
    load,
    retry() {
      if (requestPending) return catalogPromise;
      catalogPromise = null;
      return load();
    }
  };
}
