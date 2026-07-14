import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

async function transpileToTemp() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'loven7-image-proxy-check-'));
  const libDir = path.join(tempRoot, '_lib');
  const apiDir = path.join(tempRoot, 'api');
  await mkdir(libDir, { recursive: true });
  await mkdir(apiDir, { recursive: true });

  const files = [
    {
      from: new URL('../functions/_lib/http.ts', import.meta.url),
      to: path.join(libDir, 'http.mjs'),
      patch: (code) => code,
    },
    {
      from: new URL('../functions/api/image.ts', import.meta.url),
      to: path.join(apiDir, 'image.mjs'),
      patch: (code) => code.replace(/from\s+["']\.\.\/_lib\/http["'];/g, 'from "../_lib/http.mjs";'),
    },
  ];

  for (const file of files) {
    const source = await readFile(file.from, 'utf8');
    const output = ts.transpileModule(source, {
      fileName: file.from.pathname,
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    });
    const diagnostics = output.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) || [];
    if (diagnostics.length) {
      const messages = diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n');
      throw new Error(messages);
    }
    await writeFile(file.to, file.patch(output.outputText), 'utf8');
  }

  return { tempRoot, imageModulePath: path.join(apiDir, 'image.mjs') };
}

function requestFor(targetUrl) {
  return new Request(`https://mail.example.test/api/image?url=${encodeURIComponent(targetUrl)}`);
}

async function bodyJson(response) {
  return JSON.parse(await response.text());
}

async function expectStatus(handler, targetUrl, status, label, env = {}) {
  const response = await handler({ request: requestFor(targetUrl), env, params: {}, next: async () => new Response(null) });
  assert.equal(response.status, status, `${label}: status`);
  return response;
}

function makeChunkedBody(totalBytes, chunkSize = 64 * 1024) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
const calls = [];
const fetchRecords = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  calls.push(url.toString());
  fetchRecords.push({ url: url.toString(), signal: init.signal });

  if (url.hostname === 'cloudflare-dns.com') {
    const name = url.searchParams.get('name');
    if (name === 'rebinding.example') return Response.json({ Answer: [{ type: 1, data: '10.0.0.1' }] });
    if (name === 'unresolved.example') return Response.json({ Answer: [] });
    return Response.json({ Answer: [{ type: 1, data: '93.184.216.34' }] });
  }

  if (url.hostname === 'cdn.example.com' && url.pathname === '/ok.png') {
    return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  if (url.hostname === 'cdn.example.com' && url.pathname === '/octet-png') {
    return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  }
  if (url.hostname === 'cdn.example.com' && url.pathname === '/html') {
    return new Response('<html>not image</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }
  if (url.hostname === 'cdn.example.com' && url.pathname === '/svg') {
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
  }
  if (url.hostname === 'cdn.example.com' && url.pathname === '/too-large-length') {
    return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) } });
  }
  if (url.hostname === 'cdn.example.com' && url.pathname === '/too-large-stream') {
    return new Response(makeChunkedBody(MAX_IMAGE_BYTES + 1), { status: 200, headers: { 'content-type': 'image/png', 'content-length': '1' } });
  }
  if (url.hostname === 'cdn.example.com' && url.pathname === '/redirect-private') {
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret.png' } });
  }
  if (url.hostname === 'cdn.example.com' && url.pathname === '/redirect-ok') {
    return new Response(null, { status: 302, headers: { location: '/ok.png' } });
  }
  if (url.hostname === 'cdn.example.com' && url.pathname === '/slow.png') {
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  }
  if (url.hostname === 'rebinding.example' && url.pathname === '/private.png') {
    return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  if (url.hostname === 'unresolved.example' && url.pathname === '/must-not-fetch.png') {
    return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
  }

  throw new Error(`unexpected fetch ${url.toString()}`);
};

