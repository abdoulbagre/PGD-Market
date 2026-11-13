import assert from "node:assert/strict";
import test from "node:test";
import { AuthAccessError } from "../backend/functions/_auth.mjs";
import { createChariowAdminHandler } from "../backend/functions/chariow-admin.mjs";

const API_KEY = "server-only-admin-key";

const makeRequest = (query, method = "GET") =>
  new Request(`https://shop.example/.netlify/functions/chariow-admin?${query}`, { method });

const createHandler = ({ authorizeAdmin, fetchImpl, env, timeoutMs = 200 } = {}) => {
  const calls = [];
  const handler = createChariowAdminHandler({
    authorizeAdmin: authorizeAdmin || (async () => ({ id: "admin", roles: ["admin"] })),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return fetchImpl
        ? fetchImpl(url, options)
        : Response.json({ data: { name: "PGD Chariow", status: "active" } });
    },
    env: env || { CHARIOW_ADMIN_API_KEY: API_KEY },
    timeoutMs
  });
  return { handler, calls };
};

test("store requests require an Admin and only return allowlisted Chariow data", async () => {
  const fixture = createHandler({
    fetchImpl: async () => Response.json({
      data: {
        id: "store_abc",
        name: "PGD Market",
        url: "https://shop.chariow.com",
        status: "active",
        stats: { total_customers: 3, ratings: { total_ratings: 2 } },
        api_key: API_KEY
      }
    })
  });
  const response = await fixture.handler(makeRequest("resource=store"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, {
    id: "store_abc",
    name: "PGD Market",
    url: "https://shop.chariow.com",
    status: "active",
    stats: { total_customers: 3, ratings: { total_ratings: 2 } }
  });
  assert.equal(fixture.calls[0].url, "https://api.chariow.com/v1/store");
  assert.equal(fixture.calls[0].options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(JSON.stringify(body).includes(API_KEY), false);
});

test("product list pagination and search are validated and proxied to the documented route", async () => {
  const fixture = createHandler({
    fetchImpl: async () => Response.json({
      data: [{
        id: "prd_abc123",
        name: "Cours",
        status: "published",
        type: "course",
        pricing: {
          current_price: {
            value: 12,
            formatted: "$12.00",
            currency: "USD",
            api_key: API_KEY
          }
        },
        secret: "not forwarded"
      }],
      pagination: {
        count: 1,
        per_page: 100,
        next_cursor: "next",
        prev_cursor: null,
        has_more_pages: true,
        has_pages: true
      }
    })
  });
  const response = await fixture.handler(makeRequest(
    "resource=products&per_page=100&cursor=previous&search=marketing"
  ));
  const body = await response.json();
  const requestedUrl = new URL(fixture.calls[0].url);

  assert.equal(response.status, 200);
  assert.equal(requestedUrl.pathname, "/v1/products");
  assert.equal(requestedUrl.searchParams.get("per_page"), "100");
  assert.equal(requestedUrl.searchParams.get("cursor"), "previous");
  assert.equal(requestedUrl.searchParams.get("search"), "marketing");
  assert.equal(body.data[0].secret, undefined);
  assert.equal(body.data[0].pricing.current_price.api_key, undefined);
  assert.equal(body.pagination.has_more_pages, true);

  const invalid = await fixture.handler(makeRequest("resource=products&per_page=101"));
  assert.equal(invalid.status, 400);
  const duplicate = await fixture.handler(makeRequest("resource=store&resource=products"));
  assert.equal(duplicate.status, 400);
  assert.equal(fixture.calls.length, 1);
});

test("product detail uses an ID-only path and non-GET operations are rejected", async () => {
  const fixture = createHandler({
    fetchImpl: async () => Response.json({
      data: { id: "prd_one", name: "Produit", status: "draft" }
    })
  });
  const detail = await fixture.handler(makeRequest("resource=product&productId=prd_one"));
  assert.equal(detail.status, 200);
  assert.equal(fixture.calls[0].url, "https://api.chariow.com/v1/products/prd_one");

  const mutation = await fixture.handler(makeRequest("resource=store", "POST"));
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get("allow"), "GET");
  assert.equal(fixture.calls.length, 1);

  const invalidId = await fixture.handler(makeRequest("resource=product&productId=prd_one%2F..%2Fstore"));
  assert.equal(invalidId.status, 400);
  assert.equal(fixture.calls.length, 1);
});

test("sales list proxies documented pagination and search with a minimal response projection", async () => {
  const fixture = createHandler({
    fetchImpl: async () => Response.json({
      data: [{
        id: "sal_abc123",
        status: "completed",
        amount: {
          value: 12.5,
          formatted: "€12.50",
          currency: "EUR",
          api_key: API_KEY
        },
        original_amount: { value: 15, formatted: "€15.00", currency: "EUR" },
        discount_amount: { value: 2.5, formatted: "€2.50", currency: "EUR" },
        created_at: "2025-01-02T03:04:05Z",
        completed_at: "2025-01-02T03:05:05Z",
        product: { id: "prd_course", name: "Cours", slug: "cours", secret: API_KEY },
        payment: { status: "success", transaction_id: "txn-private" },
        customer: { email: "private@example.com" },
        shipping: { address: "private address" },
        invoice_download_url: "https://private.example/invoice",
        context: { ip_address: "192.0.2.1" },
        tracking: { value: 12.5 },
        custom_fields_values: { private: "data" }
      }],
      pagination: {
        count: 1,
        per_page: 20,
        next_cursor: "next-page",
        prev_cursor: null,
        has_more_pages: true,
        has_pages: true,
        next_page_url: "https://api.chariow.com/private"
      }
    })
  });
  const response = await fixture.handler(makeRequest(
    "resource=sales&per_page=20&cursor=previous-page&search=sal_abc123"
  ));
  const body = await response.json();
  const requestedUrl = new URL(fixture.calls[0].url);

  assert.equal(response.status, 200);
  assert.equal(requestedUrl.pathname, "/v1/sales");
  assert.equal(requestedUrl.searchParams.get("per_page"), "20");
  assert.equal(requestedUrl.searchParams.get("cursor"), "previous-page");
  assert.equal(requestedUrl.searchParams.get("search"), "sal_abc123");
  assert.deepEqual(body.data[0], {
    id: "sal_abc123",
    status: "completed",
    created_at: "2025-01-02T03:04:05Z",
    completed_at: "2025-01-02T03:05:05Z",
    amount: { value: 12.5, formatted: "€12.50", currency: "EUR" },
    original_amount: { value: 15, formatted: "€15.00", currency: "EUR" },
    discount_amount: { value: 2.5, formatted: "€2.50", currency: "EUR" },
    product: { id: "prd_course", name: "Cours" },
    payment: { status: "success" }
  });
  assert.deepEqual(body.pagination, {
    count: 1,
    per_page: 20,
    next_cursor: "next-page",
    prev_cursor: null,
    has_more_pages: true,
    has_pages: true
  });
  assert.equal(JSON.stringify(body).includes(API_KEY), false);
  assert.equal(JSON.stringify(body).includes("private@example.com"), false);
  assert.equal(JSON.stringify(body).includes("192.0.2.1"), false);
  assert.equal(JSON.stringify(body).includes("invoice"), false);
});

test("sale detail uses a validated public ID and excludes private sale fields", async () => {
  const fixture = createHandler({
    fetchImpl: async () => Response.json({
      data: {
        id: "sal_xyz987",
        status: "awaiting_payment",
        amount: { value: 20, formatted: "$20.00", currency: "USD" },
        created_at: "2025-02-01T10:00:00Z",
        completed_at: null,
        product: { id: "prd_book", name: "Guide" },
        payment: { status: "pending", transaction_id: "private-transaction" },
        customer: { email: "private@example.com" },
        buyer: { first_name: "Private" },
        shipping: { address: "private address" },
        invoice_download_url: "https://private.example/invoice",
        context: { ip_address: "192.0.2.2" }
      }
    })
  });
  const response = await fixture.handler(makeRequest("resource=sale&saleId=sal_xyz987"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(fixture.calls[0].url, "https://api.chariow.com/v1/sales/sal_xyz987");
  assert.deepEqual(body.data, {
    id: "sal_xyz987",
    status: "awaiting_payment",
    created_at: "2025-02-01T10:00:00Z",
    completed_at: null,
    amount: { value: 20, formatted: "$20.00", currency: "USD" },
    product: { id: "prd_book", name: "Guide" },
    payment: { status: "pending" }
  });
  assert.equal(JSON.stringify(body).includes("private@example.com"), false);
  assert.equal(JSON.stringify(body).includes("private-transaction"), false);
  assert.equal(JSON.stringify(body).includes("invoice"), false);
  assert.equal(JSON.stringify(body).includes("192.0.2.2"), false);
});

test("sales pagination and identifiers reject invalid parameters without upstream calls", async () => {
  const fixture = createHandler();
  const requests = [
    "resource=sales&per_page=101",
    "resource=sales&per_page=0",
    "resource=sales&cursor=%0A",
    `resource=sales&search=${"x".repeat(256)}`,
    "resource=sales&status=completed",
    "resource=sale&saleId=sal_one%2F..%2Fstore",
    "resource=sale&saleId=not-a-sale-id"
  ];

  for (const query of requests) {
    assert.equal((await fixture.handler(makeRequest(query))).status, 400);
  }
  assert.equal(fixture.calls.length, 0);

  const mutation = await fixture.handler(makeRequest(
    "resource=sale&saleId=sal_abc123",
    "POST"
  ));
  assert.equal(mutation.status, 405);
  assert.equal(fixture.calls.length, 0);
});

test("sale not-found errors are sanitized", async () => {
  const fixture = createHandler({
    fetchImpl: async () => new Response(null, { status: 404 })
  });
  const response = await fixture.handler(makeRequest("resource=sale&saleId=sal_missing"));
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error, "CHARIOW_SALE_NOT_FOUND");
  assert.equal(JSON.stringify(body).includes(API_KEY), false);
});

test("anonymous users and members cannot call the Chariow proxy", async () => {
  const anonymous = createHandler({
    authorizeAdmin: async () => {
      throw new AuthAccessError(401, "AUTHENTICATION_REQUIRED");
    }
  });
  const member = createHandler({
    authorizeAdmin: async () => {
      throw new AuthAccessError(403, "ADMIN_ROLE_REQUIRED");
    }
  });

  assert.equal((await anonymous.handler(makeRequest("resource=store"))).status, 401);
  assert.equal((await anonymous.handler(makeRequest("resource=sales"))).status, 401);
  assert.equal((await member.handler(makeRequest("resource=store"))).status, 403);
  assert.equal((await member.handler(makeRequest("resource=sale&saleId=sal_abc123"))).status, 403);
  assert.equal(anonymous.calls.length, 0);
  assert.equal(member.calls.length, 0);
});

test("API key configuration errors and upstream auth/rate/server failures stay sanitized", async () => {
  const missingKey = createHandler({ env: {} });
  const missingResponse = await missingKey.handler(makeRequest("resource=store"));
  assert.equal(missingResponse.status, 503);
  assert.equal(missingKey.calls.length, 0);

  for (const [upstreamStatus, expectedStatus, expectedCode] of [
    [401, 503, "CHARIOW_CREDENTIAL_INVALID"],
    [403, 503, "CHARIOW_SCOPE_MISSING"],
    [429, 429, "CHARIOW_RATE_LIMITED"],
    [500, 502, "CHARIOW_UNAVAILABLE"]
  ]) {
    const fixture = createHandler({
      fetchImpl: async () => new Response(
        JSON.stringify({ message: `sensitive detail ${API_KEY}` }),
        {
          status: upstreamStatus,
          headers: upstreamStatus === 429 ? { "Retry-After": "30" } : {}
        }
      )
    });
    const response = await fixture.handler(makeRequest("resource=store"));
    const body = await response.json();
    assert.equal(response.status, expectedStatus);
    assert.equal(body.error, expectedCode);
    assert.equal(JSON.stringify(body).includes(API_KEY), false);
    if (upstreamStatus === 429) assert.equal(response.headers.get("retry-after"), "30");
  }
});

test("timeouts and malformed API responses produce explicit errors", async () => {
  const timeout = createHandler({
    fetchImpl: async () => {
      const error = new Error("timeout");
      error.name = "AbortError";
      throw error;
    }
  });
  assert.equal((await timeout.handler(makeRequest("resource=store"))).status, 504);

  const bodyTimeout = createHandler({
    timeoutMs: 25,
    fetchImpl: async (url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => {
          const error = new Error("body timeout");
          error.name = "AbortError";
          controller.error(error);
        }, { once: true });
      }
    }), { headers: { "Content-Type": "application/json" } })
  });
  const bodyTimeoutResponse = await bodyTimeout.handler(makeRequest("resource=sales"));
  assert.equal(bodyTimeoutResponse.status, 504);
  assert.equal((await bodyTimeoutResponse.json()).error, "CHARIOW_TIMEOUT");

  const malformed = createHandler({
    fetchImpl: async () => Response.json({ data: [] })
  });
  const malformedResponse = await malformed.handler(makeRequest("resource=store"));
  assert.equal(malformedResponse.status, 502);
  assert.equal((await malformedResponse.json()).error, "CHARIOW_INVALID_RESPONSE");

  const malformedPagination = createHandler({
    fetchImpl: async () => Response.json({
      data: [],
      pagination: {
        count: 0,
        per_page: 20,
        next_cursor: { api_key: API_KEY },
        prev_cursor: null,
        has_more_pages: true
      }
    })
  });
  const paginationResponse = await malformedPagination.handler(makeRequest("resource=products"));
  assert.equal(paginationResponse.status, 502);
  assert.equal((await paginationResponse.json()).error, "CHARIOW_INVALID_RESPONSE");
});
