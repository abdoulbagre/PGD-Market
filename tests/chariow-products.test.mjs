import assert from "node:assert/strict";
import test from "node:test";
import {
  ChariowApiError,
  fetchChariowProduct,
  fetchChariowProducts,
  resolveChariowDiscount,
  resolveChariowPrice
} from "../backend/services/chariow/products.mjs";

const page = (data, hasMore, nextCursor = null) => new Response(JSON.stringify({
  data,
  pagination: {
    has_more_pages: hasMore,
    next_cursor: nextCursor
  }
}), {
  status: 200,
  headers: { "Content-Type": "application/json" }
});

test("price resolution accepts only a valid Chariow current_price", () => {
  assert.deepEqual(resolveChariowPrice({
    pricing: { current_price: { value: 4200.5, currency: "XOF" } }
  }), { value: 4200.5, currency: "XOF", originalValue: null });
  assert.deepEqual(resolveChariowPrice({
    pricing: {
      current_price: { value: 4200, currency: "XOF" },
      price: { value: 5000, currency: "XOF" },
      effective: { value: 3000, currency: "XOF" }
    }
  }), { value: 4200, currency: "XOF", originalValue: 5000 });
  assert.equal(resolveChariowPrice({
    pricing: { effective: { value: 4200, currency: "XOF" } }
  }), null);

  for (const originalPrice of [
    { value: 4200, currency: "XOF" },
    { value: 3000, currency: "XOF" },
    { value: 5000, currency: "EUR" },
    { value: "5000", currency: "XOF" },
    null
  ]) {
    assert.equal(resolveChariowPrice({
      pricing: {
        current_price: { value: 4200, currency: "XOF" },
        price: originalPrice
      }
    }).originalValue, null);
  }

  for (const currentPrice of [
    null,
    { value: 0, currency: "XOF" },
    { value: -1, currency: "XOF" },
    { value: "4200", currency: "XOF" },
    { value: Number.NaN, currency: "XOF" },
    { value: 4200, currency: "xof" },
    { value: 4200, currency: "XX" }
  ]) {
    assert.equal(resolveChariowPrice({
      pricing: {
        current_price: currentPrice,
        effective: { value: 4200, currency: "XOF" }
      }
    }), null);
  }
});

test("discount resolution preserves only a valid active Chariow price_off", () => {
  const product = (priceOff, pricingOverrides = {}) => ({
    pricing: {
      current_price: { value: 3000, currency: "XOF" },
      price: { value: 5000, currency: "XOF" },
      price_off: priceOff,
      ...pricingOverrides
    }
  });

  assert.equal(resolveChariowDiscount(product("40%")), "40%");
  assert.equal(resolveChariowDiscount(product("20%")), "20%");
  for (const priceOff of [null, "0%", "101%", "forty", 40, " 20%"]) {
    assert.equal(resolveChariowDiscount(product(priceOff)), null);
  }
  assert.equal(resolveChariowDiscount(product("40%", {
    price: { value: 3000, currency: "XOF" }
  })), null);
  assert.equal(resolveChariowDiscount(product("40%", {
    current_price: { value: 0, currency: "XOF" }
  })), null);
});

test("product fetch paginates with a bounded page size and server-side bearer key", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return calls.length === 1
      ? page([{ id: "prd_first" }], true, "next-page")
      : page([{ id: "prd_second" }], false);
  };
  const products = await fetchChariowProducts({
    apiKey: "  simulated-secret  ",
    fetchImpl
  });

  assert.deepEqual(products.map(({ id }) => id), ["prd_first", "prd_second"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.origin, "https://api.chariow.com");
  assert.equal(calls[0].url.pathname, "/v1/products");
  assert.equal(calls[0].url.searchParams.get("per_page"), "100");
  assert.equal(calls[0].url.searchParams.has("cursor"), false);
  assert.equal(calls[1].url.searchParams.get("cursor"), "next-page");
  assert.equal(calls[0].options.headers.Authorization, "Bearer simulated-secret");
  assert.equal(calls[0].options.method, "GET");
});

test("product fetch reports missing configuration without making a request", async () => {
  let calls = 0;
  await assert.rejects(
    fetchChariowProducts({
      apiKey: "",
      fetchImpl: async () => { calls += 1; }
    }),
    (error) => error instanceof ChariowApiError &&
      error.code === "CHARIOW_CONFIGURATION_MISSING" &&
      !error.message.includes("secret")
  );
  assert.equal(calls, 0);
});

test("single product fetch encodes and validates the Chariow public ID", async () => {
  let call;
  const product = await fetchChariowProduct({
    apiKey: "simulated-secret",
    productId: "prd_valid_123",
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return new Response(JSON.stringify({ data: { id: "prd_valid_123" } }), { status: 200 });
    }
  });

  assert.deepEqual(product, { id: "prd_valid_123" });
  assert.equal(call.url, "https://api.chariow.com/v1/products/prd_valid_123");
  assert.equal(call.options.headers.Authorization, "Bearer simulated-secret");
  await assert.rejects(
    fetchChariowProduct({
      apiKey: "simulated-secret",
      productId: "https://attacker.example",
      fetchImpl: async () => { throw new Error("must not be called"); }
    }),
    { code: "INVALID_CHARIOW_PRODUCT_ID" }
  );
});

test("product fetch sanitizes authentication, scope, rate-limit, and upstream errors", async (t) => {
  for (const [status, code, mappedStatus] of [
    [401, "CHARIOW_CREDENTIAL_INVALID", 503],
    [403, "CHARIOW_SCOPE_MISSING", 503],
    [429, "CHARIOW_RATE_LIMITED", 503],
    [500, "CHARIOW_UNAVAILABLE", 502]
  ]) {
    await t.test(String(status), async () => {
      await assert.rejects(
        fetchChariowProducts({
          apiKey: "simulated-secret",
          fetchImpl: async () => new Response("sensitive upstream response", { status })
        }),
        (error) => error instanceof ChariowApiError &&
          error.status === mappedStatus &&
          error.code === code &&
          !error.message.includes("sensitive upstream response") &&
          !error.message.includes("simulated-secret")
      );
    });
  }
});

test("product fetch rejects empty and repeating pagination cursors", async () => {
  await assert.rejects(
    fetchChariowProducts({
      apiKey: "simulated-secret",
      fetchImpl: async () => page([{ id: "prd_first" }], true, "")
    }),
    { code: "CHARIOW_INVALID_RESPONSE" }
  );

  let calls = 0;
  await assert.rejects(
    fetchChariowProducts({
      apiKey: "simulated-secret",
      fetchImpl: async () => {
        calls += 1;
        return page([{ id: "prd_first" }], true, calls === 1 ? "repeated" : "repeated");
      }
    }),
    { code: "CHARIOW_INVALID_RESPONSE" }
  );
  assert.equal(calls, 2);
});

test("product fetch enforces the request timeout", async () => {
  await assert.rejects(
    fetchChariowProducts({
      apiKey: "simulated-secret",
      timeoutMs: 1,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
    }),
    { code: "CHARIOW_TIMEOUT", status: 504 }
  );
});
