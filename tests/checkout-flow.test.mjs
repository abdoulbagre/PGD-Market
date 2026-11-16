import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPublicCatalogHandler } from "../backend/functions/public-catalog.mjs";

const require = createRequire(import.meta.url);
const { createPaymentHandler } = require("../backend/functions/create-payment.js");

const loadBrowserModule = async (path) => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
};

const { findCatalogProduct, isPublicProduct } = await loadBrowserModule(
  "../frontend/storefront/assets/js/catalog.js"
);

const API_BASE_URL = "https://checkout-api.invalid/v1";
const TEST_ENV = {
  CHARIOW_ADMIN_API_KEY: "read-test-key-not-a-secret",
  CHARIOW_API_KEY: "checkout-test-key-not-a-secret",
  CHARIOW_API_BASE_URL: API_BASE_URL,
  URL: "https://storefront.example"
};

const chariowProduct = (sourceProduct, overrides = {}) => ({
  id: sourceProduct.id,
  name: sourceProduct.name,
  description: "Description de test",
  type: "downloadable",
  status: "published",
  is_free: false,
  has_variant_pricing: false,
  category: { value: "guides", label: "Guides" },
  pictures: { cover: "https://cdn.chariow.com/products/test-cover.jpg" },
  pricing: {
    type: "fixed",
    current_price: { value: sourceProduct.price, currency: "XOF" }
  },
  quantity: null,
  ...overrides
});

const sourceProducts = [
  { id: "prd_product_one", name: "Guide one", price: 4200 },
  { id: "prd_product_two", name: "Guide two", price: 3000 }
].map((product) => chariowProduct(product));
const unavailableProduct = chariowProduct({
  id: "prd_unavailable_test",
  name: "Unavailable product",
  price: 3000
}, {
  status: "draft"
});

const createHarness = ({
  products = [...sourceProducts, unavailableProduct],
  checkoutResponse = {
    data: {
      step: "payment",
      payment: { checkout_url: "https://checkout.chariow.com/test-session" }
    }
  },
  checkoutStatus = 200,
  checkoutRawBody
} = {}) => {
  const requests = [];
  const productsById = new Map(products.map((product) => [product.id, product]));
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || "GET";
    requests.push({ url, method, options });

    if (method === "GET" && url.hostname === "api.chariow.com" && url.pathname.startsWith("/v1/products/")) {
      const productId = decodeURIComponent(url.pathname.slice("/v1/products/".length));
      const product = productsById.get(productId);
      return product
        ? new Response(JSON.stringify({ data: product }), { status: 200 })
        : new Response(JSON.stringify({ message: "private product lookup details" }), { status: 404 });
    }

    if (method === "POST" && url.href === `${API_BASE_URL}/checkout`) {
      const body = checkoutRawBody === undefined
        ? JSON.stringify(checkoutResponse)
        : checkoutRawBody;
      return new Response(body, { status: checkoutStatus });
    }

    throw new Error(`Unexpected mocked request: ${method} ${url.href}`);
  };
  const handler = createPaymentHandler({ fetchImpl, env: TEST_ENV });
  return { handler, requests };
};

const checkoutEvent = (overrides = {}) => ({
  httpMethod: "POST",
  body: JSON.stringify({
    first_name: "Camille",
    last_name: "Exemple",
    email: "camille@example.test",
    phone: { number: "+226 70 12 34 56", country_code: "BF" },
    product_id: sourceProducts[0].id,
    ...overrides
  })
});

