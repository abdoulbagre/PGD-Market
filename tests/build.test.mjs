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
    "panier.html",
    "commande.html",
    "success.html",
    "contact.html",
    "mentions-legales.html",
    "politique-confidentialite.html",
    "admin.html"
  ]) {
    await access(path.join(outputDirectory, route));
  }

  for (const asset of [
    "assets/css/style.css",
    "assets/css/admin.css",
    "assets/js/app.js",
    "assets/js/admin.js",
    "assets/js/admin-ui.js",
    "assets/images/1.jpg",
    "locales/fr.json"
  ]) {
    await access(path.join(outputDirectory, asset));
  }

  const adminPage = await readFile(path.join(outputDirectory, "admin.html"), "utf8");
  assert.match(adminPage, /assets\/css\/admin\.css/);
  assert.match(adminPage, /assets\/js\/admin\.js/);
  await assert.rejects(access(path.join(outputDirectory, "backend")));
  await assert.rejects(access(path.join(outputDirectory, "tests")));
  await assert.rejects(access(path.join(outputDirectory, ".agents")));
});
