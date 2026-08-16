import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extractWorkerUrl, Installer } from './installer.mjs';
import { writeState } from './state.mjs';

class FakeUi {
  constructor({ confirm = true } = {}) {
    this.messages = [];
    this.confirmations = [];
    this.confirmResult = confirm;
  }
  info(message) { this.messages.push(message); }
  success(message) { this.messages.push(message); }
  step(message) { this.messages.push(message); }
  async confirm(message) {
    this.confirmations.push(message);
    if (typeof this.confirmResult === 'function') return this.confirmResult(message);
    if (message.includes('接管邮件接收')) return true;
    return this.confirmResult;
  }
  async select(_label, items) { return items[0]; }
}

class FakeCloudflare {
  constructor({ existingShareSecret = false, existingSiteSecret = false } = {}) {
    this.accountId = '';
    this.projects = [];
    this.namespaces = [];
    this.secretPuts = [];
    this.secretDeletes = [];
    this.deploys = [];
    this.existingShareSecret = existingShareSecret;
    this.existingSiteSecret = existingSiteSecret;
    this.upstreamSecrets = [];
    this.upstreamConfig = '';
    this.upstreamConfigs = [];
    this.upstreamDeploys = 0;
    this.existingWorkerSecrets = new Set();
    this.hasExistingWorker = false;
    this.databases = [];
    this.d1Creates = [];
    this.schemaExecutions = [];
    this.whoamiCalls = 0;
    this.cloneCalls = 0;
    this.workerUrlCalls = 0;
    this.loginCalls = 0;
    this.emailRoutingChecks = [];
    this.emailRoutingEnables = [];
    this.emailRoutingRuleChecks = [];
    this.events = [];
  }
  whoami() {
    this.whoamiCalls += 1;
    return { loggedIn: true, accounts: [{ id: 'account-test', name: 'Test Account' }] };
  }
  login() { this.loginCalls += 1; }
  useAccount(id) { this.accountId = id; }
  listProjects() { return this.projects; }
  createProject(name) { this.projects.push({ 'Project Name': name, 'Project Domains': `${name}.example.pages.dev` }); }
  listKvNamespaces() { return this.namespaces; }
  createKvNamespace(title) {
    const value = { title, id: `${title}-id` };
    this.namespaces.push(value);
    return value;
  }
  installDependencies() {}
  validateAndBuild() {}
  listPagesSecrets(project) {
    const values = new Set();
    if (project.endsWith('-webmail') && this.existingShareSecret) values.add('SHARE_ENCRYPTION_SECRET_V2');
    if (this.existingSiteSecret) values.add('SITE_PASSWORD');
    return values;
  }
  putPagesSecret(project, key, value) { this.secretPuts.push({ project, key, value }); }
  deletePagesSecret(project, key) { this.secretDeletes.push({ project, key }); }
  deployWithConfig(value) { this.deploys.push(value); }
  cloneUpstream({ destination }) {
    this.cloneCalls += 1;
    return '116ddc732431afd6f4154a74669804473b373baa';
  }
  installUpstreamDependencies() {}
  executeD1Schema(databaseName, schemaPath, cwd) { this.schemaExecutions.push({ databaseName, schemaPath, cwd }); }
  checkEmailRoutingDomain(domain) {
    this.emailRoutingChecks.push(domain);
    this.events.push(`routing-check:${domain}`);
  }
  enableEmailRouting(domain) {
    this.emailRoutingEnables.push(domain);
    this.events.push(`routing-enable:${domain}`);
  }
  getEmailRoutingRules(domain) {
    this.emailRoutingRuleChecks.push(domain);
    return 'Catch-all rule: enabled, action: worker:test-mail-worker';
  }
  writeUpstreamConfig(_cwd, config) {
    this.upstreamConfig = config;
    this.upstreamConfigs.push(config);
  }
  listWorkerSecrets() { return this.existingWorkerSecrets; }
  listWorkerSecretsByName() { return this.existingWorkerSecrets; }
  workerExists() { return this.hasExistingWorker; }
  workerExistsByName() { return this.hasExistingWorker; }
  putWorkerSecrets(_cwd, _workerName, secrets) { this.upstreamSecrets.push(secrets); }
  deployUpstreamWorker(_cwd, options = {}) {
    this.upstreamDeploys += 1;
    this.events.push(options.interactive
      ? 'worker-deploy:routing-interactive'
      : options.routing
        ? 'worker-deploy:routing'
        : 'worker-deploy:core');
    return 'Published https://mail-worker.example.workers.dev';
  }
  getWorkerUrl() {
    this.workerUrlCalls += 1;
    return 'https://mail-worker.example.workers.dev';
  }
  listD1Databases() { return this.databases; }
  createD1Database(name) {
    const value = { name, id: `${name}-id` };
    this.databases.push({ name, uuid: value.id });
    this.d1Creates.push(value);
    return value;
  }
}

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function successfulFetch(url) {
  const value = String(url);
  if (value.endsWith('/admin/worker/configs')) {
    return Promise.resolve(new Response(JSON.stringify({
      DOMAINS: ['mail.example.net'],
      DEFAULT_DOMAINS: ['mail.example.net'],
    }), { status: 200 }));
  }
  if (value.endsWith('/admin/users')) {
    return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
  }
  if (value.includes('/admin/users?')) {
    return Promise.resolve(new Response(JSON.stringify({ results: [{ id: 1, user_email: 'owner@example.net' }], count: 1 }), { status: 200 }));
  }
  if (value.endsWith('/admin/user_roles')) {
    return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
  }
  if (value.includes('/user_api/login')) {
    return Promise.resolve(new Response(JSON.stringify({ jwt: 'a.b.c' }), { status: 200 }));
  }
  if (value.includes('/user_api/settings')) {
    return Promise.resolve(new Response(JSON.stringify({ is_admin: true, access_token: 'admin.jwt.token' }), { status: 200 }));
  }
  if (String(url).endsWith('/health_check')) {
    return Promise.resolve(new Response('OK', { status: 200 }));
  }
  if (String(url).endsWith('/api/runtime')) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, missing: [], checks: { shareKv: true } }), { status: 200 }));
  }
  return Promise.resolve(new Response('<html>Admin</html>', { status: 200 }));
}

