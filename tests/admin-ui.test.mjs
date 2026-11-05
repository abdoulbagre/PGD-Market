import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const uiSource = await readFile(new URL("../public/assets/js/admin-ui.js", import.meta.url), "utf8");
const { AdminCatalogError, createAdminCatalogController } = await import(
  `data:text/javascript;base64,${Buffer.from(uiSource).toString("base64")}`
);

test("catalog management reuses the existing administrator authentication flow", async () => {
  const [html, authScript, catalogScript] = await Promise.all([
    readFile(new URL("../public/admin.html", import.meta.url), "utf8"),
    readFile(new URL("../public/assets/js/admin.js", import.meta.url), "utf8"),
    readFile(new URL("../public/assets/js/admin-ui.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="login-form"/);
  assert.match(html, /data-admin-app hidden/);
  assert.match(authScript, /import \{ setAuthenticated \} from "\.\/admin-ui\.js"/);
  assert.match(authScript, /sendRequest\("session"\)/);
  assert.match(authScript, /setAuthenticated\(isAdmin\)/);
  assert.match(catalogScript, /const catalogEndpoint = "\/\.netlify\/functions\/catalog"/);
  assert.doesNotMatch(catalogScript, /const authEndpoint/);
});

test("catalog initialization is explicit, confirmed, and only available in the admin app", async () => {
  const [html, uiScript] = await Promise.all([
    readFile(new URL("../public/admin.html", import.meta.url), "utf8"),
    readFile(new URL("../public/assets/js/admin-ui.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /data-admin-app hidden/);
  assert.match(html, /data-catalog-initialize[^>]*>Initialiser le catalogue</);
  assert.match(uiScript, /initializeCatalogButton\?\.addEventListener\("click"/);
  assert.match(uiScript, /window\.confirm\(/);
  assert.match(uiScript, /controller\.initializeCatalog\(\)/);
  assert.doesNotMatch(uiScript, /x-catalog-initialization-secret|CATALOG_INITIALIZATION_SECRET/i);
});

test("catalog initialization sends only a same-origin POST and handles both successful outcomes", async () => {
  const calls = [];
  const results = ["initialized", "already_exists"];
  const controller = createAdminCatalogController(async (url, options) => {
    calls.push({ url, options });
    return response(200, { result: results.shift() }, null);
  });

  assert.equal(await controller.initializeCatalog(), "initialized");
  assert.equal(await controller.initializeCatalog(), "already_exists");
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.equal(url, "/.netlify/functions/initialize-catalog");
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.equal(options.body, undefined);
    assert.equal(options.headers, undefined);
    assert.doesNotMatch(JSON.stringify(options), /secret|token/i);
  }
});

test("catalog initialization reports server refusals as errors", async () => {
  const controller = createAdminCatalogController(async () =>
    response(403, { result: "refused" }, null)
  );
  await assert.rejects(controller.initializeCatalog(), (error) =>
    error instanceof AdminCatalogError &&
    error.status === 403 &&
    error.message.includes("administrateur")
  );
});

const product = (overrides = {}) => ({
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: { fr: "Produit FR", en: "Product EN" },
  description: { fr: "Description FR", en: "Description EN" },
  price: 4200,
  currency: "XOF",
  image: "assets/images/product.jpg",
  category: "Guides",
  chariowProductId: "prd_product_123",
  available: true,
  published: true,
  archivedAt: null,
  ...overrides
});

const response = (status, body, etag = '"version-1"') =>
  new Response(JSON.stringify(body), {
    status,
    headers: etag ? { "Content-Type": "application/json", ETag: etag } : {}
  });

const catalogResponse = (products, etag) =>
  response(200, { products, product: products.at(-1) || null }, etag);

test("catalog reads and creates use no-store credentials and the current If-Match ETag", async () => {
  const calls = [];
  const saved = product();
  const controller = createAdminCatalogController(async (url, options) => {
    calls.push({ url, options });
    if (options.method === "POST") return catalogResponse([saved], '"version-2"');
    return catalogResponse([saved], '"version-1"');
  });

  await controller.load();
  await controller.mutate({
    method: "POST",
    body: {
      name: saved.name,
      description: saved.description,
      price: saved.price,
      currency: saved.currency,
      image: saved.image,
      category: saved.category,
      chariowProductId: saved.chariowProductId,
      available: true,
      published: true
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[1].options.headers["If-Match"], '"version-1"');
  assert.equal(controller.etag, '"version-2"');
});

test("archive and restore mutations preserve If-Match and update the catalog version", async () => {
  const calls = [];
  const archived = product({ archivedAt: "2026-03-01T00:00:00.000Z" });
  const controller = createAdminCatalogController(async (_url, options) => {
    calls.push(options);
    if (!options.method) return catalogResponse([product()], '"version-4"');
    return catalogResponse([archived], '"version-5"');
  });
  await controller.load({ archived: true });
  await controller.mutate({
    method: "PATCH",
    productId: product().id,
    body: { action: "archive" }
  });
  await controller.mutate({
    method: "PATCH",
    productId: product().id,
    body: { action: "restore" }
  });

  assert.equal(calls[0].method, undefined);
  assert.equal(calls[1].headers["If-Match"], '"version-4"');
  assert.equal(calls[2].headers["If-Match"], '"version-5"');
  assert.equal(controller.etag, '"version-5"');
});

test("a 412 blocks repeat submissions until the latest product and ETag are reloaded", async () => {
  let callCount = 0;
  const latest = product({ name: { fr: "Version serveur", en: "Server version" } });
  const controller = createAdminCatalogController(async (_url, options) => {
    callCount += 1;
    if (callCount === 1) return catalogResponse([product()], '"version-1"');
    if (callCount === 2) return response(412, { error: "CATALOG_CONFLICT" });
    if (callCount === 3) return catalogResponse([latest], '"version-2"');
    return catalogResponse([latest], '"version-3"');
  });
  await controller.load();
  const editEtag = controller.beginEdit(product());
  await assert.rejects(
    controller.mutate({ method: "PUT", productId: product().id, ifMatch: editEtag, body: product() }),
    (error) => error instanceof AdminCatalogError && error.status === 412
  );
  await assert.rejects(
    controller.mutate({ method: "PUT", productId: product().id, ifMatch: editEtag, body: product() }),
    (error) => error instanceof AdminCatalogError && error.status === 412
  );
  assert.equal(callCount, 2);

  const reloaded = await controller.reloadEdit(product().id);
  assert.equal(reloaded.product.name.fr, "Version serveur");
  assert.equal(reloaded.etag, '"version-2"');
  await controller.mutate({
    method: "PUT",
    productId: product().id,
    ifMatch: reloaded.etag,
    body: reloaded.product
  });
  assert.equal(callCount, 4);
  assert.equal(controller.etag, '"version-3"');
});

test("a failed conflict reload keeps the edit blocked", async () => {
  let callCount = 0;
  const controller = createAdminCatalogController(async () => {
    callCount += 1;
    if (callCount === 1) return catalogResponse([product()], '"version-1"');
    if (callCount === 2) return response(412, { error: "CATALOG_CONFLICT" });
    return response(503, { error: "CATALOG_UNAVAILABLE" });
  });
  await controller.load();
  controller.beginEdit(product());
  await assert.rejects(
    controller.mutate({ method: "PUT", productId: product().id, body: product() }),
    { status: 412 }
  );
  await assert.rejects(controller.reloadEdit(product().id), { status: 503 });
  await assert.rejects(
    controller.mutate({ method: "PUT", productId: product().id, body: product() }),
    { status: 412 }
  );
  assert.equal(callCount, 3);
});

test("HTTP authorization, missing-product, and stale-state errors remain explicit", async (t) => {
  for (const [status, message] of [
    [401, "session"],
    [403, "administrateur"],
    [404, "n’existe plus"],
    [409, "catalogue a changé"]
  ]) {
    await t.test(`HTTP ${status}`, async () => {
      const controller = createAdminCatalogController(async () => response(status, {}));
      await assert.rejects(controller.load(), (error) =>
        error instanceof AdminCatalogError &&
        error.status === status &&
        error.message.includes(message)
      );
    });
  }
});

test("network errors are surfaced instead of treated as successful requests", async () => {
  const controller = createAdminCatalogController(async () => {
    throw new Error("offline");
  });
  await assert.rejects(controller.load(), (error) =>
    error instanceof AdminCatalogError && error.status === 0 &&
    error.message.includes("Connexion impossible")
  );
});

test("simultaneous mutations issue only one request", async () => {
  let resolveResponse;
  let callCount = 0;
  const controller = createAdminCatalogController(() => {
    callCount += 1;
    return new Promise((resolve) => { resolveResponse = resolve; });
  });
  const first = controller.mutate({
    method: "POST",
    ifMatch: '"version-1"',
    body: { name: "test" }
  });
  await assert.rejects(
    controller.mutate({
      method: "POST",
      ifMatch: '"version-1"',
      body: { name: "duplicate" }
    }),
    /déjà en cours/
  );
  assert.equal(callCount, 1);
  resolveResponse(catalogResponse([product()], '"version-2"'));
  await first;
  assert.equal(callCount, 1);
});
