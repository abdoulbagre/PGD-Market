import assert from "node:assert/strict";
import test from "node:test";
import {
  CHARIOW_PRODUCT_ID_PATTERN,
  validateChariowProductId,
  validateRating,
  validateRatings
} from "../backend/services/catalog/_ratings-model.mjs";
import {
  CatalogStorageError,
  EMPTY_RATINGS_ETAG,
  RATINGS_KEY,
  createRatingsRecord,
  readRatings,
  writeRating
} from "../backend/services/catalog/_catalog.mjs";

const firstId = "prd_product_one";
const secondId = "prd_product_two";

function createMemoryStore(initial = {}) {
  const blobs = new Map(
    Object.entries(initial).map(([key, value]) => [
      key,
      { value: structuredClone(value), metadata: {}, etag: "stored-etag" }
    ])
  );
  const reads = [];
  const writes = [];
  let revision = 0;

  return {
    blobs,
    reads,
    writes,
    async getWithMetadata(key, options) {
      reads.push({ key, options });
      const entry = blobs.get(key);
      return entry
        ? {
            data: JSON.stringify(entry.value),
            metadata: entry.metadata,
            etag: entry.etag
          }
        : null;
    },
    async setJSON(key, value, options = {}) {
      writes.push({ key, options: structuredClone(options) });
      const current = blobs.get(key);
      if (options.onlyIfNew && current) return { modified: false };
      if (options.onlyIfMatch && current?.etag !== options.onlyIfMatch) {
        return { modified: false };
      }
      const etag = `etag-${++revision}`;
      blobs.set(key, {
        value: structuredClone(value),
        metadata: structuredClone(options.metadata || {}),
        etag
      });
      return { modified: true, etag };
    }
  };
}

test("ratings accept only Chariow IDs and integer values from zero to five", () => {
  assert.match(firstId, CHARIOW_PRODUCT_ID_PATTERN);
  assert.equal(validateChariowProductId(firstId), firstId);
  assert.equal(validateRating(0), 0);
  assert.equal(validateRating(5), 5);
  assert.deepEqual(validateRatings({ [firstId]: 0, [secondId]: 5 }), {
    [firstId]: 0,
    [secondId]: 5
  });

  assert.throws(() => validateChariowProductId("local-product-ref"), {
    code: "INVALID_CHARIOW_PRODUCT_ID"
  });
  assert.throws(() => validateRating(2.5), { code: "INVALID_RATING" });
  assert.throws(() => validateRating(6), { code: "INVALID_RATING" });
  assert.throws(() => validateRatings({ arbitrary: 4 }), {
    code: "INVALID_CHARIOW_PRODUCT_ID"
  });
});

test("missing ratings are empty and reading does not write to Blobs", async () => {
  const store = createMemoryStore();
  const ratings = await readRatings({ store });

  assert.deepEqual(ratings.ratings, {});
  assert.equal(ratings.initialized, false);
  assert.equal(ratings.source, "empty");
  assert.equal(ratings.etag, EMPTY_RATINGS_ETAG);
  assert.deepEqual(store.reads.map(({ key }) => key), [RATINGS_KEY]);
  assert.deepEqual(store.reads[0].options, { type: "text" });
  assert.equal(store.writes.length, 0);
  assert.equal(store.blobs.size, 0);
});

test("valid ratings are read from the ratings record by Chariow ID", async () => {
  const record = createRatingsRecord(
    { [firstId]: 4 },
    { now: "2026-03-01T10:00:00.000Z" }
  );
  const store = createMemoryStore({ [RATINGS_KEY]: record });
  const ratings = await readRatings({ store });

  assert.deepEqual(ratings.ratings, { [firstId]: 4 });
  assert.equal(ratings.initialized, true);
  assert.equal(ratings.source, "ratings");
  assert.equal(ratings.etag, "stored-etag");
  assert.deepEqual(store.reads.map(({ key }) => key), [RATINGS_KEY]);
  assert.deepEqual(store.reads[0].options, { type: "text" });
});

