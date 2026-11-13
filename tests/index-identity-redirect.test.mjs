import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const html = readFileSync(new URL("../frontend/storefront/index.html", import.meta.url), "utf8");
const scriptMatch = html.match(/<script>\s*(const identityCallbackParams[\s\S]*?)<\/script>/);

assert.ok(scriptMatch, "The early Identity redirect script should exist.");
const redirectScript = scriptMatch[1];
const moduleScriptIndex = html.indexOf('<script type="module"');
assert.ok(moduleScriptIndex > scriptMatch.index, "The redirect should run before page modules.");

function getRedirect(pathname, hash) {
  const redirects = [];
  runInNewContext(redirectScript, {
    URLSearchParams,
    window: {
      location: {
        pathname,
        hash,
        replace: (url) => redirects.push(url)
      }
    }
  });
  return redirects;
}

test("does not redirect from the root without an Identity token", () => {
  assert.deepEqual(getRedirect("/", ""), []);
});

test("redirects recovery callbacks while preserving the exact fragment", () => {
  assert.deepEqual(
    getRedirect("/", "#recovery_token=TEST123"),
    ["/admin.html#recovery_token=TEST123"]
  );
});

test("redirects invitation callbacks while preserving the exact fragment", () => {
  assert.deepEqual(
    getRedirect("/", "#invite_token=TEST456"),
    ["/admin.html#invite_token=TEST456"]
  );
});

test("preserves encoded tokens and other fragment parameters unchanged", () => {
  const hash = "#recovery_token=TEST%2F123&state=keep%20this";
  assert.deepEqual(getRedirect("/", hash), [`/admin.html${hash}`]);
});

test("does not redirect for ordinary fragments or non-root paths", () => {
  assert.deepEqual(getRedirect("/", "#autre_parametre=TEST"), []);
  assert.deepEqual(getRedirect("/boutique.html", "#invite_token=TEST456"), []);
});
