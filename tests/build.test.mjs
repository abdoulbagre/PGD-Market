import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = path.join(projectRoot, "dist");

test("build publishes storefront and admin routes without backend sources", async () => {
  const build = spawnSync(process.execPath, ["scripts/build.mjs"], {
    cwd: projectRoot,
    encoding: "utf8"
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  for (const route of [
    "index.html",
    "boutique.html",
    "produit.html",
    "commande.html",
    "contact.html",
    "mentions-legales.html",
    "politique-confidentialite.html",
    "admin.html"
  ]) {
    await access(path.join(outputDirectory, route));
  }
  await assert.rejects(access(path.join(outputDirectory, "success.html")));
  await assert.rejects(access(path.join(outputDirectory, "panier.html")));

  for (const asset of [
    "assets/css/style.css",
    "assets/css/admin.css",
    "assets/js/app.js",
    "assets/js/admin.js",
    "assets/js/admin-ui.js",
    "assets/Background/logo-bronze.png",
    "assets/payments/visa.svg",
    "locales/fr.json"
  ]) {
    await access(path.join(outputDirectory, asset));
  }
  await assert.rejects(access(path.join(outputDirectory, "assets/images/1.jpg")));

  const adminPage = await readFile(path.join(outputDirectory, "admin.html"), "utf8");
  assert.match(adminPage, /assets\/css\/admin\.css/);
  assert.match(adminPage, /assets\/js\/admin\.js/);
  const catalogScripts = await Promise.all([
    readFile(path.join(outputDirectory, "assets/js/app.js"), "utf8"),
    readFile(path.join(outputDirectory, "assets/js/catalog.js"), "utf8")
  ]);
  assert.doesNotMatch(catalogScripts.join("\n"), /catalog-seed\.json/i);
  await assert.rejects(access(path.join(outputDirectory, "backend")));
  await assert.rejects(access(path.join(outputDirectory, "tests")));
  await assert.rejects(access(path.join(outputDirectory, ".agents")));
});