test("the first rating creates the ratings record conditionally", async () => {
  const store = createMemoryStore();
  const snapshot = await readRatings({ store });
  const saved = await writeRating(firstId, 5, {
    store,
    etag: snapshot.etag,
    now: "2026-03-01T10:01:00.000Z"
  });

  assert.deepEqual(saved.ratings, { [firstId]: 5 });
  assert.equal(saved.initialized, true);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].key, RATINGS_KEY);
  assert.equal(store.writes[0].options.onlyIfNew, true);
  assert.equal(store.writes[0].options.onlyIfMatch, undefined);
  assert.deepEqual([...store.blobs.keys()], [RATINGS_KEY]);
});

test("a successful conditional write does not depend on immediate read visibility", async () => {
  const store = createMemoryStore();
  const getWithMetadata = store.getWithMetadata.bind(store);
  const setJSON = store.setJSON.bind(store);
  let writeCompleted = false;
  store.getWithMetadata = async (...args) =>
    writeCompleted ? null : getWithMetadata(...args);
  store.setJSON = async (...args) => {
    const result = await setJSON(...args);
    writeCompleted = true;
    return result;
  };

  const snapshot = await readRatings({ store });
  const saved = await writeRating(firstId, 5, {
    store,
    etag: snapshot.etag
  });

  assert.deepEqual(saved.ratings, { [firstId]: 5 });
  assert.equal(saved.etag, store.blobs.get(RATINGS_KEY).etag);
  assert.equal(store.reads.length, 2);
  assert.equal(store.writes[0].options.onlyIfNew, true);
});

test("first-write ETags prevent stale or concurrent ratings writes", async () => {
  const store = createMemoryStore();
  const snapshot = await readRatings({ store });

  await assert.rejects(
    writeRating(firstId, 3, { store, etag: "stale-empty" }),
    { code: "RATINGS_CONFLICT" }
  );
  const saved = await writeRating(firstId, 3, {
    store,
    etag: snapshot.etag
  });
  await assert.rejects(
    writeRating(secondId, 4, { store, etag: snapshot.etag }),
    { code: "RATINGS_CONFLICT" }
  );
  assert.equal(store.writes.length, 1);

  const updated = await writeRating(firstId, 0, {
    store,
    etag: saved.etag
  });
  assert.equal(updated.ratings[firstId], 0);
  assert.equal(store.writes[1].options.onlyIfMatch, saved.etag);
});

test("stored ratings are rejected when their record is invalid", async () => {
  const store = createMemoryStore({
    [RATINGS_KEY]: {
      schemaVersion: 1,
      updatedAt: "2026-03-01T10:00:00.000Z",
      ratings: { arbitrary: 4 }
    }
  });

  await assert.rejects(readRatings({ store }), {
    code: "RATINGS_INVALID"
  });
});

test("inaccessible Blobs storage remains identifiable without logging secrets", async () => {
  const logs = [];
  const originalError = console.error;
  const store = {
    async getWithMetadata() {
      const error = new Error("token=do-not-log");
      error.name = "BlobsInternalError";
      error.status = 403;
      throw error;
    }
  };
  console.error = (...args) => logs.push(args);
  try {
    await assert.rejects(readRatings({ store }), (error) => {
      assert.ok(error instanceof CatalogStorageError);
      assert.equal(error.code, "RATINGS_ACCESS_DENIED");
      return true;
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(logs[0].length, 1);
  assert.match(logs[0][0], /operation=read key=ratings-v1 error=BlobsInternalError status=403/);
  assert.doesNotMatch(JSON.stringify(logs), /do-not-log|token=/i);
});

test("unexpected Blobs errors retain a sanitized type and remain errors", async () => {
  const logs = [];
  const originalError = console.error;
  const store = {
    async getWithMetadata() {
      const error = new Error("private transport detail");
      error.name = "StoreTransportFailure";
      error.statusCode = 502;
      error.code = "ERR_BLOBS_READ";
      throw error;
    }
  };
  console.error = (...args) => logs.push(args);
  try {
    await assert.rejects(readRatings({ store }), {
      code: "RATINGS_UNAVAILABLE"
    });
  } finally {
    console.error = originalError;
  }

  assert.match(
    logs[0][0],
    /error=StoreTransportFailure code=ERR_BLOBS_READ status=502/
  );
  assert.doesNotMatch(JSON.stringify(logs), /private transport detail/i);
});
