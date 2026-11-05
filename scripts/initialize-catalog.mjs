import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  CatalogStorageError,
  initializeCatalogFromLegacy,
  prepareInitialCatalogFromLegacy,
  readCatalog
} from "../netlify/functions/_catalog.mjs";
import { validateCatalog } from "../netlify/functions/_catalog-model.mjs";

export const CATALOG_TARGET = Object.freeze({
  siteHost: "pgd-market.netlify.app",
  store: "pgd-market-catalog",
  key: "catalog-v1",
  schemaVersion: 2,
  environment: "production"
});

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

const require = createRequire(import.meta.url);
const EXPECTED_CONFIRMATION = "INITIALISER pgd-market-catalog";

export class CatalogOperatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatalogOperatorError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new CatalogOperatorError(code, message);
};

const loadLegacyData = async () => {
  const publicSource = await readFile(
    new URL("../public/assets/js/products.js", import.meta.url),
    "utf8"
  );
  const publicModule = await import(
    `data:text/javascript;base64,${Buffer.from(publicSource).toString("base64")}`
  );
  const serverProducts = require("../netlify/functions/_products.js").products;
  const englishLocale = JSON.parse(await readFile(
    new URL("../public/locales/en.json", import.meta.url),
    "utf8"
  ));

  return {
    publicProducts: publicModule.products,
    serverProducts,
    englishTranslations: englishLocale.products,
    referenceCurrency: "XOF"
  };
};

const readBlobsContext = (environment) => {
  if (typeof environment.NETLIFY_BLOBS_CONTEXT !== "string") {
    fail("BLOBS_CONTEXT_REQUIRED", "Netlify Blobs context is required.");
  }

  let context;
  try {
    context = JSON.parse(
      Buffer.from(environment.NETLIFY_BLOBS_CONTEXT, "base64").toString("utf8")
    );
  } catch {
    fail("BLOBS_CONTEXT_INVALID", "Netlify Blobs context is invalid.");
  }

  if (
    !context ||
    typeof context !== "object" ||
    typeof context.siteID !== "string" ||
    !context.siteID.trim() ||
    typeof context.token !== "string" ||
    !context.token.trim()
  ) {
    fail("BLOBS_CONTEXT_INVALID", "Netlify Blobs context is incomplete.");
  }

  return context;
};

const verifyNetlifySite = async (context, fetchImpl) => {
  let apiURL;
  try {
    apiURL = new URL(context.apiURL || "https://api.netlify.com");
  } catch {
    fail("NETLIFY_API_URL_INVALID", "Netlify API URL is invalid.");
  }
  if (
    apiURL.protocol !== "https:" ||
    apiURL.hostname !== "api.netlify.com" ||
    apiURL.username ||
    apiURL.password
  ) {
    fail("NETLIFY_API_URL_INVALID", "Netlify API URL is not the trusted API host.");
  }

  let response;
  try {
    response = await fetchImpl(
      new URL(`/api/v1/sites/${encodeURIComponent(context.siteID)}`, apiURL),
      { headers: { Authorization: `Bearer ${context.token}` } }
    );
  } catch {
    fail("SITE_LOOKUP_FAILED", "Could not verify the Netlify site identity.");
  }
  if (!response.ok) {
    fail("SITE_LOOKUP_FAILED", "Could not verify the Netlify site identity.");
  }

  let site;
  try {
    site = await response.json();
  } catch {
    fail("SITE_LOOKUP_FAILED", "Could not verify the Netlify site identity.");
  }

  const returnedSiteId = site?.id ?? site?.site_id;
  let siteHost;
  try {
    siteHost = new URL(site?.url).hostname.toLowerCase();
  } catch {
    fail("SITE_IDENTITY_MISMATCH", "The Netlify site does not match PGD Market.");
  }
  if (returnedSiteId !== context.siteID || siteHost !== CATALOG_TARGET.siteHost) {
    fail("SITE_IDENTITY_MISMATCH", "The Netlify site does not match PGD Market.");
  }
};