let tempRoot = '';
try {
  const compiled = await transpileToTemp();
  tempRoot = compiled.tempRoot;
  const { onRequestGet } = await import(`file://${compiled.imageModulePath.replace(/\\/g, '/')}`);

  const callsBeforeRateLimit = calls.length;
  await expectStatus(onRequestGet, 'https://cdn.example.com/ok.png', 429, 'optional rate limiter', {
    ASSET_PROXY_RATE_LIMITER: { limit: async () => ({ success: false }) },
  });
  assert.equal(calls.length, callsBeforeRateLimit, 'rate-limited image proxy performs no outbound fetch');

  const ok = await expectStatus(onRequestGet, 'https://cdn.example.com/ok.png', 200, 'valid png');
  assert.equal(ok.headers.get('content-type'), 'image/png', 'valid png content type');
  assert.equal(ok.headers.get('cache-control'), 'no-store, private, max-age=0', 'valid png cache control');
  assert.equal(new Uint8Array(await ok.arrayBuffer()).length, PNG_BYTES.length, 'valid png body length');

  const octetPng = await expectStatus(onRequestGet, 'https://cdn.example.com/octet-png', 200, 'octet-stream png magic');
  assert.equal(octetPng.headers.get('content-type'), 'image/png', 'octet-stream png normalized type');

  await expectStatus(onRequestGet, 'http://localhost/a.png', 400, 'localhost blocked');
  await expectStatus(onRequestGet, 'http://localhost./a.png', 400, 'localhost dot blocked');
  await expectStatus(onRequestGet, 'http://foo.localhost/a.png', 400, 'localhost subdomain blocked');
  await expectStatus(onRequestGet, 'http://127.0.0.1/a.png', 400, 'ipv4 loopback blocked');
  await expectStatus(onRequestGet, 'http://127.1/a.png', 400, 'short ipv4 loopback blocked');
  await expectStatus(onRequestGet, 'http://0177.0.0.1/a.png', 400, 'octal ipv4 loopback blocked');
  await expectStatus(onRequestGet, 'http://2130706433/a.png', 400, 'integer ipv4 loopback blocked');
  await expectStatus(onRequestGet, 'http://10.0.0.1/a.png', 400, 'private ipv4 blocked');
  await expectStatus(onRequestGet, 'http://169.254.169.254/latest/meta-data', 400, 'metadata ip blocked');
  await expectStatus(onRequestGet, 'http://[::1]/a.png', 400, 'ipv6 loopback blocked');
  await expectStatus(onRequestGet, 'http://[::ffff:127.0.0.1]/a.png', 400, 'ipv4 mapped ipv6 blocked');
  await expectStatus(onRequestGet, 'file:///etc/passwd', 400, 'file protocol blocked');
  await expectStatus(onRequestGet, 'data:image/png;base64,AAAA', 400, 'data protocol blocked');
  await expectStatus(onRequestGet, 'https://user:pass@cdn.example.com/a.png', 400, 'userinfo blocked');

  const redirectPrivate = await expectStatus(onRequestGet, 'https://cdn.example.com/redirect-private', 400, 'redirect to private blocked');
  assert.equal((await bodyJson(redirectPrivate)).error.code, 'bad_image_url', 'redirect private error code');

  const redirectRecordStart = fetchRecords.length;
  const redirectOk = await expectStatus(onRequestGet, 'https://cdn.example.com/redirect-ok', 200, 'relative redirect to public ok');
  assert.equal(redirectOk.headers.get('content-type'), 'image/png', 'relative redirect content type');
  const redirectRecords = fetchRecords.slice(redirectRecordStart);
  assert(redirectRecords.length >= 4, 'redirect request includes DNS checks and both fetch hops');
  assert(redirectRecords.every((item) => item.signal instanceof AbortSignal), 'total deadline signal covers DNS and every redirect hop');
  assert.equal(new Set(redirectRecords.map((item) => item.signal)).size, 1, 'one total deadline is shared across the complete redirect chain');

  await expectStatus(onRequestGet, 'https://cdn.example.com/too-large-length', 413, 'content-length limit');
  await expectStatus(onRequestGet, 'https://cdn.example.com/too-large-stream', 413, 'stream limit');
  await expectStatus(onRequestGet, 'https://cdn.example.com/html', 415, 'html rejected');
  await expectStatus(onRequestGet, 'https://cdn.example.com/svg', 415, 'svg rejected');
  await expectStatus(onRequestGet, 'https://rebinding.example/private.png', 400, 'private DNS answer rejected');
  const unresolvedFetchesBefore = calls.filter((url) => new URL(url).hostname === 'unresolved.example').length;
  const unresolved = await expectStatus(onRequestGet, 'https://unresolved.example/must-not-fetch.png', 502, 'unresolved DNS target rejected');
  assert.equal((await bodyJson(unresolved)).error.code, 'image_dns_failed', 'unresolved target error code');
  assert.equal(
    calls.filter((url) => new URL(url).hostname === 'unresolved.example').length,
    unresolvedFetchesBefore,
    'unresolved target is never fetched',
  );

  const slowStartedAt = Date.now();
  const slow = await expectStatus(onRequestGet, 'https://cdn.example.com/slow.png', 504, 'one total deadline bounds a slow target', {
    ASSET_PROXY_DEADLINE_MS: 50,
  });
  assert.equal((await bodyJson(slow)).error.code, 'image_fetch_timeout', 'slow target timeout error code');
  assert(Date.now() - slowStartedAt < 1000, 'test deadline aborts the whole image request promptly');

  const cacheValues = new Map();
  globalThis.caches = { default: {
    match: async (request) => cacheValues.get(request.url)?.clone(),
    put: async (request, response) => cacheValues.set(request.url, response.clone()),
  } };
  const upstreamBeforeCache = calls.filter((url) => url.includes('/ok.png')).length;
  const firstCached = await onRequestGet({
    request: new Request(`https://mail.example.test/api/image?noise=one&url=${encodeURIComponent('https://cdn.example.com/ok.png')}`),
    env: {}, params: {}, next: async () => new Response(null),
  });
  const secondCached = await onRequestGet({
    request: new Request(`https://mail.example.test/api/image?url=${encodeURIComponent('https://cdn.example.com/ok.png')}&noise=two`),
    env: {}, params: {}, next: async () => new Response(null),
  });
  assert.equal(firstCached.status, 200, 'canonical image cache first response');
  assert.equal(secondCached.status, 200, 'canonical image cache second response');
  assert.equal(calls.filter((url) => url.includes('/ok.png')).length - upstreamBeforeCache, 1, 'outer query noise cannot bypass image cache');

  const htmlBeforeNegativeCache = calls.filter((url) => new URL(url).pathname === '/html').length;
  const firstNegative = await onRequestGet({
    request: new Request(`https://mail.example.test/api/image?url=${encodeURIComponent('https://cdn.example.com/html')}&noise=one`),
    env: {}, params: {}, next: async () => new Response(null),
  });
  const secondNegative = await onRequestGet({
    request: new Request(`https://mail.example.test/api/image?noise=two&url=${encodeURIComponent('https://cdn.example.com/html')}`),
    env: {}, params: {}, next: async () => new Response(null),
  });
  assert.equal(firstNegative.status, 415, 'negative image cache first response');
  assert.equal(secondNegative.status, 415, 'negative image cache second response');
  assert.equal(calls.filter((url) => new URL(url).pathname === '/html').length - htmlBeforeNegativeCache, 1, 'deterministic proxy rejection is negatively cached');

  let localLimitedStatus = 0;
  for (let index = 0; index < 61; index += 1) {
    const response = await onRequestGet({
      request: new Request(`https://mail.example.test/api/image?url=${encodeURIComponent('file:///blocked')}`, {
        headers: { 'cf-connecting-ip': '198.51.100.44' },
      }),
      env: {}, params: {}, next: async () => new Response(null),
    });
    localLimitedStatus = response.status;
  }
  assert.equal(localLimitedStatus, 429, 'per-isolate fallback bucket limits requests when no distributed binding exists');

  console.log(JSON.stringify({
    ok: true,
    checked: [
      'valid image',
      'octet-stream magic image',
      'blocked local/private/ip-literal/protocol/userinfo urls',
      'safe redirect handling',
      'content-length and streaming size limits',
      'mime allowlist',
      'private DNS answer rejection',
      'empty DNS answer rejection',
      'optional rate limiter and canonical cache',
      'negative cache and local fallback rate limit',
      'single total deadline across DNS and redirect hops',
    ],
    fetchCalls: calls.length,
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}
