import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loadBrowserModule = async (path) => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
};

const [{ CatalogLoadError, createCatalogClient, isPublicProduct }, currency] = await Promise.all([
  loadBrowserModule("../public/assets/js/catalog.js"),
  loadBrowserModule("../public/assets/js/currency.js")
]);

const product = (overrides = {}) => ({
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: { fr: "Produit FR", en: "Product EN" },
  description: { fr: "Description FR<br>suite", en: "English description<br>more" },
  price: 4200,
  currency: "XOF",
  image: "assets/images/1.jpg",
  category: "Guides",
  ...overrides
});

const catalogResponse = (products = [product()]) => new Response(JSON.stringify({
  success: true,
  products,
  count: products.length
}), {
  status: 200,
  headers: { "Content-Type": "application/json" }
});

test("public catalog validates the real projected shape and excludes internal fields", () => {
  assert.equal(isPublicProduct(product()), true);
  assert.equal(isPublicProduct(product({ chariowProductId: "prd_private" })), false);
  assert.equal(isPublicProduct(product({ files: ["delivery.pdf"] })), false);
  assert.equal(isPublicProduct(product({ price: "4200" })), false);
  assert.equal(isPublicProduct(product({ currency: "GBP" })), false);
});

test("catalog loading uses the public endpoint and shares one in-flight request", async () => {
  const calls = [];
  let resolveResponse;
  const client = createCatalogClient((url, options) => {
    calls.push({ url, options });
    return new Promise((resolve) => { resolveResponse = resolve; });
  });

  const first = client.load();
  const second = client.load();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/.netlify/functions/public-catalog");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  resolveResponse(catalogResponse());
  assert.deepEqual(await first, [product()]);
  assert.deepEqual(await second, [product()]);
  assert.deepEqual(await client.load(), [product()]);
  assert.equal(calls.length, 1);
});

test("a retry requested during a pending load does not issue another request", async () => {
  let calls = 0;
  let resolveResponse;
  const client = createCatalogClient(() => {
    calls += 1;
    return new Promise((resolve) => { resolveResponse = resolve; });
  });
  const first = client.load();
  const retry = client.retry();
  assert.equal(calls, 1);
  resolveResponse(catalogResponse());
  assert.deepEqual(await first, await retry);
  assert.equal(calls, 1);
});

test("catalog failures distinguish network, HTTP, invalid JSON, and invalid data", async (t) => {
  const cases = [
    ["network", async () => { throw new Error("offline"); }, "network"],
    ["HTTP", async () => new Response("{}", { status: 503 }), "http"],
    ["invalid JSON", async () => new Response("{", { status: 200 }), "invalid-json"],
    ["invalid projection", async () => new Response(JSON.stringify({
      success: true,
      products: [product({ chariowProductId: "prd_private" })],
      count: 1
    }), { status: 200 }), "invalid-data"]
  ];

  for (const [label, fetchImpl, code] of cases) {
    await t.test(label, async () => {
      const client = createCatalogClient(fetchImpl);
      await assert.rejects(client.load(), (error) =>
        error instanceof CatalogLoadError && error.code === code
      );
    });
  }
});

test("failed requests can be retried and a successful result is then cached", async () => {
  let calls = 0;
  const client = createCatalogClient(async () => {
    calls += 1;
    if (calls === 1) return new Response("{}", { status: 503 });
    return catalogResponse();
  });

  await assert.rejects(client.load(), { code: "http" });
  assert.deepEqual(await client.retry(), [product()]);
  assert.deepEqual(await client.load(), [product()]);
  assert.equal(calls, 2);
});

test("display prices convert from the product's actual base currency", () => {
  assert.equal(currency.convertPriceBetweenCurrencies(4200, "XOF", "XOF"), 4200);
  assert.equal(currency.convertPriceBetweenCurrencies(100, "EUR", "XOF"), 100 / 0.00152);
  assert.equal(currency.convertPriceBetweenCurrencies(100, "USD", "EUR"), 100 / 0.00165 * 0.00152);
  assert.match(currency.formatDisplayPrice(100, "EUR", "EUR"), /100/);
});

test("storefront pages use catalog data and payment request omits amount and Chariow ID", async () => {
  const app = await readFile(new URL("../public/assets/js/app.js", import.meta.url), "utf8");
  const htmlPages = await Promise.all([
    "../public/index.html",
    "../public/boutique.html",
    "../public/produit.html",
    "../public/panier.html",
    "../public/commande.html"
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

  assert.match(app, /createCatalogClient\(\)/);
  assert.doesNotMatch(app, /from "\.\/products\.js"/);
  assert.match(app, /catalogProducts\.find\(\(product\) => product\.id === id\)/);
  assert.match(app, /shop\.noResults/);
  assert.match(app, /catalog\.noProducts/);
  assert.match(app, /produitId: product\.id, currency: selectedCurrency/);
  assert.doesNotMatch(app.match(/JSON\.stringify\(\{[^}]+\}\)/)?.[0] || "", /price|chariowProductId/);
  assert.ok(htmlPages.every((html) => html.includes('assets/js/app.js')));
  assert.match(app, /data-catalog-retry/);
});

test("French and English locales retain historical product resources and add catalog states", async () => {
  const [fr, en] = await Promise.all([
    readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../public/locales/en.json", import.meta.url), "utf8").then(JSON.parse)
  ]);
  for (const locale of [fr, en]) {
    assert.equal(typeof locale.catalog.loading, "string");
    assert.equal(typeof locale.catalog.noProducts, "string");
    assert.equal(typeof locale.catalog.networkError, "string");
    assert.equal(typeof locale.catalog.httpError, "string");
    assert.equal(typeof locale.catalog.invalidResponse, "string");
    assert.equal(typeof locale.catalog.retry, "string");
    assert.equal(typeof locale.catalog.backToShop, "string");
    assert.equal(typeof locale.shop.noResults, "string");
    assert.equal(typeof locale.product.notFound, "string");
    assert.equal(typeof locale.cart.staleReferences, "string");
    assert.equal(typeof locale.cart.removeStale, "string");
  }
  assert.equal(en.products["550e8400-e29b-41d4-a716-446655440000"].name.length > 0, true);
  assert.equal(en.products["7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90"].name.length > 0, true);
});
