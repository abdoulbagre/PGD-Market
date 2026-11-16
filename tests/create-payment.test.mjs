import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPaymentHandler } = require("../backend/functions/create-payment.js");

const product = (overrides = {}) => ({
  id: "prd_server_product",
  name: "Produit FR",
  description: "Description FR",
  type: "downloadable",
  status: "published",
  is_free: false,
  has_variant_pricing: false,
  pricing: {
    type: "one_time",
    current_price: { value: 4200, currency: "XOF" }
  },
  quantity: null,
  ...overrides
});

const event = (overrides = {}) => ({
  httpMethod: "POST",
  body: JSON.stringify({
    first_name: "Client",
    last_name: "Exemple",
    email: "client@example.com",
    phone: { number: "+226 70 12 34 56", country_code: "BF" },
    product_id: product().id,
    ...overrides
  })
});

const createHandler = ({
  chariowProduct = product(),
  productError,
  checkoutResponse,
  checkoutStatus = 200,
  fetchImpl,
  timeoutMs
} = {}) => {
  const productRequests = [];
  const checkoutRequests = [];
  const handler = createPaymentHandler({
    productReader: async (options) => {
      productRequests.push(options);
      if (productError) throw productError;
      return chariowProduct;
    },
    fetchImpl: async (url, options) => {
      checkoutRequests.push({ url, options });
      if (fetchImpl) return fetchImpl(url, options);
      return new Response(JSON.stringify(checkoutResponse || {
        data: {
          step: "payment",
          payment: { checkout_url: "https://checkout.chariow.com/session" }
        }
      }), { status: checkoutStatus });
    },
    timeoutMs,
    env: {
      CHARIOW_ADMIN_API_KEY: "read-test-key",
      CHARIOW_API_KEY: "checkout-test-key",
      CHARIOW_API_BASE_URL: "https://chariow.invalid/v1",
      URL: "https://shop.example"
    }
  });
  return { handler, productRequests, checkoutRequests };
};

test("checkout validates a Chariow product server-side and sends only the required fields", async () => {
  const fixture = createHandler();
  const response = await fixture.handler(event());
  const body = JSON.parse(response.body);
  const request = fixture.checkoutRequests[0];
  const chariowPayload = JSON.parse(request.options.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body, {
    status: "payment",
    checkout_url: "https://checkout.chariow.com/session"
  });
  assert.equal(fixture.productRequests.length, 1);
  assert.equal(fixture.productRequests[0].productId, product().id);
  assert.equal(fixture.productRequests[0].apiKey, "read-test-key");
  assert.equal(request.url, "https://chariow.invalid/v1/checkout");
  assert.deepEqual(chariowPayload, {
    product_id: product().id,
    email: "client@example.com",
    first_name: "Client",
    last_name: "Exemple",
    phone: { number: "22670123456", country_code: "BF" }
  });
  assert.equal(Object.hasOwn(chariowPayload, "redirect_url"), false);
});

test("checkout rejects client prices and unrequested optional fields", async (t) => {
  for (const [label, extras] of [
    ["price", { price: 1 }],
    ["forced currency", { payment_currency: "EUR" }],
    ["custom metadata", { custom_metadata: { browser: true } }],
    ["phone extension", { phone: { number: "123456789", country_code: "BF", extension: "1" } }]
  ]) {
    await t.test(label, async () => {
      const fixture = createHandler();
      const response = await fixture.handler(event(extras));

      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).code, "INVALID_CHECKOUT_DATA");
      assert.equal(fixture.productRequests.length, 0);
      assert.equal(fixture.checkoutRequests.length, 0);
    });
  }
});

test("malformed and legacy PGD IDs are rejected before any API request", async (t) => {
  for (const id of ["not-a-chariow-id", "00000000-0000-4000-8000-000000000001"]) {
    await t.test(id, async () => {
      const fixture = createHandler();
      const response = await fixture.handler(event({ product_id: id }));

      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).code, "INVALID_CHECKOUT_DATA");
      assert.equal(fixture.productRequests.length, 0);
      assert.equal(fixture.checkoutRequests.length, 0);
    });
  }
});

test("unknown Chariow products are rejected without starting checkout", async () => {
  const fixture = createHandler({
    productError: Object.assign(new Error("not found"), {
      code: "CHARIOW_PRODUCT_NOT_FOUND",
      status: 404
    })
  });
  const response = await fixture.handler(event());

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).code, "PRODUCT_NOT_FOUND");
  assert.equal(fixture.checkoutRequests.length, 0);
});

test("the server rejects a product response that does not match the requested ID", async () => {
  const fixture = createHandler({
    chariowProduct: product({ id: "prd_different_product" })
  });
  const response = await fixture.handler(event());

  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.body).code, "CHARIOW_INVALID_RESPONSE");
  assert.equal(fixture.checkoutRequests.length, 0);
});