const validateExpectedCatalog = (catalog, legacyData) => {
  try {
    if (
      catalog?.schemaVersion !== CATALOG_TARGET.schemaVersion ||
      !Array.isArray(catalog.products) ||
      catalog.products.length !== EXPECTED_PRODUCTS.size
    ) {
      fail("INITIAL_CATALOG_MISMATCH", "Prepared catalog does not match the expected products.");
    }
    validateCatalog(catalog.products);

    const publicById = new Map(
      legacyData.publicProducts.map((product) => [product.id, product])
    );
    const actualIds = new Set(catalog.products.map(({ id }) => id));
    if (
      actualIds.size !== EXPECTED_PRODUCTS.size ||
      [...EXPECTED_PRODUCTS.keys()].some((id) => !actualIds.has(id))
    ) {
      fail("INITIAL_CATALOG_MISMATCH", "Prepared catalog does not match the expected products.");
    }

    for (const product of catalog.products) {
      const expected = EXPECTED_PRODUCTS.get(product.id);
      const publicProduct = publicById.get(product.id);
      if (
        !expected ||
        !publicProduct ||
        product.name.fr !== publicProduct.nom ||
        product.description.fr !== publicProduct.description ||
        product.name.en !== legacyData.englishTranslations?.[product.id]?.name ||
        product.description.en !== legacyData.englishTranslations?.[product.id]?.description ||
        !product.name.fr ||
        !product.name.en ||
        !product.description.fr ||
        !product.description.en ||
        product.price !== expected.price ||
        product.currency !== expected.currency ||
        product.chariowProductId !== expected.chariowProductId ||
        product.published !== true ||
        product.available !== true
      ) {
        fail("INITIAL_CATALOG_MISMATCH", "Prepared catalog does not match the expected products.");
      }
    }
  } catch (error) {
    if (error instanceof CatalogOperatorError) throw error;
    fail("INITIAL_CATALOG_INVALID", "Prepared catalog failed canonical validation.");
  }
};

const sameExpectedProducts = (catalog, legacyData) => {
  try {
    validateExpectedCatalog(catalog, legacyData);
    return true;
  } catch {
    return false;
  }
};

const printSummary = (catalog, log) => {
  log(`Schema version: ${catalog.schemaVersion}`);
  log(`Products: ${catalog.products.length}`);
  for (const product of catalog.products) {
    log(
      `- ${product.id} | ${product.name.fr} / ${product.name.en} | ` +
      `${product.price} ${product.currency} | ${product.chariowProductId} | ` +
      `published=${product.published} available=${product.available}`
    );
  }
};

const askForConfirmation = async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(`Saisissez exactement « ${EXPECTED_CONFIRMATION} » : `);
  } finally {
    terminal.close();
  }
};

const readExpectedAbsence = async (read) => {
  try {
    await read();
  } catch (error) {
    if (
      error instanceof CatalogStorageError &&
      error.code === "CATALOG_NOT_FOUND"
    ) {
      return;
    }
    if (error instanceof CatalogStorageError && error.code === "CATALOG_CORRUPT") {
      fail("CATALOG_CORRUPT", "Stored catalog is corrupt; initialization stopped.");
    }
    if (error instanceof CatalogStorageError && error.code === "CATALOG_UNAVAILABLE") {
      fail("CATALOG_UNAVAILABLE", "Catalog storage is unavailable; initialization stopped.");
    }
    if (error instanceof CatalogStorageError) {
      fail(error.code, "Catalog read failed; initialization stopped.");
    }
    fail("CATALOG_READ_FAILED", "Catalog read failed; initialization stopped.");
  }
  fail("CATALOG_ALREADY_EXISTS", "A catalog already exists; initialization stopped.");
};

const verifyWrittenCatalog = (readResult, legacyData, returnedEtag) => {
  validateExpectedCatalog(readResult.catalog, legacyData);
  if (returnedEtag && returnedEtag !== readResult.etag) {
    fail("POST_WRITE_ETAG_MISMATCH", "The initialization ETag does not match the reread ETag.");
  }
};