test('reauthorizes Cloudflare once when the saved OAuth session lacks Email Routing scope', async () => {
  const cloudflare = new FakeCloudflare();
  let checks = 0;
  cloudflare.checkEmailRoutingDomain = (domain) => {
    checks += 1;
    if (checks === 1) throw new Error(`403 permission denied for ${domain}`);
    cloudflare.emailRoutingChecks.push(domain);
  };
  const installer = new Installer({ rootDir: 'unused', cloudflare, ui: new FakeUi() });
  await installer.verifyEmailRoutingDomains(['mail.example.net']);
  assert.equal(cloudflare.loginCalls, 1);
  assert.equal(checks, 2);
  assert.deepEqual(cloudflare.emailRoutingChecks, ['mail.example.net']);
});

test('runs a fresh existing-worker install without persisting input secrets', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  globalThis.fetch = successfulFetch;
  try {
    const result = await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).run({
      prefix: 'test-mail',
      workerUrl: 'https://worker.example.com',
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
      sitePassword: 'site-private',
    });
    assert.equal(result.state.phase, 'complete');
    assert.equal(cloudflare.deploys.length, 2);
    assert.match(cloudflare.deploys.find((item) => item.app === 'webmail').config, /SHARE_KV/);
    assert(cloudflare.secretPuts.some((item) => item.key === 'SHARE_ENCRYPTION_SECRET_V2'));
    assert(!Object.values(result.state).includes('admin-private'));
    assert(!Object.values(result.state).includes('site-private'));
    assert(!Object.values(result.state).includes('https://worker.example.com'));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('clears managed Worker metadata when switching to an existing Worker', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  globalThis.fetch = successfulFetch;
  writeState(rootDir, {
    accountId: 'account-test',
    prefix: 'test-mail',
    installMode: 'new-worker',
    domain: 'mail.example.net',
    workerProject: 'test-mail-worker',
    workerDeploymentConfirmed: true,
    databaseName: 'test-mail-db',
    databaseId: 'test-mail-db-id',
    upstreamCommit: '116ddc732431afd6f4154a74669804473b373baa',
    managedWorkerOrigin: 'https://mail-worker.example.workers.dev',
    phase: 'complete',
  });
  try {
    const result = await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).run({
      prefix: 'test-mail',
      workerUrl: 'https://worker.example.com',
      adminPassword: 'admin-private',
      sitePassword: '',
    });
    assert.equal(result.state.installMode, 'existing-worker');
    for (const key of ['domain', 'workerProject', 'workerDeploymentConfirmed', 'databaseName', 'databaseId', 'upstreamCommit', 'managedWorkerOrigin']) {
      assert.equal(Object.hasOwn(result.state, key), false);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('keeps an existing share secret during a repair install', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare({ existingShareSecret: true });
  globalThis.fetch = successfulFetch;
  try {
    await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).run({
      prefix: 'repair-mail',
      workerUrl: 'https://worker.example.com',
      adminPassword: 'admin-private',
      sitePassword: '',
    });
    assert(!cloudflare.secretPuts.some((item) => item.key === 'SHARE_ENCRYPTION_SECRET_V2'));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('rejects a blank site password when Pages still contain a site password secret', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare({ existingSiteSecret: true });
  globalThis.fetch = successfulFetch;
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi() }).run({
        prefix: 'repair-mail',
        workerUrl: 'https://worker.example.com',
        adminPassword: 'admin-private',
        sitePassword: '',
      }),
      /Pages 已保存 SITE_PASSWORD/,
    );
    assert.equal(cloudflare.deploys.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('stops before creating Cloudflare resources when an existing Worker admin credential is invalid', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  globalThis.fetch = (url) => String(url).includes('/admin/users?')
    ? Promise.resolve(new Response('Unauthorized', { status: 401 }))
    : successfulFetch(url);
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi() }).run({
        prefix: 'test-mail',
        workerUrl: 'https://worker.example.com',
        adminPassword: 'wrong-admin-password',
        sitePassword: '',
      }),
      /管理员 API 验收失败.*检查 Worker 管理员口令/,
    );
    assert.equal(cloudflare.projects.length, 0);
    assert.equal(cloudflare.namespaces.length, 0);
    assert.equal(cloudflare.deploys.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('verifies the deployed Admin proxy with the configured administrator password', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  const seen = [];
  globalThis.fetch = (url, init = {}) => {
    seen.push({ url: String(url), headers: new Headers(init.headers) });
    return successfulFetch(url);
  };
  try {
    await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).run({
      prefix: 'test-mail',
      workerUrl: 'https://worker.example.com',
      adminPassword: 'admin-private',
      sitePassword: '',
    });
    const proxyProbe = seen.find((item) => item.url.startsWith('https://test-mail-admin.example.pages.dev/admin/users?'));
    assert(proxyProbe);
    assert.equal(proxyProbe.headers.get('x-admin-auth'), 'admin-private');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('requires confirmation before replacing a stale KV checkpoint with a same-name namespace', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.namespaces.push({ title: 'test-mail-share', id: 'different-kv-id' });
  const ui = new FakeUi({ confirm: false });
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui }).ensureKv('test-mail-share', 'deleted-kv-id'),
      /未复用已有 KV/,
    );
    assert(ui.messages.some((message) => message.includes('已不存在')));
    assert.equal(ui.confirmations.length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('retries Admin and Webmail runtime probes while Pages deployments propagate', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  const ui = new FakeUi();
  let adminAttempts = 0;
  let runtimeAttempts = 0;
  globalThis.fetch = (url) => {
    const value = String(url);
    if (value.endsWith('/api/runtime')) {
      runtimeAttempts += 1;
      return runtimeAttempts === 1
        ? Promise.resolve(new Response(JSON.stringify({ ok: false, missing: ['SHARE_KV'] }), { status: 200 }))
        : successfulFetch(url);
    }
    if (value.startsWith('https://retry-mail-admin.example.pages.dev/admin/users?')) {
      adminAttempts += 1;
      return adminAttempts === 1
        ? Promise.resolve(new Response('deployment not ready', { status: 404 }))
        : successfulFetch(url);
    }
    return successfulFetch(url);
  };
  try {
    const result = await new Installer({
      rootDir,
      cloudflare,
      ui,
      probeOptions: { attempts: 3, delayMs: 0, timeoutMs: 500 },
    }).run({
      prefix: 'retry-mail',
      workerUrl: 'https://worker.example.com',
      adminPassword: 'admin-private',
      sitePassword: '',
    });
    assert.equal(result.state.phase, 'complete');
    assert.equal(adminAttempts, 2);
    assert.equal(runtimeAttempts, 2);
    assert(ui.messages.some((message) => message.includes('Admin proxy 尚未就绪')));
    assert(ui.messages.some((message) => message.includes('Webmail runtime 尚未就绪')));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runs a new-worker install with locked upstream and cleans scratch files', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  globalThis.fetch = successfulFetch;
  try {
    const result = await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
      prefix: 'test-mail',
      domain: 'mail.example.net',
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
      sitePassword: 'site-private',
    });
    assert.equal(result.state.phase, 'complete');
    assert.equal(cloudflare.upstreamDeploys, 2);
    assert.equal(cloudflare.whoamiCalls, 1);
    assert.deepEqual(cloudflare.emailRoutingChecks, ['mail.example.net']);
    assert.deepEqual(cloudflare.emailRoutingEnables, ['mail.example.net']);
    assert.deepEqual(cloudflare.emailRoutingRuleChecks, ['mail.example.net']);
    assert.deepEqual(cloudflare.events.slice(0, 4), [
      'routing-check:mail.example.net',
      'worker-deploy:core',
      'routing-enable:mail.example.net',
      'worker-deploy:routing',
    ]);
    assert.doesNotMatch(cloudflare.upstreamConfigs[0], /^addresses\s*=/m);
    assert.match(cloudflare.upstreamConfig, /binding = "DB"/);
    assert.match(cloudflare.upstreamConfig, /^addresses = \["\*@mail\.example\.net"\]$/m);
    assert.deepEqual(result.state.emailRoutingDomains, ['mail.example.net']);
    assert.equal(result.state.emailRoutingWorker, 'test-mail-worker');
    assert.deepEqual(Object.keys(cloudflare.upstreamSecrets[0]).sort(), ['ADMIN_PASSWORDS', 'JWT_SECRET', 'PASSWORDS']);
    assert.equal(readdirSync(rootDir).filter((name) => name.startsWith('.loven7-installer-')).length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('deploys every configured mail domain and persists the ordered list', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  globalThis.fetch = (url) => String(url).endsWith('/admin/worker/configs')
    ? Promise.resolve(new Response(JSON.stringify({
      DOMAINS: ['primary.example.net', 'second.example.net'],
      DEFAULT_DOMAINS: ['primary.example.net', 'second.example.net'],
    }), { status: 200 }))
    : successfulFetch(url);
  try {
    const result = await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
      prefix: 'test-mail',
      domains: ['primary.example.net', 'second.example.net'],
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
      sitePassword: '',
    });
    assert.equal(result.state.domain, 'primary.example.net');
    assert.deepEqual(result.state.domains, ['primary.example.net', 'second.example.net']);
    assert.deepEqual(cloudflare.emailRoutingChecks, ['primary.example.net', 'second.example.net']);
    assert.deepEqual(cloudflare.emailRoutingEnables, ['primary.example.net', 'second.example.net']);
    assert.deepEqual(cloudflare.emailRoutingRuleChecks, ['primary.example.net', 'second.example.net']);
    assert.match(cloudflare.upstreamConfig, /DOMAINS = \["primary\.example\.net", "second\.example\.net"\]/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('does not change MX or create resources until Email Routing takeover is approved', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  const ui = new FakeUi({ confirm: (message) => !message.includes('接管邮件接收') });
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui }).runNewWorker({
        prefix: 'test-mail',
        domain: 'mail.example.net',
        adminPassword: 'admin-private',
        adminEmail: 'owner@example.net',
        adminUserPassword: 'owner-private',
      }),
      /未授权安装器配置 Email Routing/,
    );
    assert.deepEqual(cloudflare.emailRoutingChecks, ['mail.example.net']);
    assert.equal(cloudflare.emailRoutingEnables.length, 0);
    assert.equal(cloudflare.cloneCalls, 0);
    assert.equal(cloudflare.d1Creates.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('requires explicit consent before interactively taking over an existing Catch-all', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  let attempts = 0;
  cloudflare.deployUpstreamWorker = (_cwd, options = {}) => {
    attempts += 1;
    cloudflare.upstreamDeploys += 1;
    cloudflare.events.push(options.interactive
      ? 'worker-deploy:routing-interactive'
      : options.routing
        ? 'worker-deploy:routing'
        : 'worker-deploy:core');
    if (options.routing && !options.interactive) {
      const error = new Error('Worker 已上传，但邮件路由存在冲突。');
      error.stdout = 'The Worker is deployed, but Email Routing has destructive changes (deletes or takeover conflicts) that need confirmation. Published https://mail-worker.example.workers.dev';
      throw error;
    }
    return '';
  };
  globalThis.fetch = successfulFetch;
  const ui = new FakeUi({ confirm: (message) => message.includes('接管邮件接收') || message.includes('已有 Catch-all') });
  try {
    const result = await new Installer({ rootDir, cloudflare, ui }).runNewWorker({
      prefix: 'test-mail',
      domain: 'mail.example.net',
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
    });
    assert.equal(result.state.phase, 'complete');
    assert.equal(attempts, 3);
    assert.deepEqual(cloudflare.events, [
      'routing-check:mail.example.net',
      'worker-deploy:core',
      'routing-enable:mail.example.net',
      'worker-deploy:routing',
      'worker-deploy:routing-interactive',
    ]);
    assert(ui.confirmations.some((message) => message.includes('已有 Catch-all')));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('stops before frontend deployment when the live Catch-all is not bound to the installed Worker', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.getEmailRoutingRules = () => 'Catch-all rule: enabled, action: worker:another-worker';
  globalThis.fetch = successfulFetch;
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
        prefix: 'test-mail',
        domain: 'mail.example.net',
        adminPassword: 'admin-private',
        adminEmail: 'owner@example.net',
        adminUserPassword: 'owner-private',
      }),
      /Catch-all 在线验收失败/,
    );
    assert.equal(cloudflare.deploys.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('stops before frontend deployment when the live Worker domain config differs from the plan', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  globalThis.fetch = (url) => String(url).endsWith('/admin/worker/configs')
    ? Promise.resolve(new Response(JSON.stringify({
      DOMAINS: ['wrong.example.net'],
      DEFAULT_DOMAINS: ['wrong.example.net'],
    }), { status: 200 }))
    : successfulFetch(url);
  try {
    await assert.rejects(
      () => new Installer({
        rootDir,
        cloudflare,
        ui: new FakeUi(),
        probeOptions: { attempts: 2, delayMs: 0, timeoutMs: 500 },
      }).runNewWorker({
        prefix: 'test-mail',
        domains: ['mail.example.net'],
        adminPassword: 'admin-private',
        adminEmail: 'owner@example.net',
        adminUserPassword: 'owner-private',
      }),
      /Worker 线上域名与安装计划不一致/,
    );
    assert.equal(cloudflare.deploys.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('retries the Worker health check after secrets are published', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  let healthAttempts = 0;
  globalThis.fetch = (url) => {
    if (String(url).endsWith('/health_check')) {
      healthAttempts += 1;
      if (healthAttempts < 3) return Promise.resolve(new Response('deployment not ready', { status: 503 }));
    }
    return successfulFetch(url);
  };
  try {
    const result = await new Installer({
      rootDir,
      cloudflare,
      ui: new FakeUi(),
      probeOptions: { attempts: 3, delayMs: 0, timeoutMs: 500 },
    }).runNewWorker({
      prefix: 'test-mail',
      domain: 'mail.example.net',
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
      sitePassword: '',
    });
    assert.equal(result.state.phase, 'complete');
    assert.equal(healthAttempts, 3);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('revalidates a saved D1 id and recreates a database that was deleted remotely', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  globalThis.fetch = successfulFetch;
  writeState(rootDir, {
    accountId: 'account-test',
    prefix: 'test-mail',
    workerProject: 'test-mail-worker',
    databaseName: 'test-mail-db',
    databaseId: 'deleted-database-id',
    phase: 'database-ready',
  });
  try {
    const result = await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
      prefix: 'test-mail',
      domain: 'mail.example.net',
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
      sitePassword: '',
    });
    assert.deepEqual(cloudflare.d1Creates, [{ name: 'test-mail-db', id: 'test-mail-db-id' }]);
    assert.equal(cloudflare.schemaExecutions[0].databaseName, 'test-mail-db');
    assert.equal(result.state.databaseId, 'test-mail-db-id');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('requires confirmation before replacing a stale D1 checkpoint with a same-name database', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.databases.push({ name: 'test-mail-db', uuid: 'different-database-id' });
  writeState(rootDir, {
    accountId: 'account-test',
    prefix: 'test-mail',
    workerProject: 'test-mail-worker',
    databaseName: 'test-mail-db',
    databaseId: 'deleted-database-id',
    phase: 'database-ready',
  });
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi({ confirm: false }) }).runNewWorker({
        prefix: 'test-mail',
        domain: 'mail.example.net',
        adminPassword: 'admin-private',
        adminEmail: 'owner@example.net',
        adminUserPassword: 'owner-private',
      }),
      /未复用已有 D1/,
    );
    assert.equal(cloudflare.upstreamDeploys, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('does not trust a Worker name saved before a Worker deployment completed', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.hasExistingWorker = true;
  globalThis.fetch = successfulFetch;
  writeState(rootDir, {
    accountId: 'account-test',
    prefix: 'test-mail',
    domain: 'mail.example.net',
    workerProject: 'test-mail-worker',
    phase: 'authenticated',
  });
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi({ confirm: false }) }).runNewWorker({
        prefix: 'test-mail',
        domain: 'mail.example.net',
        adminPassword: 'admin-private',
        adminEmail: 'owner@example.net',
        adminUserPassword: 'owner-private',
      }),
      /未复用已有 Worker/,
    );
    assert.equal(cloudflare.upstreamDeploys, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('requires confirmation before changing the domain of a resumable Worker install', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  writeState(rootDir, {
    accountId: 'account-test',
    prefix: 'test-mail',
    domain: 'old.example.net',
    workerProject: 'test-mail-worker',
    workerDeploymentConfirmed: true,
    upstreamCommit: '116ddc732431afd6f4154a74669804473b373baa',
    phase: 'complete',
  });
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi({ confirm: false }) }).runNewWorker({
        prefix: 'test-mail',
        domain: 'new.example.net',
        adminPassword: 'admin-private',
        adminEmail: 'owner@example.net',
        adminUserPassword: 'owner-private',
      }),
      /未确认修改现有 Worker 的邮箱域名/,
    );
    assert.equal(cloudflare.d1Creates.length, 0);
    assert.equal(cloudflare.upstreamDeploys, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('requires confirmation before adding, removing or reordering resumable Worker domains', async () => {
  for (const domains of [
    ['mail.example.net', 'second.example.net', 'third.example.net'],
    ['mail.example.net'],
    ['second.example.net', 'mail.example.net'],
  ]) {
    const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
    const cloudflare = new FakeCloudflare();
    writeState(rootDir, {
      accountId: 'account-test',
      prefix: 'test-mail',
      domain: 'mail.example.net',
      domains: ['mail.example.net', 'second.example.net'],
      workerProject: 'test-mail-worker',
      workerDeploymentConfirmed: true,
      upstreamCommit: '116ddc732431afd6f4154a74669804473b373baa',
      phase: 'complete',
    });
    try {
      await assert.rejects(
        () => new Installer({ rootDir, cloudflare, ui: new FakeUi({ confirm: false }) }).runNewWorker({
          prefix: 'test-mail',
          domains,
          adminPassword: 'admin-private',
          adminEmail: 'owner@example.net',
          adminUserPassword: 'owner-private',
        }),
        /未确认修改现有 Worker 的邮箱域名列表/,
      );
      assert.equal(cloudflare.upstreamDeploys, 0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('reuses a verified Worker after a frontend interruption without overwriting optional bindings', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.hasExistingWorker = true;
  cloudflare.databases.push({ name: 'test-mail-db', uuid: 'test-mail-db-id' });
  cloudflare.existingWorkerSecrets.add('JWT_SECRET');
  cloudflare.existingWorkerSecrets.add('ADMIN_PASSWORDS');
  globalThis.fetch = successfulFetch;
  writeState(rootDir, {
    accountId: 'account-test',
    prefix: 'test-mail',
    domain: 'mail.example.net',
    workerProject: 'test-mail-worker',
    workerDeploymentConfirmed: true,
    databaseName: 'test-mail-db',
    databaseId: 'test-mail-db-id',
    upstreamCommit: '116ddc732431afd6f4154a74669804473b373baa',
    managedWorkerOrigin: 'https://mail-worker.example.workers.dev',
    phase: 'worker-ready',
  });
  try {
    const result = await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
      prefix: 'test-mail',
      domain: 'mail.example.net',
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
      sitePassword: '',
    });
    assert.equal(result.state.phase, 'complete');
    assert.equal(cloudflare.cloneCalls, 0);
    assert.equal(cloudflare.workerUrlCalls, 0);
    assert.equal(cloudflare.upstreamDeploys, 0);
    assert.equal(cloudflare.schemaExecutions.length, 0);
    assert.equal(cloudflare.deploys.length, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reuses a fully routed Worker after the frontend deployment itself is interrupted', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  let interruptFrontend = true;
  cloudflare.deployWithConfig = (value) => {
    if (interruptFrontend) {
      interruptFrontend = false;
      throw new Error('Pages deployment interrupted');
    }
    cloudflare.deploys.push(value);
  };
  globalThis.fetch = successfulFetch;
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
        prefix: 'test-mail',
        domain: 'mail.example.net',
        adminPassword: 'admin-private',
        adminEmail: 'owner@example.net',
        adminUserPassword: 'owner-private',
        sitePassword: '',
      }),
      /Pages deployment interrupted/,
    );
    assert.equal(cloudflare.upstreamDeploys, 2);

    cloudflare.hasExistingWorker = true;
    cloudflare.existingWorkerSecrets.add('JWT_SECRET');
    cloudflare.existingWorkerSecrets.add('ADMIN_PASSWORDS');
    const result = await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
      prefix: 'test-mail',
      domain: 'mail.example.net',
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
      sitePassword: '',
    });
    assert.equal(result.state.phase, 'complete');
    assert.equal(cloudflare.upstreamDeploys, 2);
    assert.equal(cloudflare.cloneCalls, 1);
    assert.equal(cloudflare.deploys.length, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('resumes a worker-core-ready checkpoint from Email Routing without redeploying the core Worker', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.hasExistingWorker = true;
  cloudflare.databases.push({ name: 'test-mail-db', uuid: 'test-mail-db-id' });
  cloudflare.existingWorkerSecrets.add('JWT_SECRET');
  cloudflare.existingWorkerSecrets.add('ADMIN_PASSWORDS');
  globalThis.fetch = successfulFetch;
  writeState(rootDir, {
    accountId: 'account-test',
    prefix: 'test-mail',
    domain: 'mail.example.net',
    domains: ['mail.example.net'],
    workerProject: 'test-mail-worker',
    workerDeploymentConfirmed: true,
    databaseName: 'test-mail-db',
    databaseId: 'test-mail-db-id',
    upstreamCommit: '116ddc732431afd6f4154a74669804473b373baa',
    managedWorkerOrigin: 'https://mail-worker.example.workers.dev',
    phase: 'worker-core-ready',
  });
  try {
    const result = await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
      prefix: 'test-mail',
      domain: 'mail.example.net',
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
      sitePassword: '',
    });
    assert.equal(result.state.phase, 'complete');
    assert.equal(cloudflare.cloneCalls, 1);
    assert.equal(cloudflare.schemaExecutions.length, 0);
    assert.equal(cloudflare.upstreamDeploys, 1);
    assert.deepEqual(cloudflare.events, [
      'routing-check:mail.example.net',
      'routing-enable:mail.example.net',
      'worker-deploy:routing',
    ]);
    assert.deepEqual(result.state.emailRoutingDomains, ['mail.example.net']);
    assert.equal(result.state.emailRoutingWorker, 'test-mail-worker');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('resumes an email-routing-ready checkpoint without enabling Email Routing again', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.hasExistingWorker = true;
  cloudflare.databases.push({ name: 'test-mail-db', uuid: 'test-mail-db-id' });
  cloudflare.existingWorkerSecrets.add('JWT_SECRET');
  cloudflare.existingWorkerSecrets.add('ADMIN_PASSWORDS');
  globalThis.fetch = successfulFetch;
  writeState(rootDir, {
    accountId: 'account-test',
    prefix: 'test-mail',
    domain: 'mail.example.net',
    domains: ['mail.example.net'],
    workerProject: 'test-mail-worker',
    workerDeploymentConfirmed: true,
    databaseName: 'test-mail-db',
    databaseId: 'test-mail-db-id',
    upstreamCommit: '116ddc732431afd6f4154a74669804473b373baa',
    managedWorkerOrigin: 'https://mail-worker.example.workers.dev',
    phase: 'email-routing-ready',
  });
  try {
    const result = await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
      prefix: 'test-mail',
      domain: 'mail.example.net',
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
      sitePassword: '',
    });
    assert.equal(result.state.phase, 'complete');
    assert.equal(cloudflare.emailRoutingEnables.length, 0);
    assert.equal(cloudflare.upstreamDeploys, 1);
    assert.deepEqual(cloudflare.events, [
      'routing-check:mail.example.net',
      'worker-deploy:routing',
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('migrates an old single-domain checkpoint and reuses its verified Worker', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.hasExistingWorker = true;
  cloudflare.databases.push({ name: 'test-mail-db', uuid: 'test-mail-db-id' });
  cloudflare.existingWorkerSecrets.add('JWT_SECRET');
  cloudflare.existingWorkerSecrets.add('ADMIN_PASSWORDS');
  globalThis.fetch = successfulFetch;
  writeState(rootDir, {
    accountId: 'account-test',
    prefix: 'test-mail',
    domain: 'mail.example.net',
    workerProject: 'test-mail-worker',
    workerDeploymentConfirmed: true,
    databaseName: 'test-mail-db',
    databaseId: 'test-mail-db-id',
    upstreamCommit: '116ddc732431afd6f4154a74669804473b373baa',
    managedWorkerOrigin: 'https://mail-worker.example.workers.dev',
    phase: 'worker-ready',
  });
  try {
    const result = await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
      prefix: 'test-mail',
      domains: ['mail.example.net'],
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
      sitePassword: '',
    });
    assert.deepEqual(result.state.domains, ['mail.example.net']);
    assert.equal(cloudflare.upstreamDeploys, 0);
    assert.deepEqual(cloudflare.emailRoutingRuleChecks, ['mail.example.net']);
    assert.deepEqual(result.state.emailRoutingDomains, ['mail.example.net']);
    assert.equal(result.state.emailRoutingWorker, 'test-mail-worker');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('does not overwrite a mismatched live Catch-all while migrating an old checkpoint', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.hasExistingWorker = true;
  cloudflare.databases.push({ name: 'test-mail-db', uuid: 'test-mail-db-id' });
  cloudflare.existingWorkerSecrets.add('JWT_SECRET');
  cloudflare.existingWorkerSecrets.add('ADMIN_PASSWORDS');
  cloudflare.getEmailRoutingRules = () => 'Catch-all rule: enabled, action: worker:another-worker';
  globalThis.fetch = successfulFetch;
  writeState(rootDir, {
    accountId: 'account-test',
    prefix: 'test-mail',
    domain: 'mail.example.net',
    workerProject: 'test-mail-worker',
    workerDeploymentConfirmed: true,
    databaseName: 'test-mail-db',
    databaseId: 'test-mail-db-id',
    upstreamCommit: '116ddc732431afd6f4154a74669804473b373baa',
    managedWorkerOrigin: 'https://mail-worker.example.workers.dev',
    phase: 'worker-ready',
  });
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
        prefix: 'test-mail',
        domain: 'mail.example.net',
        adminPassword: 'admin-private',
        adminEmail: 'owner@example.net',
        adminUserPassword: 'owner-private',
        sitePassword: '',
      }),
      /Catch-all 在线验收失败/,
    );
    assert.equal(cloudflare.cloneCalls, 0);
    assert.equal(cloudflare.emailRoutingEnables.length, 0);
    assert.equal(cloudflare.upstreamDeploys, 0);
    assert.equal(cloudflare.deploys.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('rejects an upstream commit mismatch and still cleans scratch files', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.cloneUpstream = () => 'bad-commit';
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({ prefix: 'test-mail', domain: 'mail.example.net', adminPassword: 'secret' }),
      /版本校验失败/,
    );
    assert.equal(readdirSync(rootDir).filter((name) => name.startsWith('.loven7-installer-')).length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('stops on D1 schema failure and still cleans scratch files', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.executeD1Schema = () => { throw new Error('schema failed'); };
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({ prefix: 'test-mail', domain: 'mail.example.net', adminPassword: 'secret' }),
      /schema failed/,
    );
    assert.equal(cloudflare.upstreamDeploys, 0);
    assert.equal(readdirSync(rootDir).filter((name) => name.startsWith('.loven7-installer-')).length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('stops before frontend deployment when the new Worker health check fails', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  globalThis.fetch = (url) => String(url).endsWith('/health_check')
    ? Promise.resolve(new Response('DB is not available', { status: 200 }))
    : successfulFetch(url);
  try {
    await assert.rejects(
      () => new Installer({
        rootDir,
        cloudflare,
        ui: new FakeUi(),
        probeOptions: { attempts: 2, delayMs: 0, timeoutMs: 500 },
      }).runNewWorker({ prefix: 'test-mail', domain: 'mail.example.net', adminPassword: 'secret' }),
      /健康检查返回异常/,
    );
    assert.equal(cloudflare.deploys.length, 0);
    assert.equal(readdirSync(rootDir).filter((name) => name.startsWith('.loven7-installer-')).length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('preserves an existing Worker JWT secret during a repair install', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.existingWorkerSecrets.add('JWT_SECRET');
  globalThis.fetch = successfulFetch;
  try {
    await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
      prefix: 'test-mail',
      domain: 'mail.example.net',
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
      sitePassword: '',
    });
    assert.deepEqual(Object.keys(cloudflare.upstreamSecrets[0]), ['ADMIN_PASSWORDS']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('requires the current site password when repairing a protected Worker', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  cloudflare.existingWorkerSecrets.add('JWT_SECRET');
  cloudflare.existingWorkerSecrets.add('PASSWORDS');
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
        prefix: 'test-mail',
        domain: 'mail.example.net',
        adminPassword: 'admin-private',
        adminEmail: 'owner@example.net',
        adminUserPassword: 'owner-private',
        sitePassword: '',
      }),
      /输入当前 Worker 站点密码/,
    );
    assert.equal(cloudflare.upstreamDeploys, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('passes the optional site password through Worker bootstrap requests', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  const seenHeaders = [];
  globalThis.fetch = (url, init = {}) => {
    seenHeaders.push({ url: String(url), headers: new Headers(init.headers) });
    return successfulFetch(url);
  };
  try {
    await new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
      prefix: 'test-mail',
      domain: 'mail.example.net',
      adminPassword: 'admin-private',
      adminEmail: 'owner@example.net',
      adminUserPassword: 'owner-private',
      sitePassword: 'site-private',
    });
    const workerRequests = seenHeaders.filter((item) => item.url.includes('mail-worker.example.workers.dev'));
    assert(workerRequests.length >= 6);
    assert(workerRequests.every((item) => item.headers.get('x-custom-auth') === 'site-private'));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('stops if the bootstrap user does not receive administrator access', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  globalThis.fetch = (url) => String(url).includes('/user_api/settings')
    ? Promise.resolve(new Response(JSON.stringify({ is_admin: false }), { status: 200 }))
    : successfulFetch(url);
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
        prefix: 'test-mail',
        domain: 'mail.example.net',
        adminPassword: 'admin-private',
        adminEmail: 'owner@example.net',
        adminUserPassword: 'owner-private',
      }),
      /没有返回管理员权限令牌/,
    );
    assert.equal(cloudflare.deploys.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('does not grant an existing user admin before verifying its password', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'loven7-installer-test-'));
  const cloudflare = new FakeCloudflare();
  let roleUpdates = 0;
  globalThis.fetch = (url) => {
    const value = String(url);
    if (value.endsWith('/admin/users')) return Promise.resolve(new Response('User already exists', { status: 400 }));
    if (value.includes('/user_api/login')) return Promise.resolve(new Response('Invalid email or password', { status: 400 }));
    if (value.endsWith('/admin/user_roles')) roleUpdates += 1;
    return successfulFetch(url);
  };
  try {
    await assert.rejects(
      () => new Installer({ rootDir, cloudflare, ui: new FakeUi() }).runNewWorker({
        prefix: 'test-mail',
        domain: 'mail.example.net',
        adminPassword: 'admin-private',
        adminEmail: 'owner@example.net',
        adminUserPassword: 'wrong-password',
      }),
      /没有修改角色或覆盖原密码/,
    );
    assert.equal(roleUpdates, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('rejects missing worker URLs instead of guessing a deployment target', () => {
  assert.equal(extractWorkerUrl('Uploaded https://mail-worker.example.workers.dev/', 'mail-worker'), 'https://mail-worker.example.workers.dev');
  assert.throws(() => extractWorkerUrl('Uploaded successfully', 'mail-worker'), /无法从 Wrangler 输出/);
});
