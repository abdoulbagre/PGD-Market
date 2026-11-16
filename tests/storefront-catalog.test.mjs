import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const loadBrowserModule = async (path) => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
};

const listHtmlPages = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const file = new URL(entry.name, directory);
    if (entry.isDirectory()) return listHtmlPages(new URL(`${entry.name}/`, directory));
    return entry.isFile() && entry.name.endsWith(".html") ? [file] : [];
  }));
  return nestedFiles.flat();
};

const [{
  CatalogLoadError,
  createCatalogClient,
  findCatalogProduct,
  getProductDiscountPercentage,
  getOriginalProductPrice,
  isPublicProduct,
  plainTextDescription,
  renderProductRating
}, currency] = await Promise.all([
  loadBrowserModule("../frontend/storefront/assets/js/catalog.js"),
  loadBrowserModule("../frontend/storefront/assets/js/currency.js")
]);

const product = (overrides = {}) => ({
  id: "prd_5lj7fz8k",
  name: "Produit FR",
  description: "Description FR<br>suite",
  price: 4200,
  originalPrice: null,
  discountPercentage: null,
  currency: "XOF",
  image: "https://cdn.chariow.com/products/guide-cover.jpg",
  category: "Guides",
  rating: 0,
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

test("public catalog validates Chariow IDs, real prices, currencies, and safe image URLs", () => {
  assert.equal(isPublicProduct(product()), true);
  assert.equal(isPublicProduct(product({
    name: { fr: "Nom français historique", en: "Legacy English name" },
    description: {
      fr: "Description française historique",
      en: "Legacy English description"
    }
  })), true);
  assert.equal(isPublicProduct(product({ id: "invalid" })), false);
  assert.equal(isPublicProduct(product({ id: "00000000-0000-4000-8000-000000000001" })), false);
  assert.equal(isPublicProduct(product({ files: ["delivery.pdf"] })), false);
  assert.equal(isPublicProduct(product({ price: "4200" })), false);
  assert.equal(isPublicProduct(product({ price: 4200.5 })), true);
  assert.equal(isPublicProduct(product({ currency: "GHS" })), true);
  assert.equal(isPublicProduct(product({ originalPrice: 5000 })), true);
  assert.equal(isPublicProduct(product({ originalPrice: 4200 })), false);
  assert.equal(isPublicProduct(product({ originalPrice: 4000 })), false);
  assert.equal(isPublicProduct(product({ originalPrice: undefined })), false);
  assert.equal(isPublicProduct(product({
    price: 3000,
    originalPrice: 5000,
    discountPercentage: "40%"
  })), true);
  assert.equal(isPublicProduct(product({
    price: 3000,
    originalPrice: 5000,
    discountPercentage: "20%"
  })), true);
  assert.equal(isPublicProduct(product({
    price: 3000,
    originalPrice: 5000,
    discountPercentage: "0%"
  })), false);
  assert.equal(isPublicProduct(product({
    price: 3000,
    originalPrice: null,
    discountPercentage: "40%"
  })), false);
  assert.equal(isPublicProduct(product({ rating: 5 })), true);
  assert.equal(isPublicProduct(product({ rating: 6 })), false);
  assert.equal(isPublicProduct(product({ rating: 1.5 })), false);
  assert.equal(isPublicProduct(product({ image: "http://cdn.example/image.jpg" })), false);
  assert.equal(isPublicProduct(product({ image: "https://cdn.example/image.jpg" })), true);
});

test("original product price is shown only when valid and higher than the current price", () => {
  assert.equal(getOriginalProductPrice(product({ price: 3000, originalPrice: 5000 })), 5000);
  assert.equal(getOriginalProductPrice(product({ price: 3000, originalPrice: 3000 })), null);
  assert.equal(getOriginalProductPrice(product({ price: 3000, originalPrice: 2500 })), null);
  assert.equal(getOriginalProductPrice(product({ price: 3000, originalPrice: null })), null);
  for (const percentage of ["40%", "20%"]) {
    assert.equal(getProductDiscountPercentage(product({
      price: 3000,
      originalPrice: 5000,
      discountPercentage: percentage
    })), percentage);
  }
  for (const percentage of [null, "0%", "101%", "sale", 40]) {
    assert.equal(getProductDiscountPercentage(product({
      price: 3000,
      originalPrice: 5000,
      discountPercentage: percentage
    })), null);
  }
  assert.equal(getProductDiscountPercentage(product({
    price: 3000,
    originalPrice: null,
    discountPercentage: "40%"
  })), null);
  assert.match(currency.formatDisplayPrice(5000, "XOF"), /XOF/);
});

test("product URLs resolve only exact canonical Chariow IDs", () => {
  const secondProduct = product({ id: "prd_ln1r0vbr" });
  const catalog = [product(), secondProduct];

  assert.equal(findCatalogProduct(catalog, "prd_5lj7fz8k"), catalog[0]);
  assert.equal(findCatalogProduct(catalog, "00000000-0000-4000-8000-000000000001"), null);
  assert.equal(findCatalogProduct(catalog, "prd_unknown"), null);
  assert.equal(
    findCatalogProduct(
      [product({ id: "00000000-0000-4000-8000-000000000001" })],
      "00000000-0000-4000-8000-000000000001"
    ),
    null
  );
  assert.equal(catalog[0].id, "prd_5lj7fz8k");
});

test("PGD ratings render one accessible five-star row without review counts", () => {
  assert.equal(renderProductRating(0, "Note PGD : 0 sur 5 étoiles"), "");
  assert.equal(renderProductRating(6, "Invalid"), "");
  const markup = renderProductRating(3, 'Note PGD : 3 sur 5 "étoiles"');
  assert.equal((markup.match(/&#9733;/g) || []).length, 3);
  assert.equal((markup.match(/&#9734;/g) || []).length, 2);
  assert.match(markup, /role="img" aria-label="Note PGD : 3 sur 5 &quot;étoiles&quot;"/);
  assert.doesNotMatch(markup, /avis|review|count/i);
});

test("Chariow HTML descriptions become readable text without executable markup", () => {
  assert.equal(
    plainTextDescription(
      "<p><strong>Créer</strong> vite &amp; bien.</p><ul><li>Préparer</li><li>Tester</li></ul><script>alert(1)</script>"
    ),
    "Créer vite & bien.\nPréparer\nTester"
  );
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
      products: [product({ id: "invalid" })],
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

test("catalog prices retain their source currency without conversion", () => {
  assert.equal("convertPriceBetweenCurrencies" in currency, false);
  assert.equal("CHECKOUT_CURRENCY" in currency, false);
  assert.match(currency.formatDisplayPrice(4200, "XOF"), /4.*200/);
  assert.match(currency.formatDisplayPrice(4200, "XOF"), /XOF/);
  assert.match(currency.formatDisplayPrice(100, "EUR"), /100.*EUR/);
});

test("the home link is part of the shared desktop and mobile navigation", async () => {
  const [app, fr, editorial] = await Promise.all([
    readFile(new URL("../frontend/storefront/assets/js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/storefront/locales/fr.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../frontend/storefront/assets/css/editorial.css", import.meta.url), "utf8")
  ]);
  const navigation = app.match(/<nav id="main-nav"[\s\S]*?<\/nav>/)?.[0] || "";

  assert.match(navigation, /<a href="index\.html" data-i18n="navigation\.home"><\/a>/);
  assert.match(navigation, /<a href="boutique\.html"/);
  assert.match(navigation, /<a href="contact\.html"/);
  assert.equal(fr.navigation.home, "Accueil");
  assert.match(app, /aria-controls="main-nav"/);
  assert.match(app, /homeLink\.setAttribute\("aria-current", "page"\)/);
  assert.match(editorial, /grid-column:\s*1\s*\/\s*-1;/);
  assert.match(editorial, /\.main-nav\.is-open\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;/);
});

test("public storefront copy does not expose provider details or Chariow product IDs", async () => {
  const htmlPages = await listHtmlPages(new URL("../frontend/storefront/", import.meta.url));
  const [app, locale] = await Promise.all([
    readFile(new URL("../frontend/storefront/assets/js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/storefront/locales/fr.json", import.meta.url), "utf8")
  ]);
  // Keep the internal server-error code matcher out of the user-facing copy check.
  const appCopy = app.replace(/CHARIOW_/g, "");
  const storefrontUi = await Promise.all([
    ...htmlPages
      .filter((file) => !["mentions-legales.html", "politique-confidentialite.html"].includes(file.pathname.split("/").pop()))
      .map((file) => readFile(file, "utf8")),
    appCopy,
    locale
  ]);
  const publicCopy = storefrontUi.join("\n");
  const allPageMarkup = (await Promise.all(htmlPages.map((file) => readFile(file, "utf8")))).join("\n");

  assert.doesNotMatch(publicCopy, /chariow/i);
  assert.doesNotMatch(`${publicCopy}\n${allPageMarkup}`, /\bprd_[a-z0-9]+\b/i);
});

test("product cards show the PGD rating and direct product link without cart controls", async () => {
  const [app, editorial] = await Promise.all([
    readFile(new URL("../frontend/storefront/assets/js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/storefront/assets/css/editorial.css", import.meta.url), "utf8")
  ]);
  const card = app.slice(app.indexOf("function productCard"), app.indexOf("function setupShop"));
  const image = card.indexOf('class="product-card__visual"');
  const discountBadge = card.indexOf("${discountBadgeMarkup(product)}");
  const name = card.indexOf("<h3>");
  const description = card.indexOf('class="product-card__description"');
  const price = card.indexOf("<strong>${escapeHtml(formatPrice(product))}</strong>");
  const originalPrice = card.indexOf("${originalPriceMarkup(product)}");
  const rating = card.indexOf("renderProductRating(product.rating");
  const format = card.indexOf("Format numérique");
  const viewAction = card.indexOf('class="button product-card__view"');

  assert.ok(image >= 0 && discountBadge > image && name > discountBadge && description > name);
  assert.match(card, /src="\$\{escapeHtml\(productImage\(product\)\)\}"/);
  assert.ok(app.includes('new URL(product.image, new URL("../../", import.meta.url)).href'));
  assert.ok(rating > description && price > rating && originalPrice > price && format > originalPrice && viewAction > format);
  assert.match(app, /getOriginalProductPrice\(product\)/);
  assert.match(app, /getProductDiscountPercentage\(product\)/);
  assert.match(card, /discountBadgeMarkup\(product\)/);
  assert.match(app, /<del class="product-price-original">/);
  assert.doesNotMatch(card, /cart|panier|data-add/i);
  assert.match(editorial, /\.product-card__visual\s*\{[^}]*--product-card-visual-height:\s*clamp\(190px,\s*18vw,\s*235px\);[^}]*height:\s*var\(--product-card-visual-height\);[^}]*aspect-ratio:\s*auto;/s);
  assert.match(editorial, /\.product-card__discount-badge\s*\{[^}]*position:\s*absolute;[^}]*top:\s*14px;[^}]*right:\s*14px;[^}]*background:\s*var\(--forest-deep\);[^}]*color:\s*var\(--white\);[^}]*white-space:\s*nowrap;/s);
  assert.match(editorial, /\.product-image img\s*\{[^}]*object-fit:\s*contain;/s);
  assert.match(editorial, /\.product-card \.product-card__view\s*\{[^}]*background:\s*var\(--forest\);[^}]*color:\s*var\(--white\);/s);
  assert.match(editorial, /\.product-card__view span\s*\{\s*color:\s*var\(--gold-champagne\);/s);
  assert.match(editorial, /\.product-card-footer\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
  assert.match(editorial, /\.product-card-price\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(editorial, /\.product-price-original\s*\{[^}]*font-size:\s*\.84rem;[^}]*white-space:\s*nowrap;/s);
});

test("no cart route, browser storage, buttons, or local cart migrations remain", async () => {
  const storefrontRoot = new URL("../frontend/storefront/", import.meta.url);
  const [app, catalog, locale] = await Promise.all([
    readFile(new URL("../frontend/storefront/assets/js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/storefront/assets/js/catalog.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/storefront/locales/fr.json", import.meta.url), "utf8")
  ]);
  const htmlPages = await listHtmlPages(storefrontRoot);
  const styles = await Promise.all([
    "editorial.css",
    "premium.css",
    "style.css",
    "responsive.css",
    "components.css"
  ].map((file) => readFile(new URL(`../frontend/storefront/assets/css/${file}`, import.meta.url), "utf8")));

  assert.equal(existsSync(new URL("../frontend/storefront/panier.html", import.meta.url)), false);
  assert.doesNotMatch(app, /cart|panier|localStorage|readCart|writeCart|migrateLegacyProductIds/i);
  assert.doesNotMatch(catalog, /migrateLegacyProductIds/);
  assert.doesNotMatch(locale, /"cart"|panier/i);
  assert.doesNotMatch(htmlPages.map((file) => file.pathname).join("\n"), /panier\.html/);
  assert.doesNotMatch(styles.join("\n"), /cart-link|cart-count|button-cart|product-cart|cart-item|cart-content|cart-summary|cart-actions/i);
});

test("mobile product detail places its purchase action before the long description", async () => {
  const [app, editorial] = await Promise.all([
    readFile(new URL("../frontend/storefront/assets/js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/storefront/assets/css/editorial.css", import.meta.url), "utf8")
  ]);
  const setupProduct = app.slice(app.indexOf("function setupProduct"), app.indexOf("function productFromUrlId"));
  const purchasePanel = setupProduct.slice(setupProduct.indexOf("const purchasePanel = `"), setupProduct.indexOf("const stickyAction"));

  assert.doesNotMatch(setupProduct, /product-card__discount-badge|discountBadgeMarkup/);
  assert.ok(purchasePanel.indexOf('class="product-price"') < purchasePanel.indexOf("${actions}"));
  assert.match(purchasePanel, /class="product-purchase__prices".*?originalPriceMarkup\(product\)/s);
  assert.match(setupProduct, /class="product-sticky-cta__prices".*?originalPriceMarkup\(product\)/s);
  assert.match(editorial, /\.product-purchase__prices\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(editorial, /\.product-sticky-cta__prices\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(setupProduct, /const actions = `.*?class="product-actions"/s);
  assert.match(setupProduct, /target\.innerHTML = `.*?class="product-visual".*?class="product-heading".*?\$\{purchasePanel\}.*?class="rich-description"/s);
  assert.match(editorial, /@media \(max-width: 760px\) \{[\s\S]*?\.product-detail \{[\s\S]*?grid-template-columns: 1fr;[\s\S]*?\.product-visual \{[\s\S]*?aspect-ratio: 1\.25;[\s\S]*?\.product-heading,\s*\.product-purchase,\s*\.rich-description \{[\s\S]*?grid-row: auto;/);
});

test("storefront checkout sends one canonical product and only required customer fields", async () => {
  const app = await readFile(new URL("../frontend/storefront/assets/js/app.js", import.meta.url), "utf8");
  const htmlPages = await Promise.all([
    "../frontend/storefront/index.html",
    "../frontend/storefront/boutique.html",
    "../frontend/storefront/produit.html",
    "../frontend/storefront/commande.html"
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

  assert.match(app, /createCatalogClient\(\)/);
  assert.match(app, /plainTextDescription/);
  assert.doesNotMatch(app, /from "\.\/products\.js"/);
  assert.doesNotMatch(app, /convertPriceBetweenCurrencies/);
  assert.match(app, /findCatalogProduct\(catalogProducts, id\)/);
  assert.match(app, /productFromUrlId/);
  assert.doesNotMatch(app, /history\.replaceState/);
  assert.match(app, /shop\.noResults/);
  assert.match(app, /catalog\.noProducts/);
  assert.match(app, /product_id: product\.id/);
  assert.match(app, /first_name: firstName/);
  assert.match(app, /last_name: lastName/);
  const checkoutSetup = app.slice(app.indexOf("function setupCheckout"), app.indexOf("async function renderPage"));
  assert.match(checkoutSetup, /formatPrice\(product\)/);
  assert.doesNotMatch(checkoutSetup, /originalPriceMarkup/);
  assert.match(app, /phone:\s*\{\s*number: phone,\s*country_code: phoneCountryCode/s);
  assert.doesNotMatch(app, /chariowProductId|currency: CHECKOUT_CURRENCY|readCart|writeCart|panier|cart/i);
  assert.doesNotMatch(app, /crypto\.randomUUID|randomUUID/);
  assert.match(app, /produit\.html\?id=\$\{encodeURIComponent\(product\.id\)\}/);
  assert.match(app, /commande\.html\?id=\$\{encodeURIComponent\(product\.id\)\}/);
  assert.match(htmlPages[3], /maxlength="2"/);
  assert.match(htmlPages[3], /name="first_name"[^>]*required/);
  assert.match(htmlPages[3], /name="last_name"[^>]*required/);
  assert.match(htmlPages[3], /name="email"[^>]*required/);
  assert.match(htmlPages[3], /name="phone\.number"[^>]*required/);
  assert.match(htmlPages[3], /name="phone\.country_code"[^>]*required/);
  const requestPayload = app.match(/body: JSON\.stringify\(\{([\s\S]*?)\}\)/)?.[1] || "";
  assert.doesNotMatch(requestPayload, /price|currency|variant|metadata|affiliate|campaign|coupon|shipping/i);
  assert.doesNotMatch(app, /data\.status === "completed"|checkout\.completedNotice/);
  assert.doesNotMatch(app, /success\.html|setupResult|data-page === "success"/);
  assert.match(app, /ALREADY_PURCHASED/);
  assert.ok(htmlPages.every((html) => html.includes('assets/js/app.js')));
  assert.match(app, /data-catalog-retry/);
  assert.doesNotMatch(app, /location\.href\s*=\s*["'](?:success|cancel)\.html/);
});

test("the PGD rating is shared by product cards and product descriptions", async () => {
  const [app, fr, theme] = await Promise.all([
    readFile(new URL("../frontend/storefront/assets/js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/storefront/locales/fr.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../frontend/storefront/assets/css/premium.css", import.meta.url), "utf8")
  ]);
  const detail = app.slice(app.indexOf("function setupProduct"), app.indexOf("function productFromUrlId"));
  assert.match(app, /renderProductRating\(product\.rating,/);
  assert.match(detail, /class="rich-description">\$\{renderProductRating\(product\.rating,/);
  assert.equal(fr.product.ratingLabel, "Note PGD : {{rating}} sur 5 étoiles");
  assert.match(app, /footer-brand-block/);
  assert.match(theme, /--paper:\s*#f7f3eb/);
  assert.match(theme, /--accent-dark:\s*#183a2f/);
  assert.match(theme, /--warm:\s*#99652f/);
});

test("storefront logo wordmark matches its symbol gold on light and dark surfaces", async () => {
  const editorial = await readFile(
    new URL("../frontend/storefront/assets/css/editorial.css", import.meta.url),
    "utf8"
  );
  assert.match(editorial, /--bronze:\s*#925c21/i);
  assert.match(editorial, /\.brand:not\(\.footer-brand\) span:first-of-type\s*\{\s*color:\s*var\(--bronze\);/);
  assert.match(editorial, /--gold-champagne:\s*#d7c391/i);
  assert.match(editorial, /\.footer-brand span:first-of-type\s*\{\s*color:\s*var\(--gold-champagne\);/);
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
  assert.match(fr.product.notFound, /n’est plus disponible/);
  assert.equal(fr.checkout.firstName, "Prénom");
  assert.equal(fr.checkout.lastName, "Nom");
  assert.match(app, /initFrench/);
  assert.doesNotMatch(app, /languagechange|documentElement\.lang === "en"|language\.js|en\.json/);
  assert.doesNotMatch(frenchModule, /setLanguage|data-language-select|en\.json|localStorage/);
  assert.equal(existsSync(new URL("../frontend/storefront/locales/en.json", import.meta.url)), false);
});
