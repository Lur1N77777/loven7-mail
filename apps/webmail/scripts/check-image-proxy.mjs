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
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

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

async function expectStatus(handler, targetUrl, status, label) {
  const response = await handler({ request: requestFor(targetUrl), env: {}, params: {}, next: async () => new Response(null) });
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
const calls = [];

globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  calls.push(url.toString());

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

  throw new Error(`unexpected fetch ${url.toString()}`);
};

let tempRoot = '';
try {
  const compiled = await transpileToTemp();
  tempRoot = compiled.tempRoot;
  const { onRequestGet } = await import(`file://${compiled.imageModulePath.replace(/\\/g, '/')}`);

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

  const redirectOk = await expectStatus(onRequestGet, 'https://cdn.example.com/redirect-ok', 200, 'relative redirect to public ok');
  assert.equal(redirectOk.headers.get('content-type'), 'image/png', 'relative redirect content type');

  await expectStatus(onRequestGet, 'https://cdn.example.com/too-large-length', 413, 'content-length limit');
  await expectStatus(onRequestGet, 'https://cdn.example.com/too-large-stream', 413, 'stream limit');
  await expectStatus(onRequestGet, 'https://cdn.example.com/html', 415, 'html rejected');
  await expectStatus(onRequestGet, 'https://cdn.example.com/svg', 415, 'svg rejected');

  console.log(JSON.stringify({
    ok: true,
    checked: [
      'valid image',
      'octet-stream magic image',
      'blocked local/private/ip-literal/protocol/userinfo urls',
      'safe redirect handling',
      'content-length and streaming size limits',
      'mime allowlist',
    ],
    fetchCalls: calls.length,
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}