test("unpublished, unsupported, variant, free, or unpriced products fail closed", async (t) => {
  const invalidProducts = [
    { status: "draft" },
    { type: "service" },
    { type: "coaching" },
    { has_variant_pricing: true },
    { is_free: true },
    { pricing: { type: "one_time", effective: { value: 4200, currency: "XOF" } } },
    {
      pricing: {
        type: "one_time",
        current_price: { value: "4200", currency: "XOF" },
        effective: { value: 4200, currency: "XOF" }
      }
    },
    { pricing: { type: "free", current_price: { value: 0, currency: "XOF" } } },
    { pricing: { type: "what_you_want", current_price: { value: 5, currency: "XOF" } } },
    { pricing: { type: "one_time", current_price: { value: 0, currency: "XOF" } } },
    { quantity: { remaining: { value: 0 } } },
    { quantity: { remaining: 0 } },
    { quantity: { remaining: -1 } },
    { quantity: { remaining: { value: "2" } } }
  ];
  for (const [index, overrides] of invalidProducts.entries()) {
    await t.test(String(index), async () => {
      const fixture = createHandler({ chariowProduct: product(overrides) });
      const response = await fixture.handler(event());

      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).code, "PRODUCT_UNAVAILABLE");
      assert.equal(fixture.checkoutRequests.length, 0);
    });
  }
});

test("product lookup failures fail closed without contacting the checkout endpoint", async () => {
  const fixture = createHandler({
    productError: Object.assign(new Error("private upstream details"), {
      code: "CHARIOW_SCOPE_MISSING",
      status: 503
    })
  });
  const response = await fixture.handler(event());
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 503);
  assert.equal(body.code, "CHARIOW_READ_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(body), /private upstream details|read-test-key|checkout-test-key/);
  assert.equal(fixture.checkoutRequests.length, 0);
});

test("checkout treats Chariow completed and already-purchased states as non-payment results", async (t) => {
  await t.test("completed", async () => {
    const fixture = createHandler({
      checkoutResponse: { data: { step: "completed", purchase: { status: "completed" } } }
    });
    const response = await fixture.handler(event());

    assert.equal(response.statusCode, 409);
    assert.equal(JSON.parse(response.body).code, "ALREADY_PURCHASED");
  });

  await t.test("already purchased", async () => {
    const fixture = createHandler({
      checkoutResponse: {
        data: {
          step: "already_purchased",
          purchase: null,
          message: "You already own this product."
        }
      }
    });
    const response = await fixture.handler(event());
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 409);
    assert.equal(body.code, "ALREADY_PURCHASED");
    assert.match(body.error, /Chariow indique/);
  });
});

test("checkout rejects oversized requests and times out stalled Chariow responses", async (t) => {
  await t.test("oversized request", async () => {
    const fixture = createHandler();
    const response = await fixture.handler({
      ...event(),
      body: " ".repeat(8193)
    });

    assert.equal(response.statusCode, 413);
    assert.equal(JSON.parse(response.body).code, "REQUEST_TOO_LARGE");
    assert.equal(fixture.productRequests.length, 0);
    assert.equal(fixture.checkoutRequests.length, 0);
  });

  await t.test("timeout", async () => {
    const fixture = createHandler({
      timeoutMs: 5,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      })
    });
    const response = await fixture.handler(event());

    assert.equal(response.statusCode, 504);
    assert.equal(JSON.parse(response.body).code, "CHARIOW_TIMEOUT");
  });
});

test("checkout rejects unsafe hosted URLs and sanitizes upstream HTTP errors", async (t) => {
  await t.test("accepts the HTTPS host returned for Chariow's Orqex gateway", async () => {
    const fixture = createHandler({
      checkoutResponse: {
        data: {
          step: "payment",
          purchase: { id: "sal_test", status: "awaiting_payment" },
          payment: {
            checkout_url: "https://checkout.orqex.com/session/test",
            transaction_id: "txn_test",
            gateway: "orqex"
          }
        }
      }
    });
    const response = await fixture.handler(event());

    assert.equal(response.statusCode, 200);
    assert.equal(
      JSON.parse(response.body).checkout_url,
      "https://checkout.orqex.com/session/test"
    );
  });

  await t.test("unsafe URL", async () => {
    const fixture = createHandler({
      checkoutResponse: {
        data: { step: "payment", payment: { checkout_url: "https://attacker.example/session" } }
      }
    });
    const response = await fixture.handler(event());

    assert.equal(response.statusCode, 502);
    assert.equal(JSON.parse(response.body).code, "CHARIOW_INVALID_RESPONSE");
  });

  await t.test("does not trust an unlisted gateway or host", async (t) => {
    for (const [label, url, gateway] of [
      ["gateway mismatch", "https://checkout.orqex.com/session", "another-gateway"],
      ["non-HTTPS URL", "http://checkout.orqex.com/session", "orqex"],
      ["unlisted host", "https://payments.orqex.com/session", "orqex"]
    ]) {
      await t.test(label, async () => {
        const fixture = createHandler({
          checkoutResponse: {
            data: {
              step: "payment",
              payment: { checkout_url: url, gateway }
            }
          }
        });
        const response = await fixture.handler(event());

        assert.equal(response.statusCode, 502);
        assert.equal(JSON.parse(response.body).code, "CHARIOW_INVALID_RESPONSE");
      });
    }
  });

  await t.test("upstream error", async () => {
    const fixture = createHandler({
      checkoutResponse: { message: "sensitive upstream message" },
      checkoutStatus: 500
    });
    const response = await fixture.handler(event());
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 502);
    assert.equal(body.code, "CHARIOW_CHECKOUT_FAILED");
    assert.doesNotMatch(JSON.stringify(body), /sensitive upstream message/);
  });
});
