import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

async function walk(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(full);
  }
  return result;
}

async function compileTree(sourceRoot, label) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), `loven7-${label}-`));
  for (const sourcePath of await walk(sourceRoot)) {
    const relative = path.relative(sourceRoot, sourcePath);
    const outputPath = path.join(tempRoot, relative.replace(/\.ts$/, '.mjs'));
    await mkdir(path.dirname(outputPath), { recursive: true });
    const source = await readFile(sourcePath, 'utf8');
    const output = ts.transpileModule(source, {
      fileName: sourcePath,
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    });
    const diagnostics = output.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) || [];
    if (diagnostics.length) {
      throw new Error(diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
    }
    const patched = output.outputText.replace(
      /(from\s+["'])(\.{1,2}\/[^"']+?)(["'])/g,
      (match, before, specifier, after) => `${before}${/\.[a-z]+$/i.test(specifier) ? specifier : `${specifier}.mjs`}${after}`,
    );
    await writeFile(outputPath, patched, 'utf8');
  }
  return tempRoot;
}

function moduleUrl(root, relative) {
  return new URL(`file:///${path.join(root, relative).replace(/\\/g, '/')}`).href;
}

class MemoryKv {
  constructor() {
    this.values = new Map();
    this.putOptions = new Map();
    this.putCalls = [];
    this.getCalls = [];
    this.deleteCalls = [];
  }

  async get(key, options) {
    this.getCalls.push(key);
    const value = this.values.get(key) ?? null;
    return value !== null && options?.type === 'json' ? JSON.parse(value) : value;
  }

  async put(key, value, options) {
    this.putCalls.push(key);
    this.values.set(key, value);
    this.putOptions.set(key, options || null);
  }

  async delete(key) {
    this.deleteCalls.push(key);
    this.values.delete(key);
  }

  async list(options = {}) {
    const prefix = String(options.prefix || '');
    const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = options.cursor ? Number.parseInt(String(options.cursor), 10) || 0 : 0;
    const limit = Math.max(1, Number(options.limit) || 1000);
    const selected = keys.slice(start, start + limit);
    const next = start + selected.length;
    return {
      keys: selected.map((name) => ({ name })),
      list_complete: next >= keys.length,
      ...(next < keys.length ? { cursor: String(next) } : {}),
    };
  }
}

