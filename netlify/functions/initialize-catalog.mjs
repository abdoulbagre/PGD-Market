import { createRequire } from "node:module";
import { AuthAccessError, requireAdmin } from "./_auth.mjs";
import { verifyRequestOrigin } from "@netlify/identity";
import {
  CATALOG_KEY,
  CATALOG_SCHEMA_VERSION,
  CATALOG_STORE_NAME,
  CatalogStorageError,
  initializeCatalog,
  prepareInitialCatalogFromLegacy,
  readCatalog
} from "./_catalog.mjs";
import { validateCatalog } from "../lib/catalog/_catalog-model.mjs";

const EXPECTED_SITE_ID = "2e63bd1a-3d35-4bcb-b572-4d8b22e70bbf";
const EXPECTED_SITE_NAME = "pgd-market";
const EXPECTED_SITE_HOST = "pgd-market.netlify.app";
const AUTHORIZATION_SECRET_NAME = "CATALOG_INITIALIZATION_SECRET";
const EXPECTED_PRODUCTS = new Map([
  [
    "550e8400-e29b-41d4-a716-446655440000",
    { price: 4200, currency: "XOF", chariowProductId: "prd_5lj7fz8k" }
  ],
  [
    "7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90",
    { price: 3000, currency: "XOF", chariowProductId: "prd_ln1r0vbr" }
  ]
]);
const MAX_REQUEST_BODY_BYTES = 1024;
const MAX_LEGACY_SOURCE_BYTES = 1024 * 1024;
const require = createRequire(import.meta.url);

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    }
  });

const response = (statusCode, result) =>
  jsonResponse(statusCode, { result });

const getProductionSiteFailure = (context, environment) => {
  const site = context?.site;
  const blobsContextValue = environment.NETLIFY_BLOBS_CONTEXT;
  if (
    CATALOG_STORE_NAME !== "pgd-market-catalog" ||
    CATALOG_KEY !== "catalog-v1" ||
    CATALOG_SCHEMA_VERSION !== 2
  ) {
    return "TARGET_CONFIGURATION_MISMATCH";
  }
  if (environment.CONTEXT !== "production") return "ENV_CONTEXT_NOT_PRODUCTION";
  if (context?.deploy?.context !== "production") return "DEPLOY_CONTEXT_NOT_PRODUCTION";
  if (environment.NETLIFY_SITE_ID !== EXPECTED_SITE_ID) return "ENV_SITE_ID_MISMATCH";
  if (site?.id !== EXPECTED_SITE_ID) return "CONTEXT_SITE_ID_MISMATCH";
  if (typeof blobsContextValue !== "string") return "BLOBS_CONTEXT_MISSING";

  let blobsContext;
  try {
    blobsContext = JSON.parse(Buffer.from(blobsContextValue, "base64").toString("utf8"));
  } catch {
    return "BLOBS_CONTEXT_INVALID";
  }

  if (
    !blobsContext ||
    typeof blobsContext !== "object" ||
    typeof blobsContext.token !== "string" ||
    !blobsContext.token.trim()
  ) {
    return "BLOBS_CONTEXT_INCOMPLETE";
  }
  if (blobsContext.siteID !== EXPECTED_SITE_ID) return "BLOBS_SITE_ID_MISMATCH";

  if (typeof site.name === "string" && site.name.toLowerCase() !== EXPECTED_SITE_NAME) {
    return "SITE_NAME_MISMATCH";
  }
  if (typeof site.url === "string") {
    try {
      if (new URL(site.url).hostname.toLowerCase() !== EXPECTED_SITE_HOST) {
        return "SITE_HOST_MISMATCH";
      }
    } catch {
      return "SITE_URL_INVALID";
    }
  }
  return null;
};

const hasInitializationSecret = (environment) => {
  const expectedSecret = environment[AUTHORIZATION_SECRET_NAME];
  if (
    typeof expectedSecret !== "string" ||
    expectedSecret.length < 32 ||
    expectedSecret.trim() !== expectedSecret
  ) {
    return false;
  }

  return true;
};

const hasEmptyPayload = async (request) => {
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) return false;
  if (!body.trim()) return true;

  try {
    const payload = JSON.parse(body);
    return payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      Object.keys(payload).length === 0;
  } catch {
    return false;
  }
};

const prepareExpectedCatalog = (legacyData) => {
  const publicProducts = legacyData.publicProducts.filter(({ id }) =>
    EXPECTED_PRODUCTS.has(id)
  );
  const serverProducts = legacyData.serverProducts.filter(({ id }) =>
    EXPECTED_PRODUCTS.has(id)
  );
  const englishTranslations = Object.fromEntries(
    [...EXPECTED_PRODUCTS.keys()].map((id) => [id, legacyData.englishTranslations[id]])
  );

  if (
    publicProducts.length !== EXPECTED_PRODUCTS.size ||
    serverProducts.length !== EXPECTED_PRODUCTS.size
  ) {
    throw new Error("Initial catalog sources do not contain the expected products.");
  }

  const catalog = prepareInitialCatalogFromLegacy({
    ...legacyData,
    publicProducts,
    serverProducts,
    englishTranslations
  });
  validateCatalog(catalog.products);
  if (
    catalog.schemaVersion !== CATALOG_SCHEMA_VERSION ||
    catalog.products.length !== EXPECTED_PRODUCTS.size
  ) {
    throw new Error("Prepared catalog does not match the expected schema.");
  }

  for (const product of catalog.products) {
    const expected = EXPECTED_PRODUCTS.get(product.id);
    if (
      !expected ||
      product.price !== expected.price ||
      product.currency !== expected.currency ||
      product.chariowProductId !== expected.chariowProductId ||
      product.published !== true ||
      product.available !== true
    ) {
      throw new Error("Prepared catalog does not match the expected products.");
    }
  }

  return catalog;
};