test("public product IDs traverse the storefront into a server-validated Chariow checkout", async () => {
  const publicCatalog = createPublicCatalogHandler({
    connectBlobs: () => {},
    fetchProducts: async () => [...sourceProducts, unavailableProduct],
    readRatings: async () => ({ ratings: Object.fromEntries(
      sourceProducts.map((product) => [product.id, 0])
    ) })
  });
  const catalogResponse = await publicCatalog();
  const catalog = JSON.parse(catalogResponse.body);
  const currentIds = sourceProducts.map((product) => product.id);
  const app = await readFile(new URL("../frontend/storefront/assets/js/app.js", import.meta.url), "utf8");
  const checkoutPage = await readFile(new URL("../frontend/storefront/commande.html", import.meta.url), "utf8");

  assert.equal(catalogResponse.statusCode, 200);
  assert.deepEqual(catalog.products.map((product) => product.id), currentIds);
  assert.ok(catalog.products.every(isPublicProduct));
  assert.ok(catalog.products.every((product) => /^prd_[A-Za-z0-9_-]+$/.test(product.id)));
  assert.equal(catalog.products.some((product) => product.id === unavailableProduct.id), false);
  assert.match(app, /produit\.html\?id=\$\{encodeURIComponent\(product\.id\)\}/);
  assert.match(app, /commande\.html\?id=\$\{encodeURIComponent\(product\.id\)\}/);
  assert.match(app, /product_id: product\.id/);
  assert.match(app, /first_name: firstName/);
  assert.match(app, /last_name: lastName/);
  assert.doesNotMatch(app, /chariowProductId/);
  assert.doesNotMatch(app, /data\.status === "completed"|checkout\.completedNotice/);
  assert.ok(
    checkoutPage.indexOf('data-i18n="checkout.lastName"') <
      checkoutPage.indexOf('data-i18n="checkout.firstName"'),
    "last name field appears before first name field"
  );
  assert.match(checkoutPage, /id="first-name"[^>]*required/);
  assert.match(checkoutPage, /id="last-name"[^>]*required/);
  assert.match(checkoutPage, /id="email"[^>]*required/);
  assert.match(checkoutPage, /id="phone"[^>]*required/);
  assert.match(checkoutPage, /id="phone-country-code"[^>]*required/);

  for (const publicProduct of catalog.products) {
    const selectedProduct = findCatalogProduct(catalog.products, publicProduct.id);
    const checkoutLink = new URL(
      `commande.html?id=${encodeURIComponent(publicProduct.id)}`,
      "https://storefront.example/"
    );
    const harness = createHarness();
    const response = await harness.handler(checkoutEvent({
      product_id: checkoutLink.searchParams.get("id")
    }));
    const body = JSON.parse(response.body);
    const productLookup = harness.requests[0];
    const checkoutRequest = harness.requests[1];
    const chariowPayload = JSON.parse(checkoutRequest.options.body);

    assert.equal(selectedProduct.id, publicProduct.id);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(body, {
      status: "payment",
      checkout_url: "https://checkout.chariow.com/test-session"
    });
    assert.equal(harness.requests.length, 2);
    assert.equal(productLookup.method, "GET");
    assert.equal(productLookup.url.href, `https://api.chariow.com/v1/products/${publicProduct.id}`);
    assert.equal(productLookup.options.headers.Authorization, `Bearer ${TEST_ENV.CHARIOW_ADMIN_API_KEY}`);
    assert.equal(checkoutRequest.method, "POST");
    assert.deepEqual(chariowPayload, {
      product_id: publicProduct.id,
      email: "camille@example.test",
      first_name: "Camille",
      last_name: "Exemple",
      phone: { number: "22670123456", country_code: "BF" }
    });
  }
});

test("invalid or legacy IDs and missing checkout fields never call Chariow", async (t) => {
  const invalidCases = [
    ["legacy UUID", { product_id: "00000000-0000-4000-8000-000000000001" }],
    ["missing product ID", { product_id: undefined }],
    ["missing first name", { first_name: "" }],
    ["missing last name", { last_name: "" }],
    ["missing email", { email: "" }],
    ["missing phone", { phone: { number: "", country_code: "BF" } }],
    ["missing phone country", { phone: { number: "22670123456", country_code: "" } }],
    ["client price", { price: 1 }]
  ];

  for (const [label, overrides] of invalidCases) {
    await t.test(label, async () => {
      const harness = createHarness();
      const response = await harness.handler(checkoutEvent(overrides));

      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).code, "INVALID_CHECKOUT_DATA");
      assert.equal(harness.requests.length, 0);
    });
  }
});

