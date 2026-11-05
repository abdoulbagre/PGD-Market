import { createHash, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { AuthAccessError, requireAdmin } from "./_auth.mjs";
import { verifyRequestOrigin } from "@netlify/identity";
import {
  CatalogStorageError,
  initializeCatalogFromLegacy,
  readCatalog
} from "./_catalog.mjs";

const EXPECTED_SITE_ID = "2e63bd1a-3d35-4bcb-b572-4d8b22e70bbf";
const EXPECTED_SITE_NAME = "pgd-market";
const EXPECTED_SITE_HOST = "pgd-market.netlify.app";
const AUTHORIZATION_SECRET_NAME = "CATALOG_INITIALIZATION_SECRET";
// This one-off endpoint is server-to-server only; never embed this secret in frontend code.
const AUTHORIZATION_HEADER = "x-catalog-initialization-secret";
const MAX_REQUEST_BODY_BYTES = 1024;
const MAX_LEGACY_SOURCE_BYTES = 1024 * 1024;
const require = createRequire(import.meta.url);

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  },
  body: JSON.stringify(body)
});

const response = (statusCode, result) =>
  jsonResponse(statusCode, { result });

const isProductionSite = (context, environment) => {
  const site = context?.site;
  const blobsContextValue = environment.NETLIFY_BLOBS_CONTEXT;
  if (
    environment.CONTEXT !== "production" ||
    context?.deploy?.context !== "production" ||
    site?.id !== EXPECTED_SITE_ID ||
    typeof blobsContextValue !== "string"
  ) {
    return false;
  }

  let blobsContext;
  try {
    blobsContext = JSON.parse(Buffer.from(blobsContextValue, "base64").toString("utf8"));
  } catch {
    return false;
  }

  if (
    !blobsContext ||
    typeof blobsContext !== "object" ||
    blobsContext.siteID !== EXPECTED_SITE_ID ||
    typeof blobsContext.token !== "string" ||
    !blobsContext.token.trim()
  ) {
    return false;
  }

  if (typeof site.name === "string" && site.name.toLowerCase() !== EXPECTED_SITE_NAME) {
    return false;
  }
  if (typeof site.url === "string") {
    try {
      if (new URL(site.url).hostname.toLowerCase() !== EXPECTED_SITE_HOST) return false;
    } catch {
      return false;
    }
  }
  return true;
};

const isAuthorizedWithSecret = (request, environment) => {
  const expectedSecret = environment[AUTHORIZATION_SECRET_NAME];
  const suppliedSecret = request.headers.get(AUTHORIZATION_HEADER);
  if (
    typeof expectedSecret !== "string" ||
    expectedSecret.length < 32 ||
    expectedSecret.trim() !== expectedSecret ||
    !suppliedSecret ||
    suppliedSecret.length > 4096
  ) {
    return false;
  }

  const expectedDigest = createHash("sha256").update(expectedSecret).digest();
  const suppliedDigest = createHash("sha256").update(suppliedSecret).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
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
  initialize = initializeCatalogFromLegacy,
  loadLegacyData = readLegacyData,
  fetchImpl = (...args) => fetch(...args),
  environment = process.env
} = {}) {
  return async function initializeCatalogHandler(request, context) {
    if (request.method !== "POST") {
      return response(405, "refused");
    }

    try {
      verifyOrigin(request);
      if (!(await authorizeAdmin())) {
        return response(401, "refused");
      }
    } catch (error) {
      const status = error instanceof AuthAccessError
        ? error.status
        : error?.status === 403 ? 403 : 401;
      return response(status, "refused");
    }

    if (!isAuthorizedWithSecret(request, environment)) {
      return response(environment[AUTHORIZATION_SECRET_NAME] ? 401 : 503, "refused");
    }
    if (!isProductionSite(context, environment)) {
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

    try {
      await initialize(legacyData);
      return response(200, "initialized");
    } catch (error) {
      if (error instanceof CatalogStorageError && error.code === "CATALOG_ALREADY_EXISTS") {
        return response(200, "already_exists");
      }
      return response(503, "refused");
    }
  };
}

export default createCatalogInitializationHandler();
