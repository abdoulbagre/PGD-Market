import catalogSeed from "../data/catalog-seed.json" with { type: "json" };
import { fetchChariowProducts } from "../services/chariow/products.mjs";

const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=30",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff"
};
const LEGACY_PRODUCTS = new Map(catalogSeed.products.map((product) => [
  product.chariowProductId,
  product
]));
const CHECKOUT_SUPPORTED_TYPES = new Set(["downloadable", "course", "license", "bundle"]);

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...RESPONSE_HEADERS, ...headers }
  });

const errorResponse = (error) => jsonResponse(
  [502, 503, 504].includes(error?.status) ? error.status : 503,
  {
    success: false,
    error: error?.code || "CHARIOW_UNAVAILABLE",
    message: error?.status === 504
      ? "Chariow met trop de temps à répondre. Réessayez."
      : "Le catalogue Chariow est temporairement indisponible."
  },
  error?.retryAfter ? { "Retry-After": error.retryAfter } : {}
);

const validImageUrl = (value) => {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
};

const currentPrice = (product) =>
  product?.pricing?.current_price ||
  product?.pricing?.effective ||
  null;

const isInStock = (product) => {
  if (product.quantity === null) return true;
  const remaining = product.quantity?.remaining;
  const quantity = typeof remaining === "number" ? remaining : remaining?.value;
  return !Number.isSafeInteger(quantity) || quantity > 0;
};

const projectPublicProduct = (product) => {
  if (
    !product ||
    typeof product.id !== "string" ||
    !/^prd_[A-Za-z0-9_-]{1,120}$/.test(product.id) ||
    product.status !== "published" ||
    !CHECKOUT_SUPPORTED_TYPES.has(product.type) ||
    product.has_variant_pricing === true ||
    product.is_free === true ||
    product.pricing?.type === "free" ||
    product.pricing?.type === "what_you_want" ||
    !isInStock(product)
  ) {
    return null;
  }

  const legacyProduct = LEGACY_PRODUCTS.get(product.id);
  const price = currentPrice(product);
  if (
    typeof product.name !== "string" ||
    !product.name.trim() ||
    !price ||
    typeof price.value !== "number" ||
    !Number.isFinite(price.value) ||
    price.value <= 0 ||
    typeof price.currency !== "string" ||
    !/^[A-Z]{3}$/.test(price.currency)
  ) {
    return null;
  }

  const category = product.category;
  const image = validImageUrl(product.pictures?.cover) ||
    validImageUrl(product.pictures?.thumbnail) ||
    legacyProduct?.image ||
    "assets/Background/logo-bronze.png";

  return {
    id: product.id,
    legacyPgdId: legacyProduct?.id || null,
    name: product.name,
    description: typeof product.description === "string" ? product.description : "",
    price: price.value,
    currency: price.currency,
    image,
    category: typeof category?.label === "string"
      ? category.label
      : typeof category?.value === "string"
        ? category.value
        : ""
  };
};

export function createPublicCatalogHandler({
  productReader = (options) => fetchChariowProducts(options),
  env = process.env
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
      const sourceProducts = await productReader({
        apiKey: env.CHARIOW_ADMIN_API_KEY
      });
      if (!Array.isArray(sourceProducts)) {
        throw new Error("Chariow product response is invalid.");
      }
      const products = sourceProducts.map(projectPublicProduct).filter(Boolean);
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