test("nonexistent and unavailable products fail before the checkout API is called", async (t) => {
  await t.test("product not found", async () => {
    const harness = createHarness({ products: [] });
    const response = await harness.handler(checkoutEvent());

    assert.equal(response.statusCode, 404);
    assert.equal(JSON.parse(response.body).code, "PRODUCT_NOT_FOUND");
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].method, "GET");
  });

  await t.test("product unavailable", async () => {
    const harness = createHarness({ products: [unavailableProduct] });
    const response = await harness.handler(checkoutEvent({
      product_id: unavailableProduct.id
    }));

    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).code, "PRODUCT_UNAVAILABLE");
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].method, "GET");
  });
});

test("Chariow checkout steps never return a PGD post-payment confirmation", async (t) => {
  const cases = [
    {
      name: "completed",
      checkoutResponse: { data: { step: "completed" } },
      expectedStatus: 409,
      expectedBodyCode: "ALREADY_PURCHASED"
    },
    {
      name: "already purchased",
      checkoutResponse: { data: { step: "already_purchased" } },
      expectedStatus: 409,
      expectedBodyCode: "ALREADY_PURCHASED"
    },
    {
      name: "missing data",
      checkoutResponse: {},
      expectedStatus: 502,
      expectedBodyCode: "CHARIOW_INVALID_RESPONSE"
    },
    {
      name: "payment without URL",
      checkoutResponse: { data: { step: "payment", payment: {} } },
      expectedStatus: 502,
      expectedBodyCode: "CHARIOW_INVALID_RESPONSE"
    },
    {
      name: "unsafe URL",
      checkoutResponse: {
        data: { step: "payment", payment: { checkout_url: "https://attacker.example/session" } }
      },
      expectedStatus: 502,
      expectedBodyCode: "CHARIOW_INVALID_RESPONSE"
    },
    {
      name: "invalid JSON",
      checkoutRawBody: "not-json",
      expectedStatus: 502,
      expectedBodyCode: "CHARIOW_INVALID_RESPONSE"
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const harness = createHarness(scenario);
      const response = await harness.handler(checkoutEvent());
      const body = JSON.parse(response.body);

      assert.equal(response.statusCode, scenario.expectedStatus);
      if (scenario.expectedBody) assert.deepEqual(body, scenario.expectedBody);
      if (scenario.expectedBodyCode) assert.equal(body.code, scenario.expectedBodyCode);
      assert.equal(harness.requests.length, 2);
      assert.equal(harness.requests[1].method, "POST");
    });
  }
});

test("Chariow API errors are translated without exposing upstream details or credentials", async (t) => {
  for (const [status, code, mappedStatus] of [
    [403, "CHARIOW_CHECKOUT_SCOPE_MISSING", 503],
    [429, "CHARIOW_RATE_LIMITED", 503],
    [422, "CHARIOW_CHECKOUT_FAILED", 400],
    [500, "CHARIOW_CHECKOUT_FAILED", 502]
  ]) {
    await t.test(String(status), async () => {
      const harness = createHarness({
        checkoutResponse: { message: "private upstream failure details" },
        checkoutStatus: status
      });
      const response = await harness.handler(checkoutEvent());
      const body = JSON.parse(response.body);

      assert.equal(response.statusCode, mappedStatus);
      assert.equal(body.code, code);
      assert.doesNotMatch(
        JSON.stringify(body),
        /private upstream failure details|read-test-key-not-a-secret|checkout-test-key-not-a-secret/
      );
      assert.equal(harness.requests.length, 2);
    });
  }
});
