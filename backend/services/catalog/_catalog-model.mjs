const PRODUCT_FIELDS = new Set([
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
  "archivedAt",
  "createdAt",
  "updatedAt"
]);
const CURRENCIES = new Set(["XOF", "EUR", "USD"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHARIOW_PRODUCT_ID_PATTERN = /^prd_[A-Za-z0-9_-]+$/;

export class CatalogModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatalogModelError";
    this.code = code;
  }
}

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fail = (code, message) => {
  throw new CatalogModelError(code, message);
};

const hasOnlyKeys = (value, allowedKeys) =>
  Object.keys(value).every((key) => allowedKeys.has(key));

const isSafeText = (value, maxLength) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maxLength &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);

const isSafeDescription = (value) =>
  isSafeText(value, 20000) &&
  !/[<>]/.test(value.replace(/<br\s*\/?>/gi, ""));

const isSafeAssetPath = (value, maxLength) =>
  isSafeText(value, maxLength) &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("?") &&
  !value.includes("#") &&
  value.split("/").every((segment) => segment && segment !== "." && segment !== "..");

const isIsoTimestamp = (value) => {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value;
};

export function validateProduct(product, { allowUnknownDates = false } = {}) {
  if (!isRecord(product) || !hasOnlyKeys(product, PRODUCT_FIELDS)) {
    fail("INVALID_PRODUCT", "Product has an invalid shape.");
  }
  if (!UUID_PATTERN.test(product.id)) {
    fail("INVALID_PRODUCT_ID", "Product ID must be a UUID.");
  }

  for (const field of ["name", "description"]) {
    const text = product[field];
    const frenchText = typeof text === "string"
      ? text
      : isRecord(text) && hasOnlyKeys(text, new Set(["fr", "en"]))
        ? text.fr
        : null;
    if (!isSafeText(frenchText, field === "name" ? 200 : 20000)) {
      fail("INVALID_TRANSLATION", `Product ${field} must have valid French text.`);
    }
    if (field === "description" && !isSafeDescription(frenchText)) {
      fail("INVALID_DESCRIPTION", "Product description contains unsupported markup.");
    }
  }

  if (!Number.isSafeInteger(product.price) || product.price <= 0) {
    fail("INVALID_PRICE", "Product price must be a positive safe integer.");
  }
  if (!CURRENCIES.has(product.currency)) {
    fail("INVALID_CURRENCY", "Product currency is not supported.");
  }
  if (
    !isSafeAssetPath(product.image, 512) ||
    !product.image.startsWith("assets/")
  ) {
    fail("INVALID_IMAGE", "Product image must be a safe path under assets/.");
  }
  if (
    typeof product.category !== "string" ||
    product.category.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(product.category)
  ) {
    fail("INVALID_CATEGORY", "Product category is invalid.");
  }
  if (
    product.chariowProductId !== null &&
    (
      !isSafeText(product.chariowProductId, 128) ||
      !CHARIOW_PRODUCT_ID_PATTERN.test(product.chariowProductId)
    )
  ) {
    fail("INVALID_CHARIOW_ID", "Chariow product ID is invalid.");
  }
  if (typeof product.available !== "boolean" || typeof product.published !== "boolean") {
    fail("INVALID_PRODUCT_STATE", "Product availability and publication must be boolean.");
  }
  if (
    product.available &&
    (!product.published || !product.chariowProductId)
  ) {
    fail("INVALID_PRODUCT_STATE", "An available product must be published and linked to Chariow.");
  }
  if (
    Object.hasOwn(product, "archivedAt") &&
    product.archivedAt !== null &&
    !isIsoTimestamp(product.archivedAt)
  ) {
    fail("INVALID_ARCHIVE_DATE", "Product archive date must be null or a valid ISO timestamp.");
  }

  const hasUnknownDates = product.createdAt === null && product.updatedAt === null;
  const hasValidDates = isIsoTimestamp(product.createdAt) && isIsoTimestamp(product.updatedAt);
  if ((!hasUnknownDates || !allowUnknownDates) && !hasValidDates) {
    fail("INVALID_PRODUCT_DATES", "Product dates must both be valid ISO timestamps or both be unknown.");
  }
  if (hasValidDates && Date.parse(product.updatedAt) < Date.parse(product.createdAt)) {
    fail("INVALID_PRODUCT_DATES", "Product update date cannot precede its creation date.");
  }

  return product;
}

