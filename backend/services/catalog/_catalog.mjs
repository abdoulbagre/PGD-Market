import { getStore } from "@netlify/blobs";
import {
  RATINGS_SCHEMA_VERSION,
  validateChariowProductId,
  validateRating,
  validateRatings
} from "./_ratings-model.mjs";

export const RATINGS_STORE_NAME = "ratings-v1";
export const RATINGS_KEY = "ratings-v1";
export const EMPTY_RATINGS_ETAG = "ratings-empty";

export class CatalogStorageError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "CatalogStorageError";
    this.code = code;
    this.status = status;
  }
}

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const catalogStorageFailure = (operation, key, error) => {
  const errorName = typeof error?.name === "string" &&
      /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name
    : "UnknownError";
  const errorCode = typeof error?.code === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
    ? error.code
    : undefined;
  const status = [
    error?.status,
    error?.statusCode,
    error?.response?.status
  ].find((candidate) =>
    Number.isInteger(candidate) && candidate >= 100 && candidate <= 599
  );
  const details = [
    `operation=${operation}`,
    `key=${key}`,
    `error=${errorName}`,
    ...(errorCode ? [`code=${errorCode}`] : []),
    ...(status === undefined ? [] : [`status=${status}`])
  ].join(" ");

  console.error(`Netlify Blobs PGD ratings operation failed. ${details}`);

  if (errorName === "MissingBlobsEnvironmentError") {
    return new CatalogStorageError(
      "RATINGS_CONFIGURATION_MISSING",
      503,
      "Netlify Blobs is not configured for PGD ratings."
    );
  }
  if (status === 401 || status === 403) {
    return new CatalogStorageError(
      "RATINGS_ACCESS_DENIED",
      503,
      "Netlify Blobs denied access to PGD ratings."
    );
  }
  return new CatalogStorageError(
    "RATINGS_UNAVAILABLE",
    503,
    "PGD ratings storage is unavailable."
  );
};

const getRatingsStore = () => {
  try {
    return getStore(RATINGS_STORE_NAME);
  } catch (error) {
    throw catalogStorageFailure("create-store", RATINGS_STORE_NAME, error);
  }
};

const ratingsMetadata = (record) => ({
  schemaVersion: RATINGS_SCHEMA_VERSION,
  updatedAt: record.updatedAt
});

export function createRatingsRecord(ratings = {}, { now = new Date().toISOString() } = {}) {
  validateRatings(ratings);
  return {
    schemaVersion: RATINGS_SCHEMA_VERSION,
    updatedAt: now,
    ratings: { ...ratings }
  };
}

const validateRatingsRecord = (record) => {
  if (
    !isRecord(record) ||
    Object.keys(record).some((key) => !["schemaVersion", "updatedAt", "ratings"].includes(key)) ||
    record.schemaVersion !== RATINGS_SCHEMA_VERSION ||
    typeof record.updatedAt !== "string" ||
    Number.isNaN(Date.parse(record.updatedAt)) ||
    new Date(record.updatedAt).toISOString() !== record.updatedAt
  ) {
    throw new CatalogStorageError("RATINGS_INVALID", 500, "Stored PGD ratings are invalid.");
  }

  try {
    validateRatings(record.ratings);
  } catch {
    throw new CatalogStorageError("RATINGS_INVALID", 500, "Stored PGD ratings are invalid.");
  }

  return {
    schemaVersion: RATINGS_SCHEMA_VERSION,
    updatedAt: record.updatedAt,
    ratings: { ...record.ratings }
  };
};

const readBlobEntry = async (store, key) => {
  let entry;
  try {
    entry = await store.getWithMetadata(key, {
      type: "text"
    });
  } catch (error) {
    throw catalogStorageFailure("read", key, error);
  }

  if (entry === null) return null;

  let value;
  try {
    value = JSON.parse(entry.data);
  } catch {
    throw new CatalogStorageError(
      "RATINGS_CORRUPT",
      503,
      "Stored PGD ratings data is not valid JSON."
    );
  }

  if (typeof entry.etag !== "string" || entry.etag.length === 0) {
    throw new CatalogStorageError(
      "RATINGS_CORRUPT",
      503,
      "Stored PGD ratings data has no version identifier."
    );
  }

  return { value, etag: entry.etag, metadata: entry.metadata };
};

export async function readRatings({ store } = {}) {
  const blobStore = store ?? getRatingsStore();
  const currentEntry = await readBlobEntry(blobStore, RATINGS_KEY);

  if (!currentEntry) {
    return {
      schemaVersion: RATINGS_SCHEMA_VERSION,
      updatedAt: null,
      ratings: {},
      etag: EMPTY_RATINGS_ETAG,
      initialized: false,
      source: "empty"
    };
  }

  const record = validateRatingsRecord(currentEntry.value);
  if (
    currentEntry.metadata?.schemaVersion !== undefined &&
    currentEntry.metadata.schemaVersion !== record.schemaVersion
  ) {
    throw new CatalogStorageError(
      "RATINGS_CORRUPT",
      503,
      "PGD ratings metadata does not match the stored data."
    );
  }

  return {
    ...record,
    etag: currentEntry.etag,
    initialized: true,
    source: "ratings"
  };
}

const requireEtag = (etag) => {
  if (typeof etag !== "string" || etag.length === 0) {
    throw new CatalogStorageError(
      "ETAG_REQUIRED",
      428,
      "The current ratings ETag is required."
    );
  }
};

export async function writeRating(productId, rating, { etag, store, now = new Date().toISOString() } = {}) {
  try {
    validateChariowProductId(productId);
    validateRating(rating);
  } catch (error) {
    throw new CatalogStorageError(error.code || "INVALID_RATING", 400, error.message);
  }
  requireEtag(etag);

  const blobStore = store ?? getRatingsStore();
  const current = await readBlobEntry(blobStore, RATINGS_KEY);
  const creating = current === null;
  if (
    (creating && etag !== EMPTY_RATINGS_ETAG) ||
    (!creating && current.etag !== etag)
  ) {
    throw new CatalogStorageError(
      "RATINGS_CONFLICT",
      412,
      "PGD ratings changed since they were read."
    );
  }
  const record = current
    ? validateRatingsRecord(current.value)
    : { ratings: {} };

  const nextRecord = createRatingsRecord(
    { ...record.ratings, [productId]: rating },
    { now }
  );
  let result;
  try {
    result = await blobStore.setJSON(RATINGS_KEY, nextRecord, {
      ...(creating ? { onlyIfNew: true } : { onlyIfMatch: etag }),
      metadata: ratingsMetadata(nextRecord)
    });
  } catch (error) {
    throw catalogStorageFailure("write", RATINGS_KEY, error);
  }

  if (!result.modified) {
    throw new CatalogStorageError(
      "RATINGS_CONFLICT",
      412,
      "PGD ratings changed since they were read."
    );
  }
  if (typeof result.etag !== "string" || result.etag.length === 0) {
    throw new CatalogStorageError(
      "RATINGS_WRITE_UNCONFIRMED",
      503,
      "PGD rating could not be confirmed."
    );
  }

  return {
    ...nextRecord,
    etag: result.etag,
    initialized: true,
    source: "ratings"
  };
}
