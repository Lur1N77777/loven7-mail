import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

async function transpileHttpToTemp() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'loven7-share-cors-check-'));
  const libDir = path.join(tempRoot, '_lib');
  await mkdir(libDir, { recursive: true });

  for (const name of ['types', 'http']) {
    const sourceUrl = new URL(`../functions/_lib/${name}.ts`, import.meta.url);
    const source = await readFile(sourceUrl, 'utf8');
    const output = ts.transpileModule(source, {
      fileName: sourceUrl.pathname,
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
    const patched = output.outputText.replace(/from\s+["']\.\/types["'];/g, 'from "./types.mjs";');
    await writeFile(path.join(libDir, `${name}.mjs`), patched, 'utf8');
  }

  return { tempRoot, httpModulePath: path.join(libDir, 'http.mjs') };
}

function req(url, origin, extra = {}) {
  const headers = new Headers(extra.headers || {});
  if (origin) headers.set('origin', origin);
  return new Request(url, { method: extra.method || 'GET', headers });
}

function assertAllowed(headers, origin, label) {
  assert.equal(headers.get('access-control-allow-origin'), origin, `${label}: allowed origin`);
  assert.equal(headers.get('vary'), 'Origin', `${label}: vary`);
}

function assertNotAllowed(headers, label) {
  assert.equal(headers.get('access-control-allow-origin'), null, `${label}: no allowed origin`);
  assert.equal(headers.get('access-control-allow-headers'), null, `${label}: no allowed headers`);
  assert.equal(headers.get('access-control-allow-methods'), null, `${label}: no allowed methods`);
  assert.equal(headers.get('vary'), 'Origin', `${label}: vary`);
}

function assertAdminHeaders(headers, label) {
  assert.equal(headers.get('access-control-allow-methods'), 'GET,POST,PATCH,DELETE,OPTIONS', `${label}: admin methods`);
  assert.equal(headers.get('access-control-allow-headers'), 'authorization,content-type,x-admin-auth,x-custom-auth,x-lang,x-user-access-token,x-user-token', `${label}: admin headers`);
}

function assertPublicHeaders(headers, label) {
  assert.equal(headers.get('access-control-allow-methods'), 'GET,DELETE,OPTIONS', `${label}: public methods`);
  assert.equal(headers.get('access-control-allow-headers'), 'content-type,x-lang', `${label}: public headers`);
}

let tempRoot = '';
try {
  const compiled = await transpileHttpToTemp();
  tempRoot = compiled.tempRoot;
  const { corsHeaders, errorJson, withCors } = await import(`file://${compiled.httpModulePath.replace(/\\/g, '/')}`);

  const env = {
    SHARE_ADMIN_CORS_ORIGINS: 'https://admin.example.com, http://localhost:5173',
    SHARE_PUBLIC_CORS_ORIGINS: 'https://viewer.example.com',
  };

  const adminAllowed = corsHeaders(
    req('https://mail.example.com/api/share/admin/list', 'https://admin.example.com'),
    env,
    'admin'
  );
  assertAllowed(new Headers(adminAllowed), 'https://admin.example.com', 'admin configured origin');
  assertAdminHeaders(new Headers(adminAllowed), 'admin configured origin');

  const adminLocal = corsHeaders(
    req('http://localhost:8788/api/share/admin/list', 'http://localhost:5173'),
    {},
    'admin'
  );
  assertAllowed(new Headers(adminLocal), 'http://localhost:5173', 'admin local dev');
  assertAdminHeaders(new Headers(adminLocal), 'admin local dev');

  const adminSameOrigin = corsHeaders(
    req('https://mail.example.com/api/share/admin/list', 'https://mail.example.com'),
    {},
    'admin'
  );
  assertAllowed(new Headers(adminSameOrigin), 'https://mail.example.com', 'admin same origin');
  assertAdminHeaders(new Headers(adminSameOrigin), 'admin same origin');

  const adminBlocked = corsHeaders(
    req('https://mail.example.com/api/share/admin/list', 'https://evil.example.com'),
    env,
    'admin'
  );
  assertNotAllowed(new Headers(adminBlocked), 'admin blocked origin');

  const adminErrorReadable = withCors(
    errorJson(401, '缺少管理员凭证', 'missing_admin_auth'),
    req('https://mail.example.com/api/share/admin/list', 'https://admin.example.com'),
    env,
    'admin'
  );
  assertAllowed(adminErrorReadable.headers, 'https://admin.example.com', 'admin error readable');
  assertAdminHeaders(adminErrorReadable.headers, 'admin error readable');

  const publicSameOrigin = corsHeaders(
    req('https://mail.example.com/api/share/token', 'https://mail.example.com'),
    {},
    'public'
  );
  assertAllowed(new Headers(publicSameOrigin), 'https://mail.example.com', 'public same origin');
  assertPublicHeaders(new Headers(publicSameOrigin), 'public same origin');

  const publicAllowed = corsHeaders(
    req('https://mail.example.com/api/share/token', 'https://viewer.example.com'),
    env,
    'public'
  );
  assertAllowed(new Headers(publicAllowed), 'https://viewer.example.com', 'public configured origin');
  assertPublicHeaders(new Headers(publicAllowed), 'public configured origin');

  const publicBlocked = corsHeaders(
    req('https://mail.example.com/api/share/token', 'https://evil.example.com'),
    env,
    'public'
  );
  assertNotAllowed(new Headers(publicBlocked), 'public blocked origin');

  const noOrigin = corsHeaders(req('https://mail.example.com/api/share/token', ''), env, 'public');
  assertNotAllowed(new Headers(noOrigin), 'no origin request');

  console.log(JSON.stringify({
    ok: true,
    checked: [
      'admin allowlist',
      'admin local dev',
      'admin same-origin',
      'admin blocked origin',
      'admin readable error response',
      'public same-origin',
      'public allowlist',
      'public blocked origin',
      'no-origin behavior',
    ],
  }, null, 2));
} finally {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}