export async function runCatalogInitialization({
  argv = [],
  environment = process.env,
  dependencies = {}
} = {}) {
  if (
    argv.some((argument) => argument !== "--apply") ||
    argv.filter((argument) => argument === "--apply").length > 1
  ) {
    fail("INVALID_ARGUMENTS", "Only the optional --apply flag is supported.");
  }

  const apply = argv.includes("--apply");
  if (environment.CONTEXT !== CATALOG_TARGET.environment) {
    fail("WRONG_ENVIRONMENT", "CONTEXT must explicitly be production.");
  }

  const context = readBlobsContext(environment);
  const verifySite = dependencies.verifySite ?? verifyNetlifySite;
  await verifySite(context, dependencies.fetch ?? fetch);

  const log = dependencies.log ?? console.log;
  const read = dependencies.readCatalog ?? readCatalog;
  const initialize = dependencies.initializeCatalogFromLegacy ?? initializeCatalogFromLegacy;
  const loadData = dependencies.loadLegacyData ?? loadLegacyData;

  log(`Environment: ${CATALOG_TARGET.environment}`);
  log(`Store: ${CATALOG_TARGET.store}`);
  log(`Key: ${CATALOG_TARGET.key}`);
  await readExpectedAbsence(read);

  let legacyData;
  let preparedCatalog;
  try {
    legacyData = await loadData();
    preparedCatalog = prepareInitialCatalogFromLegacy(legacyData);
    validateExpectedCatalog(preparedCatalog, legacyData);
  } catch (error) {
    if (error instanceof CatalogOperatorError) throw error;
    fail("INITIAL_CATALOG_INVALID", "Initial catalog data failed validation.");
  }

  log("Catalog key is absent; the prepared data passed validation.");
  printSummary(preparedCatalog, log);
  if (!apply) {
    log("Simulation only. No catalog data was written.");
    return { status: "simulation", catalog: preparedCatalog };
  }

  const prompt = dependencies.prompt ?? askForConfirmation;
  if (await prompt() !== EXPECTED_CONFIRMATION) {
    log("Initialization cancelled. No catalog data was written.");
    return { status: "cancelled" };
  }

  let initialized;
  try {
    initialized = await initialize(legacyData);
  } catch (error) {
    if (
      error instanceof CatalogStorageError &&
      error.code === "CATALOG_ALREADY_EXISTS"
    ) {
      fail("CATALOG_ALREADY_EXISTS", "A catalog already exists; initialization stopped.");
    }
    let reread;
    try {
      reread = await read();
    } catch {
      fail("WRITE_OUTCOME_UNCERTAIN", "Write outcome is uncertain; reread could not confirm the catalog.");
    }
    if (!sameExpectedProducts(reread.catalog, legacyData)) {
      fail("WRITE_OUTCOME_UNCERTAIN", "Write outcome is uncertain; reread did not find the expected catalog.");
    }
    log(`Write outcome is uncertain, but the expected catalog is present. ETag: ${reread.etag}`);
    fail("WRITE_OUTCOME_UNCERTAIN", "Do not retry; inspect the catalog and ETag manually.");
  }

  let reread;
  try {
    reread = await read();
    verifyWrittenCatalog(reread, legacyData, initialized.etag);
  } catch (error) {
    if (error instanceof CatalogOperatorError) throw error;
    fail("POST_WRITE_VERIFICATION_FAILED", "Catalog was written but post-write verification failed.");
  }

  if (initialized.etag) log(`Initialization verified. ETag: ${initialized.etag}`);
  else log("Initialization verified. The storage SDK did not return an ETag.");
  return { status: "initialized", catalog: reread.catalog, etag: initialized.etag };
}

const SAFE_ERROR_MESSAGES = new Map([
  ["BLOBS_CONTEXT_REQUIRED", "Netlify Blobs context is required."],
  ["BLOBS_CONTEXT_INVALID", "Netlify Blobs context is invalid."],
  ["WRONG_ENVIRONMENT", "CONTEXT must explicitly be production."],
  ["SITE_LOOKUP_FAILED", "Could not verify the Netlify site identity."],
  ["SITE_IDENTITY_MISMATCH", "The Netlify site does not match PGD Market."],
  ["CATALOG_NOT_FOUND", "Catalog has not been initialized."],
  ["CATALOG_ALREADY_EXISTS", "A catalog already exists; initialization stopped."],
  ["CATALOG_CORRUPT", "Stored catalog is corrupt; initialization stopped."],
  ["CATALOG_UNAVAILABLE", "Catalog storage is unavailable; initialization stopped."],
  ["WRITE_OUTCOME_UNCERTAIN", "Write outcome is uncertain; do not retry automatically."]
]);

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCatalogInitialization({ argv: process.argv.slice(2) }).catch((error) => {
    const message = SAFE_ERROR_MESSAGES.get(error?.code) ??
      (error instanceof CatalogOperatorError
        ? error.message
        : "Catalog initialization stopped due to an internal error.");
    console.error(`Initialization stopped [${error?.code ?? "INTERNAL_ERROR"}]: ${message}`);
    process.exitCode = 1;
  });
}
