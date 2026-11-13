const CATALOG_ENDPOINT = "/.netlify/functions/public-catalog";
const PRODUCT_FIELDS = new Set([
  "id",
  "chariowProductId",
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

const isFrenchText = (value) =>
  typeof value === "string" ||
  (isRecord(value) &&
    Object.keys(value).every((key) => key === "fr" || key === "en") &&
    typeof value.fr === "string");

const isSafeImage = (image) => {
  if (typeof image !== "string" || image.length > 2048) return false;
  if (
    image.startsWith("assets/") &&
    !image.includes("\\") &&
    !image.includes("?") &&
    !image.includes("#") &&
    image.split("/").every((part) => part && part !== "." && part !== "..")
  ) {
    return true;
  }
  try {
    const url = new URL(image);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};

export function isPublicProduct(product) {
  return isRecord(product) &&
    Object.keys(product).length === PRODUCT_FIELDS.size &&
    Object.keys(product).every((field) => PRODUCT_FIELDS.has(field)) &&
    typeof product.id === "string" &&
    product.id.length > 0 &&
    typeof product.chariowProductId === "string" &&
    /^prd_[A-Za-z0-9_-]+$/.test(product.chariowProductId) &&
    isFrenchText(product.name) &&
    isFrenchText(product.description) &&
    typeof product.price === "number" &&
    Number.isFinite(product.price) &&
    product.price > 0 &&
    typeof product.currency === "string" &&
    /^[A-Z]{3}$/.test(product.currency) &&
    isSafeImage(product.image) &&
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
