import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildSessionCacheKey, clearJwtFromHref, readJwtFromHref } from "../src/auth.ts";
import { subscribeAuthenticationFailures } from "../src/authFailure.ts";
import { ApiError, fetchSafeSettings } from "../src/api.ts";
import { prepareMailboxCachePayload } from "../src/cache.ts";
import { isChunkLoadError } from "../src/appRecovery.ts";
import { reconcileServerMailRange } from "../src/mailSync.ts";
import { buildMailFrameSrcDoc, isSafeNavigationUrl, sanitizeMailHtml } from "../src/mailParser.ts";
import { proxyMailImageSrcset, proxyMailImageUrl } from "../src/mailImageProxy.ts";

test("webmail sanitizer fails closed when DOMParser is unavailable", () => {
  const sanitized = sanitizeMailHtml(
    '<p>Hello</p><a href="javascript:alert(1)">Open</a><img src=x onerror=alert(1)><script>alert(1)</script>'
  );
  assert.match(sanitized, /Hello/);
  assert.doesNotMatch(sanitized, /<(?:a|img|script)\b|javascript:|onerror/i);
});

test("webmail navigation URL policy uses an explicit scheme allowlist", () => {
  assert.equal(isSafeNavigationUrl("https://example.com/path"), true);
  assert.equal(isSafeNavigationUrl("/relative/path"), true);
  assert.equal(isSafeNavigationUrl("mailto:user@example.com"), true);
  assert.equal(isSafeNavigationUrl("data:image/png;base64,AA=="), true);
  assert.equal(isSafeNavigationUrl("javascript:alert(1)"), false);
  assert.equal(isSafeNavigationUrl("java\nscript:alert(1)"), false);
  assert.equal(isSafeNavigationUrl("vbscript:msgbox(1)"), false);
  assert.equal(isSafeNavigationUrl("file:///etc/passwd"), false);
  assert.equal(isSafeNavigationUrl("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isSafeNavigationUrl("data:image/svg+xml,<svg onload=alert(1)>"), false);
});

test("webmail routes remote mail images through its same-origin proxy", () => {
  assert.equal(
    proxyMailImageUrl("https://assets.example.com/notion-logo.png", "https://mail.example.test"),
    "https://mail.example.test/api/image?url=https%3A%2F%2Fassets.example.com%2Fnotion-logo.png",
  );
  assert.equal(proxyMailImageUrl("data:image/png;base64,AA==", "https://mail.example.test"), "data:image/png;base64,AA==");
  assert.equal(proxyMailImageUrl("javascript:alert(1)", "https://mail.example.test"), "");
  assert.equal(
    proxyMailImageSrcset(
      "data:image/png;base64,AA== 1x, https://assets.example.com/notion-logo.png 2x",
      "https://mail.example.test",
    ),
    "data:image/png;base64,AA== 1x, https://mail.example.test/api/image?url=https%3A%2F%2Fassets.example.com%2Fnotion-logo.png 2x",
  );
});

test("webmail keeps brand avatar frames full-size while centering icons at 75 percent", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.brand-avatar img\s*\{[^}]*width:\s*75%\s*!important;[^}]*height:\s*75%\s*!important;[^}]*object-fit:\s*contain\s*!important;[^}]*clip-path:\s*none\s*!important;/s);
});

test("mailbox cache key is isolated by API origin and mailbox identity", async () => {
  const first = await buildSessionCacheKey("https://mail-a.example", "user@example.com", "jwt-a");
  const otherApi = await buildSessionCacheKey("https://mail-b.example", "user@example.com", "jwt-a");
  const otherAccount = await buildSessionCacheKey("https://mail-a.example", "other@example.com", "jwt-a");
  assert.notEqual(first, otherApi);
  assert.notEqual(first, otherAccount);
});

test("cache truncation keeps offset contiguous and enforces a byte budget", () => {
  const mails = Array.from({ length: 500 }, (_, index) => ({
    id: 500 - index,
    subject: `mail-${index}`,
    preview: "x".repeat(1_000),
    raw: "r".repeat(30_000),
    html: `<p>${"h".repeat(30_000)}</p>`,
    text: "t".repeat(30_000),
    createdAt: new Date(1_700_000_000_000 - index).toISOString(),
  }));
  const prepared = prepareMailboxCachePayload({
    cacheKey: "scope",
    address: "user@example.com",
    updatedAt: "",
    nextOffset: 500,
    mails,
  }, 512_000);
  const bytes = new TextEncoder().encode(JSON.stringify(prepared)).byteLength;
  assert.ok(prepared.mails.length <= 300);
  assert.equal(prepared.nextOffset, prepared.mails.length);
  assert.ok(bytes <= 512_000, `cache payload uses ${bytes} bytes`);
});

test("authoritative scan removes deleted ghost messages but preserves older unscanned rows", () => {
  const existing = [5, 4, 3, 2, 1].map((id) => ({ id }));
  const reconciled = reconcileServerMailRange(existing, new Set([5, 3]), 3, false);
  assert.deepEqual(reconciled.map((mail) => mail.id), [5, 3, 2, 1]);
});

test("JWT links use fragments and legacy query links remain readable", () => {
  assert.equal(readJwtFromHref("https://mail.example/#JWT=fragment-token"), "fragment-token");
  assert.equal(readJwtFromHref("https://mail.example/?JWT=legacy-token"), "legacy-token");
  assert.equal(clearJwtFromHref("https://mail.example/?JWT=secret&view=inbox#JWT=secret-2&theme=dark"), "/?view=inbox#theme=dark");
});

test("mail HTML allows only the same-origin image proxy inside a scriptless frame", () => {
  const document = buildMailFrameSrcDoc('<img src="https://tracker.example/pixel.gif"><p>Hello</p>');
  assert.match(document, /sandboxed-mail|loven7-render-root/);
  assert.match(document, /img-src data: blob: https:\/\/mail\.invalid;/);
  assert.doesNotMatch(document, /img-src data: blob: https: http:/);
  assert.doesNotMatch(document, /<script/i);
});

test("chunk load failures are recognized for recoverable update UI", () => {
  assert.equal(isChunkLoadError(new Error("Failed to fetch dynamically imported module")), true);
  assert.equal(isChunkLoadError(new Error("ordinary validation failure")), false);
});

test("webmail keeps HTTP status and invalidates only runtime 401/403 responses", async () => {
  const originalFetch = globalThis.fetch;
  const observedStatuses: number[] = [];
  const unsubscribe = subscribeAuthenticationFailures((error) => observedStatuses.push(error.status));
  let mode: "401" | "403" | "503" | "network" = "401";
  globalThis.fetch = (async () => {
    if (mode === "network") throw new TypeError("network unavailable");
    const status = Number(mode);
    return new Response(JSON.stringify({ message: `status ${status}` }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await assert.rejects(fetchSafeSettings("active-token"), (error: unknown) => error instanceof ApiError && error.status === 401);
    mode = "403";
    await assert.rejects(fetchSafeSettings("active-token"), (error: unknown) => error instanceof ApiError && error.status === 403);
    mode = "503";
    await assert.rejects(fetchSafeSettings("active-token"), (error: unknown) => error instanceof ApiError && error.status === 503);
    mode = "network";
    await assert.rejects(fetchSafeSettings("active-token"), /network unavailable/);
    assert.deepEqual(observedStatuses, [401, 403]);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});
