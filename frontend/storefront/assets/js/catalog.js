const CATALOG_ENDPOINT = "/.netlify/functions/public-catalog";
const PRODUCT_FIELDS = new Set([
  "id",
  "name",
  "description",
  "price",
  "originalPrice",
  "discountPercentage",
  "currency",
  "image",
  "category",
  "rating"
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

const CHARIOW_PRODUCT_ID = /^prd_[A-Za-z0-9_-]{1,120}$/;

export function findCatalogProduct(products, id) {
  if (
    !Array.isArray(products) ||
    typeof id !== "string" ||
    !CHARIOW_PRODUCT_ID.test(id)
  ) {
    return null;
  }
  return products.find((product) => product.id === id) || null;
}

export function getOriginalProductPrice(product) {
  return isRecord(product) &&
    typeof product.price === "number" &&
    Number.isFinite(product.price) &&
    typeof product.originalPrice === "number" &&
    Number.isFinite(product.originalPrice) &&
    product.originalPrice > product.price
    ? product.originalPrice
    : null;
}

export function getProductDiscountPercentage(product) {
  if (!isRecord(product) || getOriginalProductPrice(product) === null) return null;

  const discount = product.discountPercentage;
  const match = typeof discount === "string"
    ? /^(\d+(?:\.\d+)?)%$/.exec(discount)
    : null;
  const percentage = match ? Number(match[1]) : Number.NaN;

  return Number.isFinite(percentage) && percentage > 0 && percentage <= 100
    ? discount
    : null;
}

export function plainTextDescription(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|li|div|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderProductRating(rating, label) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return "";
  const stars = Array.from({ length: 5 }, (_, index) =>
    index < rating ? "&#9733;" : "&#9734;"
  ).join("");
  const accessibleLabel = String(label).replace(/[&<>\"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
  return `<div class="product-rating" role="img" aria-label="${accessibleLabel}"><span class="product-rating__stars" aria-hidden="true">${stars}</span></div>`;
}

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
    CHARIOW_PRODUCT_ID.test(product.id) &&
    isFrenchText(product.name) &&
    isFrenchText(product.description) &&
    typeof product.price === "number" &&
    Number.isFinite(product.price) &&
    product.price > 0 &&
    (product.originalPrice === null || getOriginalProductPrice(product) !== null) &&
    (product.discountPercentage === null || getProductDiscountPercentage(product) !== null) &&
    typeof product.currency === "string" &&
    /^[A-Z]{3}$/.test(product.currency) &&
    isSafeImage(product.image) &&
    typeof product.category === "string" &&
    Number.isInteger(product.rating) &&
    product.rating >= 0 &&
    product.rating <= 5;
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
