import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  CloudflareAdapter,
  CommandRunner,
  UPSTREAM_PNPM_VERSION,
  UPSTREAM_WRANGLER_VERSION,
  WRANGLER_VERSION,
  isEmailRoutingConflictError,
  resolveInvocation,
} from './cloudflare.mjs';
import { UPSTREAM_LOCK } from './upstream.mjs';

const rootDir = resolve('installer-test-root');
const upstreamDir = resolve(rootDir, 'scratch', 'upstream');

class RecordingRunner {
  constructor() {
    this.calls = [];
    this.env = {};
    this.upstreamOutput = '';
    this.runOutput = '';
  }

  upstreamWrangler(args, options = {}) {
    this.calls.push({ method: 'upstreamWrangler', args, options });
    return this.upstreamOutput;
  }

  wrangler(args, options = {}) {
    this.calls.push({ method: 'wrangler', args, options });
    return '';
  }

  run(command, args, options = {}) {
    this.calls.push({ method: 'run', command, args, options });
    return this.runOutput;
  }
}

test('runs Windows package CLIs through Node and keeps native executables direct', () => {
  assert.deepEqual(resolveInvocation('npx', ['--version'], {
    platform: 'win32',
    nodeExecutable: 'node.exe',
    nodeCliPaths: { npx: 'node_modules/npm/bin/npx-cli.js' },
  }), {
    command: 'node.exe',
    args: ['node_modules/npm/bin/npx-cli.js', '--version'],
  });
  assert.deepEqual(resolveInvocation('git', ['--version'], { platform: 'win32' }), {
    command: 'git',
    args: ['--version'],
  });
});

test('uses Worker tool versions from the single upstream lock file', () => {
  assert.equal(UPSTREAM_PNPM_VERSION, UPSTREAM_LOCK.workerPnpm);
  assert.equal(UPSTREAM_WRANGLER_VERSION, UPSTREAM_LOCK.workerWrangler);
  assert.equal(WRANGLER_VERSION, UPSTREAM_LOCK.workerWrangler);
});

test('starts npm, npx and Git through the real command runner', () => {
  const runner = new CommandRunner({ quiet: true });
  assert.match(runner.run('npm', ['--version'], { capture: true }), /^\d+\.\d+\.\d+/);
  assert.match(runner.run('npx', ['--version'], { capture: true }), /^\d+\.\d+\.\d+/);
  assert.match(runner.run('git', ['--version'], { capture: true }), /^git version /);
});

test('uploads Worker secrets as JSON through stdin', () => {
  const runner = new RecordingRunner();
  const adapter = new CloudflareAdapter({ rootDir, runner });
  adapter.putWorkerSecrets(upstreamDir, 'mail-worker', { JWT_SECRET: 'test-value' });
  assert.deepEqual(runner.calls[0].args, ['secret', 'bulk', '--name', 'mail-worker']);
  assert.equal(runner.calls[0].options.cwd, resolve(upstreamDir, 'worker'));
  assert.equal(runner.calls[0].options.input, '{"JWT_SECRET":"test-value"}\n');
  assert.equal(runner.calls[0].options.capture, true);
  assert(!runner.calls[0].args.includes('test-value'));
});

test('checks and enables Email Routing with the pinned Worker Wrangler', () => {
  const runner = new RecordingRunner();
  const adapter = new CloudflareAdapter({ rootDir, runner });
  adapter.checkEmailRoutingDomain('mail.example.net');
  adapter.enableEmailRouting('mail.example.net');
  adapter.getEmailRoutingRules('mail.example.net');
  assert.deepEqual(runner.calls, [
    {
      method: 'upstreamWrangler',
      args: ['email', 'routing', 'settings', 'mail.example.net'],
      options: { capture: true },
    },
    {
      method: 'upstreamWrangler',
      args: ['email', 'routing', 'enable', 'mail.example.net'],
      options: { capture: true },
    },
    {
      method: 'upstreamWrangler',
      args: ['email', 'routing', 'rules', 'list', 'mail.example.net'],
      options: { capture: true },
    },
  ]);
});

test('recognizes only Wrangler destructive Email Routing plans as takeover conflicts', () => {
  assert.equal(isEmailRoutingConflictError({
    message: 'deploy failed',
    stdout: 'Email Routing has destructive changes (deletes or takeover conflicts) that need confirmation.',
  }), true);
  assert.equal(isEmailRoutingConflictError(new Error('network timeout')), false);
});