function fakeJwt(address = 'victim@example.test') {
  const payload = Buffer.from(JSON.stringify({ address })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.forged-signature`;
}

function handlerContext(request, env, params = {}) {
  return { request, env, params, next: async () => new Response(null, { status: 404 }) };
}

async function scopedMailStateIdentity(workerBase, subject) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`worker:${workerBase.toLowerCase()}`));
  const workerScope = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
  return `tenant:${workerScope}:${subject}`;
}

function mailStateOperation(createdAt, overrides = {}) {
  return JSON.stringify({
    version: 2,
    createdAt,
    readIdsToAdd: [],
    readIdsToRemove: [],
    starredIdsToAdd: [],
    starredIdsToRemove: [],
    readAllBefore: 0,
    ...overrides,
  });
}

const webmailFunctions = path.resolve(new URL('../functions', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));
const adminFunctions = path.resolve(new URL('../../admin/functions', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));
let webmailTemp = '';
let adminTemp = '';
const originalFetch = globalThis.fetch;

try {
  webmailTemp = await compileTree(webmailFunctions, 'webmail-functions-check');
  adminTemp = await compileTree(adminFunctions, 'admin-functions-check');

  const mailState = await import(moduleUrl(webmailTemp, 'api/mail-state.mjs'));
  const shareLib = await import(moduleUrl(webmailTemp, '_lib/share.mjs'));
  const shareUserLib = await import(moduleUrl(webmailTemp, '_lib/shareUser.mjs'));
  const sharePatch = await import(moduleUrl(webmailTemp, 'api/share/admin/[token].mjs'));
  const shareDelete = await import(moduleUrl(webmailTemp, 'api/share/[token]/mail/[id].mjs'));
  const shareMails = await import(moduleUrl(webmailTemp, 'api/share/[token]/mails.mjs'));
  const shareCreate = await import(moduleUrl(webmailTemp, 'api/share/index.mjs'));
  const sessionRoute = await import(moduleUrl(webmailTemp, 'api/session.mjs'));
  const registerRoute = await import(moduleUrl(webmailTemp, 'api/user/register.mjs'));
  const loginRoute = await import(moduleUrl(webmailTemp, 'api/user/login.mjs'));
  const adminProxy = await import(moduleUrl(adminTemp, '_lib/admin-proxy.mjs'));
  const adminMailState = await import(moduleUrl(adminTemp, 'api/mail-state.mjs'));

  // A forged JWT must never be accepted as an identity when the Worker rejects it.
  {
    const kv = new MemoryKv();
    globalThis.fetch = async () => new Response('invalid token', { status: 401 });
    const response = await mailState.onRequestGet(handlerContext(
      new Request('https://mail.example.test/api/mail-state', { headers: { authorization: `Bearer ${fakeJwt()}` } }),
      { MAIL_READ_STATE_KV: kv, MAIL_WORKER_BASE_URL: 'https://worker-a.example.test' },
    ));
    assert.equal(response.status, 401, 'mail-state fails closed when Worker rejects a forged JWT');
    assert.equal(kv.values.size, 0, 'mail-state forged JWT never touches KV');
  }

  {
    const verified = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const headers = new Headers(init.headers || {});
      if (url.pathname === '/user_api/settings') {
        const token = (headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        verified.push(token);
        return token === 'valid-share-admin-token' ? Response.json({ is_admin: true }) : new Response('invalid', { status: 401 });
      }
      if (url.pathname === '/admin/statistics') return Response.json({ ok: true });
      return new Response('unexpected', { status: 500 });
    };
    const auth = await shareLib.assertShareAdmin(
      new Request('https://mail.example.test/api/share/admin/list', { headers: {
        authorization: 'Bearer selected-address-token',
        'x-user-token': 'expired-share-token',
        'x-user-access-token': 'valid-share-admin-token',
      } }),
      { MAIL_WORKER_BASE_URL: 'https://worker.example.test', ADMIN_PASSWORD: 'injected-admin-secret' },
    );
    assert.equal(auth.headers['x-admin-auth'], 'injected-admin-secret');
    assert.deepEqual(verified, ['expired-share-token', 'valid-share-admin-token'], 'share admin auth verifies token candidates independently');
  }

  // A shared KV binding must not mix state belonging to different Worker tenants.
  {
    const kv = new MemoryKv();
    globalThis.fetch = async () => Response.json({ address: 'same@example.test' });
    const token = 'valid-address-token';
    const patch = (worker) => mailState.onRequestPatch(handlerContext(
      new Request('https://mail.example.test/api/mail-state', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ readIds: [42] }),
      }),
      { MAIL_READ_STATE_KV: kv, MAIL_WORKER_BASE_URL: worker },
    ));
    assert.equal((await patch('https://worker-a.example.test')).status, 200);
    const response = await mailState.onRequestGet(handlerContext(
      new Request('https://mail.example.test/api/mail-state', { headers: { authorization: `Bearer ${token}` } }),
      { MAIL_READ_STATE_KV: kv, MAIL_WORKER_BASE_URL: 'https://worker-b.example.test' },
    ));
    const body = await response.json();
    assert.deepEqual(body.readIds, [], 'mail-state keys include the Worker tenant');
  }

  // Immutable operation keys preserve concurrent updates that both start from
  // the same snapshot; the snapshot itself is only a cache.
  {
    const kv = new MemoryKv();
    const env = { MAIL_READ_STATE_KV: kv, MAIL_WORKER_BASE_URL: 'https://worker-concurrent.example.test' };
    globalThis.fetch = async () => Response.json({ address: 'concurrent@example.test' });
    const patch = (id) => mailState.onRequestPatch(handlerContext(
      new Request('https://mail.example.test/api/mail-state', {
        method: 'PATCH',
        headers: { authorization: 'Bearer concurrent-address-token', 'content-type': 'application/json' },
        body: JSON.stringify({ readIdsToAdd: [id] }),
      }),
      env,
    ));
    await Promise.all([patch(101), patch(202)]);
    const response = await mailState.onRequestGet(handlerContext(
      new Request('https://mail.example.test/api/mail-state', { headers: { authorization: 'Bearer concurrent-address-token' } }),
      env,
    ));
    assert.deepEqual((await response.json()).readIds.sort(), ['inbox:101', 'inbox:202'], 'webmail concurrent mail-state adds are both retained');
    assert.equal([...kv.values.keys()].filter((key) => key.startsWith('mail-state-op:v2:')).length, 2, 'webmail writes one immutable key per operation');
  }

  // Compaction records an operation-key watermark. A new, lexicographically
  // larger operation arriving while the snapshot is written must not be part
  // of the observed deletion set and must be applied by the next read.
  {
    const workerBase = 'https://worker-webmail-compaction.example.test';
    const address = 'webmail-compaction@example.test';
    const identity = await scopedMailStateIdentity(workerBase, `email:${address}`);
    const stateKey = `mail-state:v1:${identity}:inbox`;
    const operationPrefix = `mail-state-op:v2:${identity}:inbox:`;
    const oldCreatedAt = Date.now() - 60 * 60 * 1000;
    const firstOldKey = `${operationPrefix}${String(oldCreatedAt).padStart(13, '0')}:old-a`;
    const secondOldKey = `${operationPrefix}${String(oldCreatedAt + 1).padStart(13, '0')}:old-b`;
    const concurrentCreatedAt = Date.now() + 1;
    const concurrentKey = `${operationPrefix}${String(concurrentCreatedAt).padStart(13, '0')}:new-c`;

    class InjectingCompactionKv extends MemoryKv {
      async put(key, value, options) {
        await super.put(key, value, options);
        const snapshot = key === stateKey ? JSON.parse(value) : null;
        if (!this.injected && snapshot?.compactedThrough) {
          this.injected = true;
          this.values.set(concurrentKey, mailStateOperation(concurrentCreatedAt, { readIdsToAdd: [303] }));
        }
      }
    }

    const kv = new InjectingCompactionKv();
    kv.values.set(firstOldKey, mailStateOperation(oldCreatedAt, { readIdsToAdd: [101] }));
    kv.values.set(secondOldKey, mailStateOperation(oldCreatedAt + 1, { readIdsToAdd: [202] }));
    const env = { MAIL_READ_STATE_KV: kv, MAIL_WORKER_BASE_URL: workerBase };
    globalThis.fetch = async () => Response.json({ address });
    const get = () => mailState.onRequestGet(handlerContext(
      new Request('https://mail.example.test/api/mail-state', { headers: { authorization: 'Bearer webmail-compaction-token' } }),
      env,
    ));

    const beforeCompaction = await (await get()).json();
    assert.deepEqual(beforeCompaction.readIds.sort(), ['inbox:101', 'inbox:202'], 'webmail compaction returns the complete pre-compaction result');
    const snapshot = JSON.parse(kv.values.get(stateKey));
    assert.equal(snapshot.compactedThrough, secondOldKey, 'webmail snapshot records the last compacted operation key');
    assert.deepEqual(kv.deleteCalls.sort(), [firstOldKey, secondOldKey].sort(), 'webmail only deletes old operations observed before the snapshot write');
    assert.equal(kv.values.has(concurrentKey), true, 'webmail compaction does not delete a concurrent larger operation');
    const oldReadsAfterCompaction = kv.getCalls.filter((key) => key === firstOldKey || key === secondOldKey).length;

    const afterCompaction = await (await get()).json();
    assert.deepEqual(afterCompaction.readIds.sort(), ['inbox:101', 'inbox:202', 'inbox:303'], 'webmail applies a new operation after the compacted watermark');
    assert.equal(kv.getCalls.filter((key) => key === firstOldKey || key === secondOldKey).length, oldReadsAfterCompaction, 'webmail never reads compacted operations again');
  }

  // A failed best-effort delete leaves the immutable key behind, but the
  // persisted watermark must keep that old remove from being replayed over a
  // later add.
  {
    const workerBase = 'https://worker-webmail-delete-failure.example.test';
    const address = 'delete-failure@example.test';
    const identity = await scopedMailStateIdentity(workerBase, `email:${address}`);
    const stateKey = `mail-state:v1:${identity}:inbox`;
    const operationPrefix = `mail-state-op:v2:${identity}:inbox:`;
    const oldCreatedAt = Date.now() - 60 * 60 * 1000;
    const oldRemoveKey = `${operationPrefix}${String(oldCreatedAt).padStart(13, '0')}:old-remove`;
    const newCreatedAt = Date.now() + 1;
    const newAddKey = `${operationPrefix}${String(newCreatedAt).padStart(13, '0')}:new-add`;

    class FailingDeleteKv extends MemoryKv {
      async delete(key) {
        this.deleteCalls.push(key);
        if (key === oldRemoveKey) throw new Error('simulated KV delete failure');
        this.values.delete(key);
      }
    }

    const kv = new FailingDeleteKv();
    kv.values.set(stateKey, JSON.stringify({
      version: 1,
      readIds: [],
      starredIds: ['inbox:501'],
      readAllBefore: 0,
      updatedAt: oldCreatedAt - 1,
    }));
    kv.values.set(oldRemoveKey, mailStateOperation(oldCreatedAt, { starredIdsToRemove: [501] }));
    const env = { MAIL_READ_STATE_KV: kv, MAIL_WORKER_BASE_URL: workerBase };
    globalThis.fetch = async () => Response.json({ address });
    const get = () => mailState.onRequestGet(handlerContext(
      new Request('https://mail.example.test/api/mail-state', { headers: { authorization: 'Bearer delete-failure-token' } }),
      env,
    ));

    assert.deepEqual((await (await get()).json()).starredIds, [], 'old remove is compacted into the webmail snapshot');
    assert.equal(JSON.parse(kv.values.get(stateKey)).compactedThrough, oldRemoveKey, 'delete failure does not roll back the persisted watermark');
    assert.equal(kv.values.has(oldRemoveKey), true, 'failed operation deletion remains retryable');
    const oldReadsAfterFailure = kv.getCalls.filter((key) => key === oldRemoveKey).length;
    kv.values.set(newAddKey, mailStateOperation(newCreatedAt, { starredIdsToAdd: [501] }));

    assert.deepEqual((await (await get()).json()).starredIds, ['inbox:501'], 'later add wins even when the compacted remove key could not be deleted');
    assert.equal(kv.getCalls.filter((key) => key === oldRemoveKey).length, oldReadsAfterFailure, 'failed deletion is skipped by watermark instead of replayed');
  }

  // Selecting an address puts an address JWT in Bearer; the proxy must still find the valid user-admin token.
  {
    const verifiedTokens = [];
    const proxySignals = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const headers = new Headers(init.headers || {});
      proxySignals.push(init.signal instanceof AbortSignal);
      if (url.pathname === '/user_api/settings') {
        const token = (headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        verifiedTokens.push(token);
        if (token === 'valid-user-admin-token') return Response.json({ is_admin: true });
        return new Response('invalid', { status: 401 });
      }
      if (url.pathname === '/admin/statistics' && headers.get('x-admin-auth') === 'server-admin-secret') {
        return Response.json({ ok: true });
      }
      return new Response('unexpected', { status: 500 });
    };
    const request = new Request('https://admin.example.test/admin/statistics', {
      headers: {
        authorization: 'Bearer selected-address-token',
        'x-user-token': 'expired-user-token',
        'x-user-access-token': 'valid-user-admin-token',
      },
    });
    const response = await adminProxy.proxyToWorker(
      { request, env: { MAIL_WORKER_BASE_URL: 'https://worker.example.test', ADMIN_PASSWORD: 'server-admin-secret' }, params: { path: 'statistics' } },
      'admin',
      { admin: true },
    );
    assert.equal(response.status, 200, 'admin proxy accepts the first independently verified admin token');
    assert.deepEqual(verifiedTokens, ['expired-user-token', 'valid-user-admin-token'], 'admin candidates are verified one by one in user-token order');
    const secondResponse = await adminProxy.proxyToWorker(
      { request, env: { MAIL_WORKER_BASE_URL: 'https://worker.example.test', ADMIN_PASSWORD: 'server-admin-secret' }, params: { path: 'statistics' } },
      'admin',
      { admin: true },
    );
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(verifiedTokens, ['expired-user-token', 'valid-user-admin-token'], 'short role cache avoids duplicate profile fan-out');
    assert(proxySignals.every(Boolean), 'admin proxy applies one request deadline to verification and upstream fetches');
  }

  // Admin mail-state also shares KV across deployments and must scope its cached identity and state key.
  {
    const kv = new MemoryKv();
    globalThis.fetch = async () => Response.json({ user_id: 77, user_email: 'admin@example.test' });
    const token = 'valid-admin-user-token';
    const patchResponse = await adminMailState.onRequestPatch({
      request: new Request('https://admin.example.test/api/mail-state', {
        method: 'PATCH',
        headers: { 'x-user-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'inbox', readIds: [42] }),
      }),
      env: { MAIL_READ_STATE_KV: kv, MAIL_WORKER_BASE_URL: 'https://worker-a.example.test' },
    });
    assert.equal(patchResponse.status, 200);
    const response = await adminMailState.onRequestGet({
      request: new Request('https://admin.example.test/api/mail-state?mode=inbox', { headers: { 'x-user-token': token } }),
      env: { MAIL_READ_STATE_KV: kv, MAIL_WORKER_BASE_URL: 'https://worker-b.example.test' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).readIds, [], 'admin mail-state identity cache and KV key include Worker tenant');
  }

  {
    const kv = new MemoryKv();
    const env = { MAIL_READ_STATE_KV: kv, MAIL_WORKER_BASE_URL: 'https://worker-admin-concurrent.example.test' };
    globalThis.fetch = async () => Response.json({ user_id: 701, user_email: 'admin@example.test' });
    const patch = (id) => adminMailState.onRequestPatch({
      request: new Request('https://admin.example.test/api/mail-state', {
        method: 'PATCH',
        headers: { 'x-user-token': 'admin-concurrent-token', 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'inbox', starredIdsToAdd: [id] }),
      }),
      env,
    });
    await Promise.all([patch(301), patch(302)]);
    const response = await adminMailState.onRequestGet({
      request: new Request('https://admin.example.test/api/mail-state?mode=inbox', { headers: { 'x-user-token': 'admin-concurrent-token' } }),
      env,
    });
    assert.deepEqual((await response.json()).starredIds.sort(), ['inbox:301', 'inbox:302'], 'admin concurrent star operations are both retained');
    assert.equal([...kv.values.keys()].filter((key) => key.startsWith('mail-state-op:v2:')).length, 2, 'admin writes one immutable key per operation');
  }

  {
    const workerBase = 'https://worker-admin-compaction.example.test';
    const identity = await scopedMailStateIdentity(workerBase, 'user:801');
    const stateKey = `mail-state:v1:${identity}:inbox`;
    const operationPrefix = `mail-state-op:v2:${identity}:inbox:`;
    const oldCreatedAt = Date.now() - 60 * 60 * 1000;
    const firstOldKey = `${operationPrefix}${String(oldCreatedAt).padStart(13, '0')}:old-a`;
    const secondOldKey = `${operationPrefix}${String(oldCreatedAt + 1).padStart(13, '0')}:old-b`;
    const newCreatedAt = Date.now() + 1;
    const newKey = `${operationPrefix}${String(newCreatedAt).padStart(13, '0')}:new-c`;
    const kv = new MemoryKv();
    kv.values.set(firstOldKey, mailStateOperation(oldCreatedAt, { starredIdsToAdd: [401] }));
    kv.values.set(secondOldKey, mailStateOperation(oldCreatedAt + 1, { starredIdsToAdd: [402] }));
    const env = { MAIL_READ_STATE_KV: kv, MAIL_WORKER_BASE_URL: workerBase };
    globalThis.fetch = async () => Response.json({ user_id: 801, user_email: 'admin-compaction@example.test' });
    const get = () => adminMailState.onRequestGet({
      request: new Request('https://admin.example.test/api/mail-state?mode=inbox', { headers: { 'x-user-token': 'admin-compaction-token' } }),
      env,
    });

    const beforeCompaction = await (await get()).json();
    assert.deepEqual(beforeCompaction.starredIds.sort(), ['inbox:401', 'inbox:402'], 'admin compaction returns the complete pre-compaction result');
    const snapshot = JSON.parse(kv.values.get(stateKey));
    assert.equal(snapshot.compactedThrough, secondOldKey, 'admin snapshot records the last compacted operation key');
    assert.deepEqual(kv.deleteCalls.sort(), [firstOldKey, secondOldKey].sort(), 'admin deletes only observed operations through the compacted watermark');
    const oldReadsAfterCompaction = kv.getCalls.filter((key) => key === firstOldKey || key === secondOldKey).length;

    kv.values.set(newKey, mailStateOperation(newCreatedAt, { starredIdsToAdd: [403] }));
    const afterCompaction = await (await get()).json();
    assert.deepEqual(afterCompaction.starredIds.sort(), ['inbox:401', 'inbox:402', 'inbox:403'], 'admin applies a new operation after the compacted watermark');
    assert.equal(kv.getCalls.filter((key) => key === firstOldKey || key === secondOldKey).length, oldReadsAfterCompaction, 'admin never reads compacted operations again');
  }

  assert.equal(shareLib.parseShareTtl('forever').expiresAt, null, 'forever share TTL has no expiry');
  {
    let active = 0;
    let peak = 0;
    const values = await shareLib.mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });
    assert.deepEqual(values, [2, 4, 6, 8, 10, 12], 'bounded batch helper preserves result order');
    assert(peak > 1 && peak <= 3, `bounded batch helper peak concurrency: ${peak}`);
  }

  const shareEnv = () => ({
    SHARE_KV: new MemoryKv(),
    SHARE_ENCRYPTION_SECRET: '0123456789abcdef0123456789abcdef',
    MAIL_WORKER_BASE_URL: 'https://worker.example.test',
  });
  const makeShare = (token, overrides = {}) => ({
    version: 2,
    token,
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    revokedAt: null,
    mailVisibility: 'all',
    permissions: { hideMail: true },
    addresses: [{ id: '7', address: 'box@example.test', jwt: 'address-token', mailCount: 5, hiddenMailIds: [] }],
    ...overrides,
  });

  {
    const owned = makeShare('creatorOwned001', {
      creatorUserId: '77',
      addresses: [
        { id: '7', address: 'box@example.test', jwt: 'token-a' },
        { id: '8', address: 'detached@example.test', jwt: 'token-b' },
      ],
    });
    const remaining = new Map([['7', 'box@example.test']]);
    assert.equal(shareUserLib.shareBelongsToUser(owned, remaining, '77'), true, 'creator can revoke a share after one address is detached');
    assert.equal(shareUserLib.shareBelongsToUser(owned, remaining, '88'), false, 'a different user cannot borrow creator ownership');
    const env = shareEnv();
    await shareLib.saveShare(env, owned.token, owned);
    const creatorList = await shareLib.listShareRecordsForAddressIds(env, [], {
      limit: 20,
      creatorUserId: '77',
      request: new Request('https://mail.example.test/api/share/user/list'),
    });
    assert.equal(creatorList.results[0]?.token, owned.token, 'creator index keeps a fully detached share manageable');
  }

  // Expiry is a business state; records remain available for audit/cleanup,
  // and weak encryption keys are rejected before credentials are sealed.
  {
    const weakEnv = { SHARE_KV: new MemoryKv(), SHARE_ENCRYPTION_SECRET: 'short' };
    await assert.rejects(() => shareLib.saveShare(weakEnv, 'weakSecretToken1', makeShare('weakSecretToken1')), /32|密钥/);

    const env = shareEnv();
    const token = 'retainedToken001';
    await shareLib.saveShare(env, token, makeShare(token, { expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }));
    const options = env.SHARE_KV.putOptions.get(`share:${token}`);
    assert(options?.expirationTtl > 80 * 24 * 60 * 60, 'expired share data has a separate audit-retention window');
  }

  {
    const kv = new MemoryKv();
    const legacySecret = 'legacy-key-0123456789-ABCDEFGH-strong';
    const v2Secret = 'v2-key-material-9876543210-ZYXWVUT-strong';
    const legacyEnv = { SHARE_KV: kv, SHARE_ENCRYPTION_SECRET: legacySecret };
    const rotatedEnv = { ...legacyEnv, SHARE_ENCRYPTION_SECRET_V2: v2Secret };
    const legacyToken = 'legacyKeyToken01';
    const v2Token = 'version2KeyToken1';
    await shareLib.saveShare(legacyEnv, legacyToken, makeShare(legacyToken));
    assert.equal((await shareLib.readShareRecord(rotatedEnv, legacyToken))?.token, legacyToken, 'V2 key ring still decrypts no-kid legacy records');
    await shareLib.saveShare(rotatedEnv, v2Token, makeShare(v2Token));
    assert.equal(JSON.parse(await kv.get(`share:${v2Token}`)).kid, 'v2', 'new share envelopes carry kid=v2');
    assert.equal((await shareLib.readShareRecord(rotatedEnv, v2Token))?.token, v2Token, 'V2 key decrypts new records');
    assert.equal(await shareLib.readShareRecord(legacyEnv, v2Token), null, 'legacy-only runtime cannot mis-decrypt V2 records');
  }

  {
    const env = shareEnv();
    const token = 'readNoRewrite001';
    await shareLib.saveShare(env, token, makeShare(token));
    const writesAfterSave = env.SHARE_KV.putCalls.length;
    await shareLib.readShareRecord(env, token);
    assert.equal(env.SHARE_KV.putCalls.length, writesAfterSave, 'ordinary share reads do not rewrite summary/index keys');

    class FailingIndexKv extends MemoryKv {
      async put(key, value, options) {
        if (key.startsWith('share-order:')) throw new Error('simulated index outage');
        return super.put(key, value, options);
      }
    }
    const failingEnv = { ...shareEnv(), SHARE_KV: new FailingIndexKv() };
    const errors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      await shareLib.saveShare(failingEnv, 'indexFailure001', makeShare('indexFailure001'));
    } finally {
      console.error = originalConsoleError;
    }
    assert(errors.some((entry) => entry.includes('share_index_write_failed')), 'index write failure emits a structured observable event');

    class FailingSummaryKv extends MemoryKv {
      async put(key, value, options) {
        if (key.startsWith('share-summary:')) throw new Error('simulated summary outage');
        return super.put(key, value, options);
      }
    }
    const summaryKv = new FailingSummaryKv();
    const summaryEnv = { ...shareEnv(), SHARE_KV: summaryKv };
    const summaryToken = 'summaryFailure01';
    console.error = () => undefined;
    try {
      await shareLib.saveShare(summaryEnv, summaryToken, makeShare(summaryToken));
    } finally {
      console.error = originalConsoleError;
    }
    const listed = await shareLib.listShareRecords(summaryEnv, {
      limit: 20,
      request: new Request('https://mail.example.test/api/share/admin/list'),
    });
    assert(listed.results.some((item) => item.token === summaryToken), 'ordered index remains readable when summary mirror write fails');

    const legacyEnv = shareEnv();
    const legacyToken = 'legacyNoIndex001';
    await shareLib.saveShare(legacyEnv, legacyToken, makeShare(legacyToken));
    await legacyEnv.SHARE_KV.delete(`share-summary:${legacyToken}`);
    for (const key of [...legacyEnv.SHARE_KV.values.keys()]) {
      if (key.startsWith('share-order:') && key.endsWith(`:${legacyToken}`)) await legacyEnv.SHARE_KV.delete(key);
    }
    const legacyListed = await shareLib.listShareRecords(legacyEnv, {
      limit: 20,
      request: new Request('https://mail.example.test/api/share/admin/list'),
    });
    assert(legacyListed.results.some((item) => item.token === legacyToken), 'pre-index encrypted records remain discoverable and migrate on listing');
  }

  // A stale hide/update write cannot erase a completed revocation.
  {
    const env = shareEnv();
    env.ADMIN_PASSWORD = 'admin-secret';
    const token = 'staleRaceToken01';
    await shareLib.saveShare(env, token, makeShare(token));
    const stale = await shareLib.readShareRecord(env, token);
    await shareLib.revokeShare(env, token);
    await shareLib.saveShare(env, token, { ...stale, revokedAt: null, updatedAt: '2026-07-13T00:01:00.000Z' });
    const final = await shareLib.readShareRecord(env, token);
    assert.equal(shareLib.shareStatus(final), 'revoked', 'independent revocation tombstone is irreversible');
    globalThis.fetch = async () => Response.json({ ok: true });
    const restore = await sharePatch.onRequestPatch(handlerContext(
      new Request(`https://mail.example.test/api/share/admin/${token}`, {
        method: 'PATCH',
        headers: { 'x-admin-auth': 'admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ restore: true, expiresIn: '7d' }),
      }),
      env,
      { token },
    ));
    assert.equal(restore.status, 409, 'revocation cannot be silently restored over its tombstone');
  }

  // A syntactically valid/decoded JWT is not a verified mailbox credential.
  {
    const env = shareEnv();
    const forged = fakeJwt('box@example.test');
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/user_api/bind_address') return Response.json({ results: [{ id: 7, name: 'box@example.test' }] });
      if (url.pathname === '/user_api/settings') return Response.json({ user_id: 77 });
      if (url.pathname === '/api/settings') {
        assert.match(new Headers(init.headers).get('authorization') || '', new RegExp(forged.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return new Response('invalid credential', { status: 401 });
      }
      if (url.pathname === '/api/mails') return Response.json({ results: [], count: 0 });
      return new Response('unexpected', { status: 500 });
    };
    const response = await shareCreate.onRequestPost(handlerContext(
      new Request('https://mail.example.test/api/share', {
        method: 'POST',
        headers: { 'x-user-token': 'valid-user-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          addressCredentials: [{ id: '7', address: 'box@example.test', jwt: forged }],
          addresses: [{ id: '7', address: 'box@example.test' }],
          expiresIn: '7d',
        }),
      }),
      env,
    ));
    assert.equal(response.status, 403, 'share creation rejects a decoded but Worker-unverified address JWT');
    assert.equal([...env.SHARE_KV.values.keys()].filter((key) => key.startsWith('share:')).length, 0, 'invalid credential creates no share');
  }

  // Patching permissions alone must preserve the exact expiry.
  {
    const env = shareEnv();
    env.ADMIN_PASSWORD = 'admin-secret';
    const token = 'patchExpiryToken1';
    const originalExpiry = '2030-01-01T00:00:00.000Z';
    await shareLib.saveShare(env, token, makeShare(token, { expiresAt: originalExpiry }));
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/admin/statistics') return Response.json({ ok: true });
      return new Response('unexpected', { status: 500 });
    };
    const response = await sharePatch.onRequestPatch(handlerContext(
      new Request(`https://mail.example.test/api/share/admin/${token}`, {
        method: 'PATCH',
        headers: { 'x-admin-auth': 'admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: { hideMail: false } }),
      }),
      env,
      { token },
    ));
    assert.equal(response.status, 200);
    assert.equal((await shareLib.readShareRecord(env, token)).expiresAt, originalExpiry, 'PATCH without expiry keeps expiry');
    const invalid = await sharePatch.onRequestPatch(handlerContext(
      new Request(`https://mail.example.test/api/share/admin/${token}`, {
        method: 'PATCH',
        headers: { 'x-admin-auth': 'admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: 'banana' }),
      }),
      env,
      { token },
    ));
    assert.equal(invalid.status, 400, 'PATCH rejects an unknown expiry option');
  }

  // Hide is a validated, idempotent share-local operation.
  {
    const env = shareEnv();
    const token = 'hideMailToken001';
    await shareLib.saveShare(env, token, makeShare(token));
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/api/mail/123') return Response.json({ id: 123 });
      if (url.pathname === '/api/mail/999') return new Response('missing', { status: 404 });
      return new Response('unexpected', { status: 500 });
    };
    const hide = (id) => shareDelete.onRequestDelete(handlerContext(
      new Request(`https://mail.example.test/api/share/${token}/mail/${id}?mailbox=7`, { method: 'DELETE' }),
      env,
      { token, id: String(id) },
    ));
    assert.equal((await hide(123)).status, 200);
    assert.equal((await hide(123)).status, 200);
    let stored = await shareLib.readShareRecord(env, token);
    assert.equal(stored.addresses[0].mailCount, 4, 'duplicate hide decrements mailCount once');
    assert.deepEqual(stored.addresses[0].hiddenMailIds, [123]);
    assert.equal((await hide(999)).status, 404, 'mail ID must exist in the shared mailbox');
    stored = await shareLib.readShareRecord(env, token);
    assert.deepEqual(stored.addresses[0].hiddenMailIds, [123], 'invalid mail ID is not persisted');
  }

  // Public share pagination is expressed in visible-mail offsets, even after cutoff/hide filtering.
  {
    const env = shareEnv();
    const token = 'mailPagingToken1';
    await shareLib.saveShare(env, token, makeShare(token, {
      mailVisibility: 'new',
      addresses: [{ id: '7', address: 'box@example.test', jwt: 'address-token', sinceMailId: 118, hiddenMailIds: [151], mailCount: 51 }],
    }));
    const rows = Array.from({ length: 170 }, (_, index) => ({ id: 170 - index, created_at: '2026-07-13T00:00:00.000Z' }));
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname !== '/api/mails') return new Response('unexpected', { status: 500 });
      const limit = Number(url.searchParams.get('limit') || 50);
      const offset = Number(url.searchParams.get('offset') || 0);
      return Response.json({ results: rows.slice(offset, offset + limit), count: rows.length });
    };
    const page = async (offset) => {
      const response = await shareMails.onRequestGet(handlerContext(
        new Request(`https://mail.example.test/api/share/${token}/mails?mailbox=7&limit=50&offset=${offset}`),
        env,
        { token },
      ));
      assert.equal(response.status, 200);
      return response.json();
    };
    const first = await page(0);
    const second = await page(50);
    assert.equal(first.results.length, 50);
    assert.equal(first.count, 51, 'filtered count still signals a second page');
    assert.deepEqual(second.results.map((item) => item.id), [119], 'second visible page is reachable without raw-offset drift');
    assert.equal(second.count, 51);

    const largeToken = 'mailPaging500Tok';
    await shareLib.saveShare(env, largeToken, makeShare(largeToken, {
      mailVisibility: 'new',
      addresses: [{ id: '7', address: 'box@example.test', jwt: 'address-token', sinceMailId: 100, hiddenMailIds: [], mailCount: 500 }],
    }));
    const largeRows = Array.from({ length: 600 }, (_, index) => ({ id: 600 - index, created_at: '2026-07-13T00:00:00.000Z' }));
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const limit = Number(url.searchParams.get('limit') || 50);
      const offset = Number(url.searchParams.get('offset') || 0);
      return Response.json({ results: largeRows.slice(offset, offset + limit), count: largeRows.length });
    };
    const largeResponse = await shareMails.onRequestGet(handlerContext(
      new Request(`https://mail.example.test/api/share/${largeToken}/mails?mailbox=7&limit=50&offset=450`),
      env,
      { token: largeToken },
    ));
    const largePage = await largeResponse.json();
    assert.equal(largeResponse.status, 200);
    assert.equal(largePage.results.length, 50, '500 visible new mails can be paged to the last page');
    assert.equal(largePage.count, 500);
  }

  // List cursors must consume every record, including records sharing one KV list page.
  {
    const env = shareEnv();
    for (let index = 0; index < 50; index += 1) {
      const token = `listToken${String(index).padStart(6, '0')}`;
      await shareLib.saveShare(env, token, makeShare(token, {
        createdAt: new Date(Date.UTC(2026, 6, 13, 0, 0, index)).toISOString(),
      }));
    }
    const seen = [];
    let cursor;
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const page = await shareLib.listShareRecords(env, {
        limit: 20,
        cursor,
        request: new Request('https://mail.example.test/api/share/admin/list'),
      });
      seen.push(...page.results.map((item) => item.token));
      cursor = page.cursor || undefined;
      if (!page.hasMore) break;
    }
    assert.equal(seen.length, 50, 'share list pagination returns all 50 records');
    assert.equal(new Set(seen).size, 50, 'share list pagination has no duplicates');
  }

  // Address-index pagination must advance beyond the former eight-page scan ceiling.
  {
    const env = shareEnv();
    const rows = [];
    for (let index = 0; index < 825; index += 1) {
      const token = `addressIdx${String(index).padStart(6, '0')}`;
      const createdAt = new Date(Date.UTC(2026, 6, 13, 0, 0, index)).toISOString();
      rows.push({ token, createdAt });
      await shareLib.saveShare(env, token, makeShare(token, { createdAt }));
    }
    rows.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.token.localeCompare(right.token));
    const anchor = rows[799];
    const cursor = `addr:${Buffer.from(JSON.stringify(anchor)).toString('base64url')}`;
    const page = await shareLib.listShareRecordsForAddressIds(env, ['7'], {
      limit: 20,
      cursor,
      request: new Request('https://mail.example.test/api/share/user/list'),
    });
    assert.equal(page.results.length, 20, 'address share cursor reaches records after the first 800 index keys');
    assert(page.results.every((item) => Date.parse(item.createdAt) <= Date.parse(anchor.createdAt)), 'address page advances after cursor');
    const allTokens = [];
    let listCursor;
    for (let pageNumber = 0; pageNumber < 12; pageNumber += 1) {
      const listPage = await shareLib.listShareRecords(env, {
        limit: 100,
        cursor: listCursor,
        request: new Request('https://mail.example.test/api/share/admin/list'),
      });
      allTokens.push(...listPage.results.map((item) => item.token));
      listCursor = listPage.cursor || undefined;
      if (!listPage.hasMore) break;
    }
    assert.equal(allTokens.length, 825, 'ordered share list cursor traverses more than 500 records');
    assert.equal(new Set(allTokens).size, 825, 'large share list traversal has no duplicates');
  }

  // Turnstile tokens are forwarded exactly once per protected upstream attempt.
  {
    const bodies = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const body = init.body ? JSON.parse(String(init.body)) : null;
      bodies.push({ path: url.pathname, body });
      if (url.pathname === '/open_api/credential_login') return Response.json({ ok: true });
      if (url.pathname === '/api/settings') return Response.json({ address: 'box@example.test' });
      return new Response('unexpected', { status: 500 });
    };
    const response = await sessionRoute.onRequestPost(handlerContext(
      new Request('https://mail.example.test/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'valid.jwt.token', cf_token: 'challenge-1' }),
      }),
      { MAIL_WORKER_BASE_URL: 'https://worker.example.test' },
    ));
    assert.equal(response.status, 200);
    assert.equal(bodies.find((item) => item.path === '/open_api/credential_login')?.body?.cf_token, 'challenge-1', 'session forwards cf_token');
  }

  {
    const paths = [];
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      paths.push(url.pathname);
      if (url.pathname === '/user_api/register') return Response.json({ success: true });
      if (url.pathname === '/user_api/login') return Response.json({ jwt: 'must-not-be-requested' });
      return new Response('unexpected', { status: 500 });
    };
    const response = await registerRoute.onRequestPost(handlerContext(
      new Request('https://mail.example.test/api/user/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@example.test', password: 'secret', code: '123456', cf_token: 'single-use' }),
      }),
      { MAIL_WORKER_BASE_URL: 'https://worker.example.test' },
    ));
    assert.equal(response.status, 200);
    assert.deepEqual(paths, ['/user_api/register'], 'registration does not reuse a single-use Turnstile token for auto-login');
  }

  {
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      calls.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.pathname === '/user_api/register') return Response.json({ success: true, jwt: 'registered-user-jwt' });
      if (url.pathname === '/user_api/settings') return Response.json({ user_id: 91, user_email: 'new@example.test' });
      if (url.pathname === '/user_api/login') throw new Error('must not auto-login');
      return new Response('unexpected', { status: 500 });
    };
    const response = await registerRoute.onRequestPost(handlerContext(
      new Request('https://mail.example.test/api/user/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@example.test', password: 'secret', code: '123456', cf_token: 'single-use-register' }),
      }),
      { MAIL_WORKER_BASE_URL: 'https://worker.example.test' },
    ));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.userToken, 'registered-user-jwt', 'register uses the Worker-issued session directly');
    assert.equal(calls.find((item) => item.path === '/user_api/register')?.body?.cf_token, 'single-use-register');
    assert(!calls.some((item) => item.path === '/user_api/login'), 'register response JWT avoids a second Turnstile-protected login');
  }

  {
    let loginAttempts = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/user_api/login') {
        loginAttempts += 1;
        return new Response('invalid', { status: 401 });
      }
      return new Response('unexpected', { status: 500 });
    };
    await loginRoute.onRequestPost(handlerContext(
      new Request('https://mail.example.test/api/user/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.test', password: 'wrong', cf_token: 'single-use' }),
      }),
      { MAIL_WORKER_BASE_URL: 'https://worker.example.test' },
    ));
    assert.equal(loginAttempts, 1, 'login never reuses one Turnstile token across compatibility attempts');
  }

  console.log(JSON.stringify({
    ok: true,
    checked: [
      'mail-state fail-closed, tenant isolation, concurrent operations, watermark compaction',
      'admin/share proxy token-candidate verification, deadline, role cache',
      'share forever/expiry validation, irreversible revoke tombstone, hide validation/idempotence',
      'share V2 key ring, audit retention, creator ownership/index, observable index fallback',
      'share 51/500 visible-mail pagination and 50/825 ordered-index traversal',
      'bounded batch concurrency',
      'Turnstile single-use forwarding and register-issued JWT',
    ],
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  if (webmailTemp) await rm(webmailTemp, { recursive: true, force: true });
  if (adminTemp) await rm(adminTemp, { recursive: true, force: true });
}
