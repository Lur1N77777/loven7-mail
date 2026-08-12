import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInstallPlan,
  createUpstreamInstallPlan,
  createResourceNames,
  normalizePrefix,
  projectOrigin,
  redactInstallState,
  renderPagesConfig,
  validateManagedWorkerOrigin,
  validateWorkerUrl,
  validateMailDomain,
  validateAdminEmail,
  renderUpstreamWorkerConfig,
} from './domain.mjs';
import { UPSTREAM_LOCK } from './upstream.mjs';

test('normalizes resource prefix and derives stable names', () => {
  assert.equal(normalizePrefix(' My Mail__Suite '), 'my-mail-suite');
  assert.deepEqual(createResourceNames('mail'), {
    prefix: 'mail',
    adminProject: 'mail-admin',
    webmailProject: 'mail-webmail',
    shareKv: 'mail-share',
    mailStateKv: 'mail-mail-state',
  });
});

test('validates a root HTTPS worker URL', () => {
  assert.equal(validateWorkerUrl('https://worker.example.com/'), 'https://worker.example.com');
  assert.throws(() => validateWorkerUrl('http://worker.example.com'), /HTTPS/);
  assert.throws(() => validateWorkerUrl('https://worker.example.com/api'), /根地址/);
  assert.throws(() => validateWorkerUrl('https://user:secret@worker.example.com'), /用户名或密码/);
});

test('only accepts public workers.dev roots as installer-managed origins', () => {
  assert.equal(
    validateManagedWorkerOrigin('https://mail-worker.example.workers.dev/'),
    'https://mail-worker.example.workers.dev',
  );
  assert.throws(() => validateManagedWorkerOrigin('https://worker.example.com'), /workers\.dev/);
  assert.throws(() => validateManagedWorkerOrigin('https://mail-worker.example.workers.dev/api'), /根地址/);
  assert.throws(() => validateManagedWorkerOrigin('http://mail-worker.example.workers.dev'), /HTTPS/);
});

test('uses the actual pages.dev domain returned by Cloudflare', () => {
  assert.equal(projectOrigin({ 'Project Domains': 'mail-a1b.example.pages.dev, mail.example.com' }, 'mail'), 'https://mail-a1b.example.pages.dev');
});

test('renders bindings without embedding secrets', () => {
  const config = renderPagesConfig({
    name: 'mail-webmail',
    app: 'webmail',
    adminOrigin: 'https://mail-admin.example.pages.dev',
    shareKvId: 'share-id',
    mailStateKvId: 'state-id',
  });
  assert.match(config, /SHARE_ADMIN_CORS_ORIGINS/);
  assert.match(config, /binding = "SHARE_KV"/);
  assert.match(config, /binding = "MAIL_READ_STATE_KV"/);
  assert.doesNotMatch(config, /PASSWORD|SECRET|WORKER_BASE/);
});

test('redacts secrets and private worker URL from resumable state', () => {
  const state = redactInstallState({ prefix: 'mail', phase: 'ready', workerUrl: 'https://private.example.com', adminPassword: 'secret' });
  assert.deepEqual(state, { prefix: 'mail', phase: 'ready' });
});

test('creates an existing-worker install plan with explicit backend prerequisites', () => {
  const plan = createInstallPlan();
  assert.equal(plan.mode, 'existing-worker');
  assert.match(plan.manual.join('\n'), /Worker、D1 和 Email Routing/);
});

test('validates real mail domains for a new upstream install', () => {
  assert.equal(validateMailDomain('Mail.Example.net.'), 'mail.example.net');
  assert.throws(() => validateMailDomain('localhost'), /格式无效/);
  assert.throws(() => validateMailDomain('example.com'), /示例域名/);
});

test('validates the bootstrap administrator email', () => {
  assert.equal(validateAdminEmail(' Owner@Example.net '), 'owner@example.net');
  assert.throws(() => validateAdminEmail('owner'), /邮箱格式无效/);
  assert.throws(() => validateAdminEmail('owner@example.com'), /示例域名/);
});

test('creates a locked upstream plan and worker config', () => {
  const plan = createUpstreamInstallPlan({ prefix: 'mail', domain: 'mail.example.net' });
  assert.equal(plan.mode, 'new-worker');
  assert.equal(plan.upstream.release, UPSTREAM_LOCK.release);
  assert.equal(plan.upstream.commit, UPSTREAM_LOCK.commit);
  assert.equal(plan.upstream.repository, UPSTREAM_LOCK.repositoryUrl);
  assert.equal(plan.resources.workerName, 'mail-worker');
  const config = renderUpstreamWorkerConfig({ ...plan.resources, domain: plan.domain, databaseId: 'db-id' });
  assert.match(config, /binding = "DB"/);
  assert.match(config, /workers_dev = true/);
  assert.match(config, /database_id = "db-id"/);
  assert.match(config, /USER_ROLES = \[\{ domains = \["mail\.example\.net"\], role = "admin", prefix = "" \}\]/);
  assert.doesNotMatch(config, /JWT_SECRET|ADMIN_PASSWORDS|PASSWORDS/);
});

test('keeps a validated managed Worker origin but redacts private Worker URLs and secrets', () => {
  const state = redactInstallState({
    prefix: 'mail',
    domain: 'mail.example.net',
    workerProject: 'mail-worker',
    workerDeploymentConfirmed: true,
    databaseName: 'mail-db',
    databaseId: 'database-id',
    upstreamCommit: 'commit-id',
    workerUrl: 'https://mail-worker.example.workers.dev',
    managedWorkerOrigin: 'https://mail-worker.example.workers.dev/',
    jwtSecret: 'private',
  });
  assert.deepEqual(state, {
    prefix: 'mail',
    domain: 'mail.example.net',
    workerProject: 'mail-worker',
    workerDeploymentConfirmed: true,
    databaseName: 'mail-db',
    databaseId: 'database-id',
    upstreamCommit: 'commit-id',
    managedWorkerOrigin: 'https://mail-worker.example.workers.dev',
  });
  assert.deepEqual(redactInstallState({ managedWorkerOrigin: 'https://private.example.com' }), {});
});
