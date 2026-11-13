import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(?:html|css|mjs|js)$/.test(entry.name) ? [entryPath] : [];
  }));
  return nested.flat();
};

test("frontend and backend modules do not import each other's source trees", async () => {
  const frontendFiles = await sourceFiles(path.join(projectRoot, "frontend"));
  const backendFiles = await sourceFiles(path.join(projectRoot, "backend"));
  const frontendImport = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["'][^"']*(?:backend|netlify\/(?:functions|lib)|public)\//;
  const backendImport = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["'][^"']*(?:frontend|public)\//;

  for (const file of frontendFiles) {
    assert.doesNotMatch(await readFile(file, "utf8"), frontendImport, path.relative(projectRoot, file));
  }
  for (const file of backendFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, backendImport, path.relative(projectRoot, file));
    assert.doesNotMatch(source, /public\/assets\/js\/products\.js/, path.relative(projectRoot, file));
    assert.doesNotMatch(source, /\b(?:window|document)\b/, path.relative(projectRoot, file));
  }
  await assert.rejects(access(path.join(projectRoot, "public")));
  await assert.rejects(access(path.join(projectRoot, "netlify")));
});
