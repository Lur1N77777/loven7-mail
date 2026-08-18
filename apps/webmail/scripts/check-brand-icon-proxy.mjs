import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileTypeScriptFiles } from './typescript-compile.mjs';

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

async function importRoute(sourceUrl, label) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), `loven7-brand-${label}-`));
  const sourcePath = fileURLToPath(sourceUrl);
  const sourceRoot = fileURLToPath(new URL(label === 'webmail' ? '../functions/' : '../../admin/functions/', import.meta.url));
  await compileTypeScriptFiles({ sourceRoot, rootFiles: [sourcePath], outDir: tempRoot });
  const routePath = path.join(tempRoot, 'api', 'brand-icon.js');
  return { tempRoot, route: await import(pathToFileURL(routePath).href) };
}

class MemoryCache {
  constructor() {
    this.values = new Map();
  }
  async match(request) {
    return this.values.get(request.url)?.clone() || undefined;
  }
  async put(request, response) {
    this.values.set(request.url, response.clone());
  }
}

function htmlStream(totalBytes, counter) {
  const prefix = new TextEncoder().encode('<!doctype html><html><head>');
  let sentPrefix = false;
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (!sentPrefix) {
        sentPrefix = true;
        counter.bytes += prefix.byteLength;
        controller.enqueue(prefix);
        return;
      }
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(64 * 1024, totalBytes - sent);
      sent += size;
      counter.bytes += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
    cancel() {
      counter.cancelled = true;
    },
  });
}

function dnsResponse(address = '93.184.216.34') {
  return Response.json({ Status: 0, Answer: address ? [{ type: 1, data: address }] : [] });
}

const routes = [
  ['webmail', new URL('../functions/api/brand-icon.ts', import.meta.url)],
  ['admin', new URL('../../admin/functions/api/brand-icon.ts', import.meta.url)],
];

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;