test('checks Worker existence with an explicit Worker name', () => {
  const runner = new RecordingRunner();
  const adapter = new CloudflareAdapter({ rootDir, runner });
  assert.equal(adapter.workerExists(upstreamDir, 'mail-worker'), true);
  assert.deepEqual(runner.calls[0].args, ['versions', 'list', '--name', 'mail-worker', '--json']);
  assert.equal(runner.calls[0].options.cwd, resolve(upstreamDir, 'worker'));
});

test('checks a resumable Worker without requiring a cloned upstream directory', () => {
  const runner = new RecordingRunner();
  const adapter = new CloudflareAdapter({ rootDir, runner });
  assert.equal(adapter.workerExistsByName('mail-worker'), true);
  assert.deepEqual(runner.calls[0].args, ['versions', 'list', '--name', 'mail-worker', '--json']);
  assert.equal(runner.calls[0].options.cwd, rootDir);
});

test('reads the deployed Worker URL with an explicit Worker name', () => {
  const runner = new RecordingRunner();
  runner.upstreamOutput = JSON.stringify([{ url: 'https://mail-worker.example.workers.dev' }]);
  const adapter = new CloudflareAdapter({ rootDir, runner });
  assert.equal(adapter.getWorkerUrl('mail-worker'), 'https://mail-worker.example.workers.dev');
  assert.deepEqual(runner.calls[0].args, ['deployments', 'list', '--name', 'mail-worker', '--json']);
  assert.equal(runner.calls[0].options.capture, true);
});

test('prefers the just-finished deploy URL over deployment history metadata', () => {
  const runner = new RecordingRunner();
  const adapter = new CloudflareAdapter({ rootDir, runner });
  assert.equal(
    adapter.getWorkerUrl('mail-worker', 'Published https://mail-worker.example.workers.dev'),
    'https://mail-worker.example.workers.dev',
  );
  assert.equal(runner.calls.length, 0);
});

test('deploys the cloned Worker with its temporary wrangler.toml explicitly selected', () => {
  const runner = new RecordingRunner();
  runner.upstreamOutput = 'Published https://mail-worker.example.workers.dev';
  const adapter = new CloudflareAdapter({ rootDir, runner });
  const output = adapter.deployUpstreamWorker(upstreamDir);
  assert.equal(output, runner.upstreamOutput);
  assert.deepEqual(runner.calls[0], {
    method: 'upstreamWrangler',
    args: ['deploy', '--minify', '--config', 'wrangler.toml'],
    options: {
      cwd: resolve(upstreamDir, 'worker'),
      capture: true,
    },
  });
});

test('can rerun Worker deployment interactively after explicit takeover consent', () => {
  const runner = new RecordingRunner();
  const adapter = new CloudflareAdapter({ rootDir, runner });
  adapter.deployUpstreamWorker(upstreamDir, { interactive: true });
  assert.deepEqual(runner.calls[0].options, {
    cwd: resolve(upstreamDir, 'worker'),
    capture: false,
  });
});

test('installs upstream dependencies with the pinned pnpm version through npx', () => {
  const runner = new RecordingRunner();
  const adapter = new CloudflareAdapter({ rootDir, runner });
  adapter.installUpstreamDependencies(upstreamDir);
  assert.deepEqual(runner.calls[0], {
    method: 'run',
    command: 'npx',
    args: ['--yes', `pnpm@${UPSTREAM_PNPM_VERSION}`, 'install', '--frozen-lockfile'],
    options: { cwd: resolve(upstreamDir, 'worker') },
  });
});

test('deploys Pages to the project production branch without forcing main', () => {
  const deployRoot = mkdtempSync(resolve(tmpdir(), 'loven7-cloudflare-test-'));
  const runner = new RecordingRunner();
  mkdirSync(resolve(deployRoot, 'apps', 'admin', 'dist'), { recursive: true });
  mkdirSync(resolve(deployRoot, 'apps', 'admin', 'functions'), { recursive: true });
  writeFileSync(resolve(deployRoot, 'apps', 'admin', 'dist', 'index.html'), '<!doctype html>');
  writeFileSync(resolve(deployRoot, 'apps', 'admin', 'functions', 'index.js'), 'export function onRequest() {}');
  try {
    const adapter = new CloudflareAdapter({ rootDir: deployRoot, runner });
    adapter.deployWithConfig({ app: 'admin', projectName: 'mail-admin', config: 'name = "mail-admin"\n' });
    const deploy = runner.calls.find((call) => call.method === 'wrangler');
    assert.deepEqual(deploy.args, ['pages', 'deploy', 'dist', '--project-name', 'mail-admin']);
    assert(!deploy.args.includes('--branch'));
  } finally {
    rmSync(deployRoot, { recursive: true, force: true });
  }
});