export function validateCatalog(products, { allowUnknownDates = false } = {}) {
  if (!Array.isArray(products)) {
    fail("INVALID_CATALOG", "Catalog products must be an array.");
  }

  const ids = new Set();
  for (const product of products) {
    validateProduct(product, { allowUnknownDates });
    if (ids.has(product.id)) {
      fail("DUPLICATE_PRODUCT_ID", "Catalog product IDs must be unique.");
    }
    ids.add(product.id);
  }

  return products;
}

export function hasValidChariowProductId(product) {
  return typeof product?.chariowProductId === "string" &&
    CHARIOW_PRODUCT_ID_PATTERN.test(product.chariowProductId);
}

export function isPubliclyVisible(product) {
  return Boolean(
    (product?.archivedAt === undefined || product.archivedAt === null) &&
    product?.published === true &&
    product.available === true &&
    hasValidChariowProductId(product)
  );
}

export function getPublicProducts(products, options = {}) {
  validateCatalog(products, options);
  return products.filter(isPubliclyVisible);
}

export function isPurchasable(product) {
  return Boolean(
    isPubliclyVisible(product) &&
    Number.isSafeInteger(product.price) &&
    product.price > 0 &&
    CURRENCIES.has(product.currency)
  );
}

export function assertImmutableProductId(existingId, nextId) {
  if (existingId !== nextId) {
    fail("IMMUTABLE_PRODUCT_ID", "An existing product ID cannot be changed.");
  }
}

export function buildLegacyCatalog({
  publicProducts,
  serverProducts,
  referenceCurrency
}) {
  if (!Array.isArray(publicProducts) || !Array.isArray(serverProducts)) {
    fail("INVALID_LEGACY_CATALOG", "Both legacy product catalogs must be provided.");
  }
  if (!CURRENCIES.has(referenceCurrency)) {
    fail("INVALID_CURRENCY", "A supported reference currency must be provided explicitly.");
  }

  const serverById = new Map();
  for (const product of serverProducts) {
    if (serverById.has(product.id)) {
      fail("DUPLICATE_PRODUCT_ID", "Server catalog product IDs must be unique.");
    }
    serverById.set(product.id, product);
  }
  const publicIds = new Set(publicProducts.map(({ id }) => id));
  if ([...serverById.keys()].some((id) => !publicIds.has(id))) {
    fail("SERVER_ONLY_PRODUCT", "A server-only product must be reconciled before building the catalog.");
  }
  const products = publicProducts.map((publicProduct) => {
    const serverProduct = serverById.get(publicProduct.id);
    if (serverProduct && serverProduct.prix !== publicProduct.prix) {
      fail("LEGACY_PRICE_CONFLICT", `Legacy price mismatch for product ${publicProduct.id}.`);
    }

    const product = {
      id: publicProduct.id,
      name: publicProduct.nom,
      description: publicProduct.description,
      price: publicProduct.prix,
      currency: referenceCurrency,
      image: publicProduct.image,
      category: publicProduct.categorie,
      chariowProductId: serverProduct?.chariowProductId ?? null,
      available: Boolean(
        serverProduct &&
        CHARIOW_PRODUCT_ID_PATTERN.test(serverProduct.chariowProductId)
      ),
      published: true,
      archivedAt: null,
      createdAt: null,
      updatedAt: null
    };

    return validateProduct(product, { allowUnknownDates: true });
  });

  validateCatalog(products, { allowUnknownDates: true });
  return products;
}