try {
  for (const [label, sourceUrl] of routes) {
    const compiled = await importRoute(sourceUrl, label);
    try {
      const handler = compiled.route.onRequestGet;

      // Optional Cloudflare rate-limit bindings fail before any outbound request.
      {
        let fetches = 0;
        globalThis.fetch = async () => {
          fetches += 1;
          return new Response(null, { status: 404 });
        };
        const response = await handler({
          request: new Request('https://mail.example.test/api/brand-icon?domain=example.com'),
          env: { ASSET_PROXY_RATE_LIMITER: { limit: async () => ({ success: false }) } },
        });
        assert.equal(response.status, 429, `${label}: optional rate limiter`);
        assert.equal(fetches, 0, `${label}: rate-limited request performs no fetch`);
      }

      {
        let status = 0;
        for (let index = 0; index < 61; index += 1) {
          const response = await handler({
            request: new Request('https://mail.example.test/api/brand-icon?domain=invalid', {
              headers: { 'cf-connecting-ip': label === 'webmail' ? '198.51.100.51' : '198.51.100.52' },
            }),
            env: {},
          });
          status = response.status;
        }
        assert.equal(status, 429, `${label}: local fallback bucket protects an unbound deployment`);
      }

      // A declared site icon must win over guessed conventional paths. Sites such as
      // Notion return 404 for /favicon.ico but publish a valid icon in their HTML.
      {
        globalThis.fetch = async (input, init = {}) => {
          const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
          if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
          if (url.hostname === 'cloudflare-dns.com' || url.hostname === '1.1.1.1' || url.hostname === '1.0.0.1') return dnsResponse();
          if (url.hostname === 'notion.so' && url.pathname === '/') {
            return new Response('<link rel="icon" href="/front-static/favicon.ico">', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.hostname === 'notion.so' && url.pathname === '/front-static/favicon.ico') {
            return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
          }
          if (url.hostname === 'notion.so' || url.hostname === 'www.notion.so') {
            return new Promise((resolve, reject) => {
              if (init.signal?.aborted) {
                reject(new DOMException('aborted', 'AbortError'));
                return;
              }
              init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
            });
          }
          return new Response(null, { status: 404 });
        };
        const response = await handler({
          request: new Request('https://mail.example.test/api/brand-icon?domain=notion.so', {
            headers: { 'cf-connecting-ip': label === 'webmail' ? '198.51.100.61' : '198.51.100.62' },
          }),
          env: { ASSET_PROXY_DEADLINE_MS: 50 },
        });
        assert.equal(response.status, 200, `${label}: HTML-declared Notion icon loads before guessed paths time out`);
      }

      // DNS validation is a security boundary. An empty resolution must fail
      // closed without trying the target through a different resolver view.
      {
        let targetFetches = 0;
        globalThis.fetch = async (input) => {
          const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
          if (url.hostname === 'cloudflare-dns.com' || url.hostname === '1.1.1.1' || url.hostname === '1.0.0.1') return dnsResponse('');
          targetFetches += 1;
          return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
        };
        const response = await handler({ request: new Request('https://mail.example.test/api/brand-icon?domain=unresolved.example'), env: {} });
        assert.equal(response.status, 404, `${label}: empty DNS answer is rejected`);
        assert.equal(targetFetches, 0, `${label}: unresolved brand target is never fetched`);
      }

      // IPv4-mapped IPv6 discovered in HTML must never be fetched.
      {
        let privateFetches = 0;
        globalThis.fetch = async (input) => {
          const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
          if (url.hostname === 'cloudflare-dns.com' || url.hostname === '1.1.1.1' || url.hostname === '1.0.0.1') return dnsResponse();
          if (url.hostname === 'example.com' && url.pathname === '/') {
            return new Response('<link rel="icon" href="http://[::ffff:127.0.0.1]/secret.png">', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.hostname.includes('127.0.0.1') || url.hostname.includes('::ffff')) {
            privateFetches += 1;
            return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
          }
          return new Response(null, { status: 404 });
        };
        const response = await handler({ request: new Request('https://mail.example.test/api/brand-icon?domain=example.com'), env: {} });
        assert.equal(response.status, 404, `${label}: private HTML icon is rejected`);
        assert.equal(privateFetches, 0, `${label}: IPv4-mapped IPv6 is never fetched`);
      }

      // Automatic redirects hide the destination from validation; every hop must be manual.
      {
        let followedPrivate = 0;
        globalThis.fetch = async (input, init = {}) => {
          const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
          if (url.hostname === 'cloudflare-dns.com' || url.hostname === '1.1.1.1' || url.hostname === '1.0.0.1') return dnsResponse();
          if (url.hostname === 'example.com' && url.pathname === '/') return new Response('', { status: 200, headers: { 'content-type': 'text/html' } });
          if (url.hostname === 'example.com') {
            if (init.redirect === 'follow') {
              followedPrivate += 1;
              return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
            }
            return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret.png' } });
          }
          return new Response(null, { status: 404 });
        };
        const response = await handler({ request: new Request('https://mail.example.test/api/brand-icon?domain=example.com'), env: {} });
        assert.equal(response.status, 404, `${label}: redirect to private target is rejected`);
        assert.equal(followedPrivate, 0, `${label}: fetch never auto-follows an unvalidated redirect`);
      }

      // HTML discovery reads only its configured prefix and cancels an oversized stream.
      {
        const counter = { bytes: 0, cancelled: false };
        globalThis.fetch = async (input) => {
          const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
          if (url.hostname === 'cloudflare-dns.com' || url.hostname === '1.1.1.1' || url.hostname === '1.0.0.1') return dnsResponse();
          if (url.hostname === 'example.com' && url.pathname === '/') {
            return new Response(htmlStream(2 * 1024 * 1024, counter), { status: 200, headers: { 'content-type': 'text/html' } });
          }
          return new Response(null, { status: 404 });
        };
        await handler({ request: new Request('https://mail.example.test/api/brand-icon?domain=example.com'), env: {} });
        assert(counter.bytes <= 384 * 1024, `${label}: HTML stream is bounded, read ${counter.bytes}`);
      }

      // Cache identity is canonical: unrelated query parameters cannot bypass it.
      {
        const cache = new MemoryCache();
        globalThis.caches = { default: cache };
        let iconFetches = 0;
        const cacheCalls = [];
        globalThis.fetch = async (input) => {
          const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
          cacheCalls.push(url.toString());
          if (url.hostname === 'cloudflare-dns.com' || url.hostname === '1.1.1.1' || url.hostname === '1.0.0.1') return dnsResponse();
          if (url.hostname === 'cachetest.example.com' && url.pathname === '/apple-touch-icon.png') {
            iconFetches += 1;
            return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
          }
          if (url.hostname === 'cachetest.example.com' && url.pathname === '/') return new Response('', { status: 200, headers: { 'content-type': 'text/html' } });
          return new Response(null, { status: 404 });
        };
        const first = await handler({ request: new Request('https://mail.example.test/api/brand-icon?domain=cachetest.example.com&size=32&noise=one'), env: {} });
        const second = await handler({ request: new Request('https://mail.example.test/api/brand-icon?noise=two&size=96&domain=cachetest.example.com'), env: {} });
        const firstText = first.status === 200 ? '' : await first.clone().text();
        assert.equal(first.status, 200, `${label}: first canonical cache request; calls=${cacheCalls.join(' | ')} cache=${[...cache.values.keys()].join(' | ')} body=${firstText}`);
        assert.equal(second.status, 200, `${label}: second canonical cache request`);
        assert.equal(iconFetches, 1, `${label}: canonical cache prevents query bypass`);
        globalThis.caches = originalCaches;
      }
    } finally {
      await rm(compiled.tempRoot, { recursive: true, force: true });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    checked: [
      'admin and webmail brand icon rate-limit hook',
      'IPv4/IPv6 private target and redirect rejection',
      'empty DNS answer fail-closed',
      'bounded HTML streaming',
      'canonical cache key',
    ],
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
}
