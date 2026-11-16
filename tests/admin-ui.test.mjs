import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const uiSource = await readFile(
  new URL("../frontend/admin/assets/js/admin-ui.js", import.meta.url),
  "utf8"
);
const {
  AdminCatalogError,
  createAdminCatalogController,
  createAdminSessionLifecycle,
  getProductActions,
  summarizeChariowAnalytics
} = await import(
  `data:text/javascript;base64,${Buffer.from(uiSource).toString("base64")}`
);

const product = (overrides = {}) => ({
  id: "prd_product_one",
  name: "Produit FR",
  description: "Description FR",
  price: 4200,
  currency: "XOF",
  image: "https://cdn.chariow.com/products/admin-cover.jpg",
  category: "Guides",
  rating: 0,
  ...overrides
});

const response = (status, body, etag = '"version-1"') =>
  new Response(JSON.stringify(body), {
    status,
    headers: etag
      ? { "Content-Type": "application/json", ETag: etag }
      : { "Content-Type": "application/json" }
  });

const catalogResponse = (products, etag, canEditRatings = true) =>
  response(200, {
    products,
    product: products.at(-1) || null,
    metadata: { canEditRatings }
  }, etag);

test("Admin keeps authentication and exposes a separate PGD product-rating screen", async () => {
  const [html, authScript] = await Promise.all([
    readFile(new URL("../frontend/admin/admin.html", import.meta.url), "utf8"),
    readFile(new URL("../frontend/admin/assets/js/admin.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="login-form"/);
  assert.match(html, /data-admin-app hidden/);
  assert.match(html, /data-admin-view="products"/);
  assert.match(html, /Notes des produits/);
  assert.match(authScript, /setAuthenticated\(isAdmin\)/);
});

test("Admin rating editor exposes only the PGD 0-to-5 rating field", async () => {
  const [html, uiScript] = await Promise.all([
    readFile(new URL("../frontend/admin/admin.html", import.meta.url), "utf8"),
    readFile(new URL("../frontend/admin/assets/js/admin-ui.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /name="rating"[^>]*min="0"[^>]*max="5"[^>]*step="1"[^>]*required/);
  assert.match(html, /0 signifie aucune note/);
  assert.doesNotMatch(html, /data-catalog-initialize|data-product-create|name="(?:price|currency|chariow-product-id|available|published)"/);
  assert.doesNotMatch(uiScript, /catalogInitializationEndpoint/);
  assert.match(uiScript, /method: "PATCH"/);
  assert.match(uiScript, /return \{ rating \}/);
});

test("Admin product actions cannot change or delete Chariow product data", () => {
  assert.deepEqual(getProductActions(product()), ["edit"]);
  assert.deepEqual(getProductActions(product(), true), []);
  assert.deepEqual(getProductActions(product(), false, false), []);
});

test("catalog reads and rating changes use same-origin no-store requests and ETags", async () => {
  const calls = [];
  const controller = createAdminCatalogController(async (url, options) => {
    calls.push({ url, options });
    const saved = product({ rating: 4 });
    return catalogResponse([saved], options.method ? '"version-2"' : '"version-1"');
  });

  const loaded = await controller.load();
  assert.equal(loaded.canEditRatings, true);
  const editEtag = controller.beginEdit(loaded.products[0]);
  const saved = await controller.mutate({
    method: "PATCH",
    productId: loaded.products[0].id,
    ifMatch: editEtag,
    body: { rating: 4 }
  });

  assert.equal(calls[0].url, "/.netlify/functions/catalog");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[1].options.method, "PATCH");
  assert.equal(calls[1].options.headers["If-Match"], '"version-1"');
  assert.deepEqual(JSON.parse(calls[1].options.body), { rating: 4 });
  assert.equal(saved.product.rating, 4);
  assert.equal(controller.etag, '"version-2"');
});

test("catalog Preview is read-only without an ETag and blocks rating edits locally", async () => {
  const controller = createAdminCatalogController(async () =>
    catalogResponse([product()], null, false)
  );
  const loaded = await controller.load();

  assert.equal(loaded.etag, "");
  assert.equal(loaded.canEditRatings, false);
  assert.deepEqual(getProductActions(loaded.products[0], false, loaded.canEditRatings), []);
  assert.throws(
    () => controller.beginEdit(loaded.products[0]),
    (error) => error instanceof AdminCatalogError && error.status === 403
  );
  await assert.rejects(
    controller.mutate({
      method: "PATCH",
      productId: product().id,
      body: { rating: 4 }
    }),
    (error) => error instanceof AdminCatalogError && error.status === 403
  );
});

test("a stale ETag blocks repeated rating changes until the latest version is loaded", async () => {
  let callCount = 0;
  const latest = product({ rating: 2 });
  const controller = createAdminCatalogController(async () => {
    callCount += 1;
    if (callCount === 1) return catalogResponse([product()], '"version-1"');
    if (callCount === 2) return response(412, { error: "RATINGS_CONFLICT" });
    return catalogResponse([latest], '"version-2"');
  });
  const loaded = await controller.load();
  controller.beginEdit(loaded.products[0]);

  await assert.rejects(
    controller.mutate({
      method: "PATCH",
      productId: product().id,
      body: { rating: 3 }
    }),
    (error) => error instanceof AdminCatalogError && error.status === 412
  );
  await assert.rejects(
    controller.mutate({
      method: "PATCH",
      productId: product().id,
      body: { rating: 3 }
    }),
    (error) => error instanceof AdminCatalogError && error.status === 412
  );
  assert.equal(callCount, 2);

  const reloaded = await controller.reloadEdit(product().id);
  assert.equal(reloaded.product.rating, 2);
  assert.equal(reloaded.etag, '"version-2"');
});

test("Chariow analytics deduplicate sales and keep revenue separated by currency", () => {
  const summary = summarizeChariowAnalytics({
    now: new Date("2025-01-08T12:00:00.000Z"),
    period: "last7days",
    products: [
      { id: "prd_a", status: "published" },
      { id: "prd_b", status: "draft" }
    ],
    sales: [
      {
        id: "sal_a",
        status: "completed",
        created_at: "2025-01-08T09:00:00.000Z",
        product: { id: "prd_a", name: "Guide A" },
        payment: {
          status: "success",
          amount: { value: 100, currency: "XOF" }
        }
      },
      {
        id: "sal_a",
        status: "settled",
        created_at: "2025-01-08T09:00:00.000Z",
        product: { id: "prd_a", name: "Guide A" },
        payment: {
          status: "success",
          amount: { value: 100, currency: "XOF" }
        }
      },
      {
        id: "sal_b",
        status: "settled",
        created_at: "2025-01-07T09:00:00.000Z",
        product: { id: "prd_b", name: "Guide B" },
        payment: {
          status: "success",
          amount: { value: 12.5, currency: "EUR" }
        }
      }
    ]
  });

  assert.equal(summary.totalProducts, 2);
  assert.equal(summary.publishedProducts, 1);
  assert.equal(summary.salesCount, 2);
  assert.deepEqual(summary.revenueByCurrency, [
    { currency: "EUR", amount: 12.5 },
    { currency: "XOF", amount: 100 }
  ]);
  assert.deepEqual(summary.topProducts.map(({ id, count }) => ({ id, count })), [
    { id: "prd_a", count: 1 },
    { id: "prd_b", count: 1 }
  ]);
});

test("session lifecycle ignores stale responses and clears cached ETags on logout", async () => {
  let cached = [];
  let lifecycle;
  lifecycle = createAdminSessionLifecycle({
    onExpire() {
      cached = [];
    },
    onAuthenticate(session) {
      const loaded = session === 1
        ? new Promise((resolve) => { setTimeout(() => resolve(["old"]), 10); })
        : Promise.resolve(["current"]);
      return loaded.then((products) => {
        if (lifecycle.isCurrent(session)) cached = products;
        return products;
      });
    }
  });

  const oldSession = lifecycle.change(true);
  lifecycle.change(false);
  const currentSession = lifecycle.change(true);
  await currentSession.refresh;
  await oldSession.refresh;
  assert.deepEqual(cached, ["current"]);
  lifecycle.change(false);
  assert.deepEqual(cached, []);
});
