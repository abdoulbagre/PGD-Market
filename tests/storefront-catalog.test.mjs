import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loadBrowserModule = async (path) => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
};

const [{ CatalogLoadError, createCatalogClient, isPublicProduct }, currency] = await Promise.all([
  loadBrowserModule("../frontend/storefront/assets/js/catalog.js"),
  loadBrowserModule("../frontend/storefront/assets/js/currency.js")
]);

const product = (overrides = {}) => ({
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "Produit FR",
  description: "Description FR<br>suite",
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
  assert.equal(isPublicProduct(product({
    name: { fr: "Nom français historique", en: "Legacy English name" },
    description: {
      fr: "Description française historique",
      en: "Legacy English description"
    }
  })), true);
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

test("catalog prices retain their currency and mixed-currency totals are not calculated", () => {
  assert.equal("convertPriceBetweenCurrencies" in currency, false);
  assert.equal(currency.CHECKOUT_CURRENCY, "XOF");
  assert.match(currency.formatDisplayPrice(4200, "XOF"), /4.*200/);
  assert.match(currency.formatDisplayPrice(4200, "XOF"), /XOF/);
  assert.match(currency.formatDisplayPrice(100, "EUR"), /100.*EUR/);
  assert.deepEqual(currency.sumPricesInSameCurrency([product(), product({ price: 700 })]), {
    amount: 4900,
    currency: "XOF"
  });
  assert.equal(currency.sumPricesInSameCurrency([product(), product({ currency: "EUR" })]), null);
  assert.equal(currency.sumPricesInSameCurrency([]), null);
});

test("storefront pages use catalog data and payment request omits amount and Chariow ID", async () => {
  const app = await readFile(new URL("../frontend/storefront/assets/js/app.js", import.meta.url), "utf8");
  const successPage = await readFile(new URL("../frontend/storefront/success.html", import.meta.url), "utf8");
  const htmlPages = await Promise.all([
    "../frontend/storefront/index.html",
    "../frontend/storefront/boutique.html",
    "../frontend/storefront/produit.html",
    "../frontend/storefront/panier.html",
    "../frontend/storefront/commande.html"
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

  assert.match(app, /createCatalogClient\(\)/);
  assert.doesNotMatch(app, /from "\.\/products\.js"/);
  assert.doesNotMatch(app, /convertPriceBetweenCurrencies/);
  assert.match(app, /catalogProducts\.find\(\(product\) => product\.id === id\)/);
  assert.match(app, /shop\.noResults/);
  assert.match(app, /catalog\.noProducts/);
  assert.match(app, /produitId: product\.id, currency: CHECKOUT_CURRENCY/);
  assert.match(app, /sumPricesInSameCurrency/);
  assert.match(app, /memoryCart/);
  assert.match(app, /cartStorageUnavailable/);
  assert.match(htmlPages[4], /maxlength="2"/);
  assert.doesNotMatch(app.match(/JSON\.stringify\(\{[^}]+\}\)/)?.[0] || "", /price|chariowProductId/);
  assert.ok(htmlPages.every((html) => html.includes('assets/js/app.js')));
  assert.match(app, /data-catalog-retry/);
  assert.match(successPage, /Retour du paiement/);
  assert.match(successPage, /ne confirme pas à elle seule le statut/);
  assert.doesNotMatch(successPage, /paiement réussi|commande a été effectuée avec succès|data-i18n="successPage/);
  assert.doesNotMatch(app, /successPage\.(heading|delivery|spam|thanks)/);
  const resultPageLogic = app.slice(app.indexOf("function setupResult"), app.indexOf("async function renderPage"));
  assert.doesNotMatch(resultPageLogic, /localStorage|writeCart/);
});

test("storefront cart CTAs expose add feedback and an accessible cart count", async () => {
  const [app, fr, theme] = await Promise.all([
    readFile(new URL("../frontend/storefront/assets/js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/storefront/locales/fr.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../frontend/storefront/assets/css/premium.css", import.meta.url), "utf8")
  ]);
  assert.match(app, /button\.classList\.add\("is-added"\)/);
  assert.match(app, /cart\.added/);
  assert.match(app, /data-add-cart="\$\{escapeHtml\(product\.id\)\}"/);
  assert.match(app, /cartCountOne/);
  assert.match(app, /cart-item__quantity/);
  assert.match(app, /cart-summary__total/);
  assert.match(app, /class="cart-empty"/);
  assert.match(app, /footer-brand-block/);
  assert.match(theme, /--paper:\s*#f7f3eb/);
  assert.match(theme, /--accent-dark:\s*#183a2f/);
  assert.match(theme, /--warm:\s*#99652f/);
  assert.equal(fr.navigation.cartCountEmpty, "Panier, aucun article");
  assert.equal(fr.cart.itemOne, "{{count}} produit sélectionné");
  assert.equal(fr.cart.summaryNote, "Chaque ressource se commande individuellement.");
});

test("the storefront uses French text only and has no English locale dependency", async () => {
  const [fr, app, frenchModule] = await Promise.all([
    readFile(new URL("../frontend/storefront/locales/fr.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../frontend/storefront/assets/js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/storefront/assets/js/french.js", import.meta.url), "utf8")
  ]);
  assert.equal(typeof fr.catalog.loading, "string");
  assert.equal(typeof fr.catalog.noProducts, "string");
  assert.equal(typeof fr.catalog.networkError, "string");
  assert.equal(typeof fr.catalog.httpError, "string");
  assert.equal(typeof fr.catalog.invalidResponse, "string");
  assert.equal(typeof fr.catalog.retry, "string");
  assert.equal(typeof fr.catalog.backToShop, "string");
  assert.equal(typeof fr.shop.noResults, "string");
  assert.equal(typeof fr.product.notFound, "string");
  assert.equal(typeof fr.cart.staleReferences, "string");
  assert.equal(typeof fr.cart.removeStale, "string");
  assert.match(app, /initFrench/);
  assert.doesNotMatch(app, /languagechange|documentElement\.lang === "en"|language\.js|en\.json/);
  assert.doesNotMatch(frenchModule, /setLanguage|data-language-select|en\.json|localStorage/);
  assert.equal(existsSync(new URL("../frontend/storefront/locales/en.json", import.meta.url)), false);
});
