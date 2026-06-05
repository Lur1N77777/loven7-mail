import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function importTsModule(relativePath) {
  const sourceUrl = new URL(relativePath, import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const transpiled = ts.transpileModule(source, {
    fileName: sourceUrl.pathname,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });

  const diagnostics = transpiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) || [];
  if (diagnostics.length) {
    const messages = diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n');
    throw new Error(`${relativePath}\n${messages}`);
  }

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText, 'utf8').toString('base64')}`;
  return import(moduleUrl);
}

const { errorJson, json, mapUpstreamError, RuntimeConfigError, runtimeConfigErrorJson, UpstreamError, withCors } =
  await importTsModule('../functions/_lib/http.ts');
const { runtimeDiagnostics } = await importTsModule('../functions/_lib/runtime.ts');

function assertNoStore(response, label) {
  assert.equal(response.headers.get('cache-control'), 'no-store, private, max-age=0', `${label}: Cache-Control`);
  assert.equal(response.headers.get('pragma'), 'no-cache', `${label}: Pragma`);
  assert.equal(response.headers.get('expires'), '0', `${label}: Expires`);
}

const ok = json({ ok: true });
assert.equal(ok.status, 200, 'json() default status');
assert.equal(ok.headers.get('content-type'), 'application/json;charset=utf-8', 'json() content type');
assert.equal(ok.headers.get('x-content-type-options'), 'nosniff', 'json() security header');
assertNoStore(ok, 'json()');

const custom = json({ ok: true }, {
  headers: {
    'cache-control': 'public, max-age=3600',
    'content-type': 'text/plain',
    'x-test-header': 'kept',
  },
});
assert.equal(custom.headers.get('x-test-header'), 'kept', 'json() keeps custom non-cache headers');
assert.equal(custom.headers.get('content-type'), 'application/json;charset=utf-8', 'json() keeps JSON content type');
assertNoStore(custom, 'json() override protection');

const missingJwt = errorJson(401, '请使用登录链接打开邮箱', 'missing_jwt');
assert.equal(missingJwt.status, 401, 'errorJson() status');
assertNoStore(missingJwt, 'errorJson()');

for (const code of ['mail_worker_not_configured', 'share_kv_not_configured', 'share_secret_not_configured']) {
  const configError = runtimeConfigErrorJson(code);
  const body = await configError.clone().json();
  assert.equal(configError.status, 500, `${code}: status`);
  assert.equal(body.error.code, code, `${code}: structured code`);
  assert.match(body.error.message, /Cloudflare Pages|SHARE_|MAIL_WORKER_BASE_URL/, `${code}: actionable message`);
  assert.doesNotMatch(body.error.message, /is not configured/i, `${code}: should not expose raw runtime error text`);
  assertNoStore(configError, `${code} response`);
}

const mappedConfigError = mapUpstreamError(new RuntimeConfigError('mail_worker_not_configured'));
const mappedBody = await mappedConfigError.clone().json();
assert.equal(mappedBody.error.code, 'mail_worker_not_configured', 'mapUpstreamError() keeps runtime config code');
assert.doesNotMatch(mappedBody.error.message, /is not configured/i, 'mapUpstreamError() hides raw runtime config text');

const mappedBodyOnlyConfigError = mapUpstreamError(new UpstreamError(500, '{"message":"SHARE_KV is not configured"}', 'Upstream request failed'));
const mappedBodyOnly = await mappedBodyOnlyConfigError.clone().json();
assert.equal(mappedBodyOnly.error.code, 'share_kv_not_configured', 'mapUpstreamError() detects runtime config code from body');
assert.doesNotMatch(mappedBodyOnly.error.message, /is not configured/i, 'mapUpstreamError() hides raw body-only runtime config text');

const corsResponse = withCors(
  json({ ok: true }),
  new Request('https://mail.example.test/api/share/token', {
    headers: { origin: 'https://admin.example.test' },
  }),
  { SHARE_PUBLIC_CORS_ORIGINS: 'https://admin.example.test' },
  'public'
);
assert.equal(corsResponse.headers.get('access-control-allow-origin'), 'https://admin.example.test', 'withCors() origin');
assert.equal(corsResponse.headers.get('vary'), 'Origin', 'withCors() vary');
assertNoStore(corsResponse, 'withCors(json())');

const missingRuntime = runtimeDiagnostics({});
assert.equal(missingRuntime.ok, false, 'runtimeDiagnostics() reports incomplete missing required bindings');
assert.deepEqual(
  missingRuntime.missing,
  ['MAIL_WORKER_BASE_URL', 'SHARE_KV', 'SHARE_ENCRYPTION_SECRET'],
  'runtimeDiagnostics() required missing list'
);
assert.deepEqual(
  missingRuntime.optionalMissing,
  ['SITE_PASSWORD', 'SHARE_ADMIN_CORS_ORIGINS'],
  'runtimeDiagnostics() optional missing list'
);
assert.match(missingRuntime.hints.join('\n'), /MAIL_WORKER_BASE_URL|SHARE_KV|SHARE_ENCRYPTION_SECRET/, 'runtimeDiagnostics() actionable hints');

const secretValue = 'super-secret-value-that-must-not-leak';
const completeRuntime = runtimeDiagnostics({
  MAIL_WORKER_BASE_URL: 'https://worker.example.test',
  SITE_PASSWORD: secretValue,
  SHARE_KV: { get: async () => null },
  SHARE_ENCRYPTION_SECRET: secretValue,
  SHARE_ADMIN_CORS_ORIGINS: 'https://admin.example.test',
});
assert.equal(completeRuntime.ok, true, 'runtimeDiagnostics() ready when required bindings exist');
assert.deepEqual(completeRuntime.missing, [], 'runtimeDiagnostics() has no required missing values');
assert.deepEqual(completeRuntime.optionalMissing, [], 'runtimeDiagnostics() has no optional missing values');
assert.doesNotMatch(JSON.stringify(completeRuntime), new RegExp(secretValue), 'runtimeDiagnostics() never leaks secret values');

console.log(JSON.stringify({
  ok: true,
  checked: [
    'json',
    'errorJson',
    'runtimeConfigErrorJson',
    'mapUpstreamError(runtime config)',
    'mapUpstreamError(body-only config)',
    'withCors(json)',
    'runtimeDiagnostics(missing)',
    'runtimeDiagnostics(complete, no secret leak)',
  ],
  cacheControl: ok.headers.get('cache-control'),
}, null, 2));
