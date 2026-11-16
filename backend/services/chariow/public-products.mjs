import { CHARIOW_PRODUCT_ID_PATTERN } from "../catalog/_ratings-model.mjs";
import { resolveChariowDiscount, resolveChariowPrice } from "./products.mjs";

const CHECKOUT_SUPPORTED_TYPES = new Set(["downloadable", "course", "license", "bundle"]);
const GENERIC_PRODUCT_IMAGE = "assets/Background/logo-bronze.png";

const isLocalizedText = (value) =>
  typeof value === "string" ||
  value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => key === "fr" || key === "en") &&
    typeof value.fr === "string";

const validImageUrl = (value) => {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
};

const isInStock = (product) => {
  if (product.quantity === null || product.quantity === undefined) return true;
  if (!product.quantity || typeof product.quantity !== "object" || Array.isArray(product.quantity)) {
    return false;
  }
  const remaining = product.quantity?.remaining;
  const quantity = typeof remaining === "number"
    ? remaining
    : remaining && typeof remaining === "object" && !Array.isArray(remaining)
      ? remaining.value
      : undefined;
  return Number.isSafeInteger(quantity) && quantity > 0;
};

export function isChariowProductPurchasable(product) {
  return Boolean(
    product &&
    product.status === "published" &&
    CHECKOUT_SUPPORTED_TYPES.has(product.type) &&
    product.has_variant_pricing !== true &&
    product.is_free !== true &&
    product.pricing?.type !== "free" &&
    product.pricing?.type !== "what_you_want" &&
    resolveChariowPrice(product) &&
    isInStock(product)
  );
}

export function projectAdminProduct(product, rating = 0) {
  if (
    !product ||
    typeof product.id !== "string" ||
    !CHARIOW_PRODUCT_ID_PATTERN.test(product.id) ||
    !isLocalizedText(product.name) ||
    !(typeof product.name === "string" ? product.name : product.name.fr).trim()
  ) {
    return null;
  }

  const price = resolveChariowPrice(product);
  const category = product.category;

  return {
    id: product.id,
    name: product.name,
    description: isLocalizedText(product.description) ? product.description : "",
    price: price?.value ?? null,
    currency: price?.currency ?? "",
    image: validImageUrl(product.pictures?.cover) ||
      validImageUrl(product.pictures?.thumbnail) ||
      GENERIC_PRODUCT_IMAGE,
    rating,
    category: typeof category?.label === "string"
      ? category.label
      : typeof category?.value === "string"
        ? category.value
        : ""
  };
}

export function projectPublicProduct(product, rating = 0) {
  if (
    !product ||
    typeof product.id !== "string" ||
    !CHARIOW_PRODUCT_ID_PATTERN.test(product.id) ||
    !isChariowProductPurchasable(product)
  ) {
    return null;
  }

  const projected = projectAdminProduct(product, rating);
  const price = resolveChariowPrice(product);
  return projected?.price === null || !projected
    ? null
    : {
      ...projected,
      originalPrice: price.originalValue,
      discountPercentage: resolveChariowDiscount(product)
    };
}