const isExpectedCatalog = (catalog) => {
  try {
    validateCatalog(catalog.products);
    return catalog.schemaVersion === CATALOG_SCHEMA_VERSION &&
      catalog.products.length === EXPECTED_PRODUCTS.size &&
      [...EXPECTED_PRODUCTS].every(([id, expected]) => {
        const product = catalog.products.find((item) => item.id === id);
        return product &&
          product.price === expected.price &&
          product.currency === expected.currency &&
          product.chariowProductId === expected.chariowProductId &&
          product.published === true &&
          product.available === true;
      });
  } catch {
    return false;
  }
};

const readLegacyData = async (fetchImpl) => {
  const publicOrigin = `https://${EXPECTED_SITE_HOST}`;
  const [publicResponse, translationsResponse] = await Promise.all([
    fetchImpl(`${publicOrigin}/assets/js/products.js`, {
      method: "GET",
      cache: "no-store",
      redirect: "error"
    }),
    fetchImpl(`${publicOrigin}/locales/en.json`, {
      method: "GET",
      cache: "no-store",
      redirect: "error"
    })
  ]);
  if (!publicResponse.ok || !translationsResponse.ok) {
    throw new Error("Initial catalog sources are unavailable.");
  }

  const [publicSource, translationsText] = await Promise.all([
    publicResponse.text(),
    translationsResponse.text()
  ]);
  if (
    Buffer.byteLength(publicSource, "utf8") > MAX_LEGACY_SOURCE_BYTES ||
    Buffer.byteLength(translationsText, "utf8") > MAX_LEGACY_SOURCE_BYTES
  ) {
    throw new Error("Initial catalog sources are invalid.");
  }

  const publicModule = await import(
    `data:text/javascript;base64,${Buffer.from(publicSource).toString("base64")}`
  );
  const englishLocale = JSON.parse(translationsText);
  const serverProducts = require("./_products.js").products;

  return {
    publicProducts: publicModule.products,
    serverProducts,
    englishTranslations: englishLocale.products,
    referenceCurrency: "XOF"
  };
};

export function createCatalogInitializationHandler({
  authorizeAdmin = requireAdmin,
  verifyOrigin = verifyRequestOrigin,
  catalogReader = readCatalog,
  initialize = initializeCatalog,
  loadLegacyData = readLegacyData,
  fetchImpl = (...args) => fetch(...args),
  environment = process.env,
  logGuard = (code) => console.warn("CATALOG_INITIALIZATION_GUARD", code)
} = {}) {
  return async function initializeCatalogHandler(request, context) {
    if (request.method !== "POST") {
      return response(405, "refused");
    }

    try {
      verifyOrigin(request);
    } catch (error) {
      const status = error instanceof AuthAccessError
        ? error.status
        : error?.status === 403 ? 403 : 401;
      logGuard(status === 403 ? "ORIGIN_REJECTED" : "ORIGIN_CHECK_FAILED");
      return response(status, "refused");
    }

    try {
      if (!(await authorizeAdmin())) {
        logGuard("ADMIN_NOT_AUTHENTICATED");
        return response(401, "refused");
      }
    } catch (error) {
      const status = error instanceof AuthAccessError
        ? error.status
        : error?.status === 403 ? 403 : 401;
      const guardCode = error instanceof AuthAccessError
        ? error.code === "ADMIN_ROLE_REQUIRED"
          ? "ADMIN_ROLE_REQUIRED"
          : error.code === "AUTHENTICATION_REQUIRED"
            ? "AUTHENTICATION_REQUIRED"
            : "AUTH_UNAVAILABLE"
        : status === 403 ? "ADMIN_AUTH_FORBIDDEN" : "ADMIN_AUTH_FAILED";
      logGuard(guardCode);
      return response(status, "refused");
    }

    if (!hasInitializationSecret(environment)) {
      logGuard("INITIALIZATION_SECRET_MISSING");
      return response(503, "refused");
    }
    const productionSiteFailure = getProductionSiteFailure(context, environment);
    if (productionSiteFailure) {
      logGuard(productionSiteFailure);
      return response(403, "refused");
    }
    if (!(await hasEmptyPayload(request))) {
      return response(400, "refused");
    }

    try {
      await catalogReader();
      return response(200, "already_exists");
    } catch (error) {
      if (!(error instanceof CatalogStorageError) || error.code !== "CATALOG_NOT_FOUND") {
        return response(503, "refused");
      }
    }

    let legacyData;
    try {
      legacyData = await loadLegacyData(fetchImpl);
    } catch {
      return response(503, "refused");
    }
    if (
      !legacyData ||
      !Array.isArray(legacyData.publicProducts) ||
      !Array.isArray(legacyData.serverProducts) ||
      !legacyData.englishTranslations ||
      typeof legacyData.englishTranslations !== "object"
    ) {
      return response(503, "refused");
    }

    let preparedCatalog;
    try {
      preparedCatalog = prepareExpectedCatalog(legacyData);
    } catch (error) {
      return response(503, "refused");
    }

    try {
      await initialize(preparedCatalog);
    } catch (error) {
      if (error instanceof CatalogStorageError && error.code === "CATALOG_ALREADY_EXISTS") {
        return response(200, "already_exists");
      }
      return response(503, "refused");
    }

    try {
      const reread = await catalogReader();
      if (
        !isExpectedCatalog(reread.catalog) ||
        JSON.stringify(reread.catalog) !== JSON.stringify(preparedCatalog)
      ) {
        return response(503, "refused");
      }
    } catch {
      return response(503, "refused");
    }

    return response(200, "initialized");
  };
}

export default createCatalogInitializationHandler();
