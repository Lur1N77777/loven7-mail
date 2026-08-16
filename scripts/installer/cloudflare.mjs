import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { UPSTREAM_LOCK } from './upstream.mjs';

export const UPSTREAM_PNPM_VERSION = UPSTREAM_LOCK.workerPnpm;
export const UPSTREAM_WRANGLER_VERSION = UPSTREAM_LOCK.workerWrangler;
// Email Routing `addresses` and its OAuth scope are only available in the
// pinned modern Wrangler. Keep every installer command on the same version.
export const WRANGLER_VERSION = UPSTREAM_WRANGLER_VERSION;

const WINDOWS_NODE_CLIS = {
  npm: ['node_modules', 'npm', 'bin', 'npm-cli.js'],
  npx: ['node_modules', 'npm', 'bin', 'npx-cli.js'],
};

function findWindowsNodeCli(command, env, nodeExecutable) {
  const relativePath = WINDOWS_NODE_CLIS[command];
  if (!relativePath) return '';
  const candidates = [];
  const npmExecPath = env.npm_execpath;
  if (npmExecPath && command === 'npm') candidates.push(npmExecPath);
  if (npmExecPath && command === 'npx') candidates.push(resolve(dirname(npmExecPath), 'npx-cli.js'));
  const pathValue = env.Path || env.PATH || '';
  const roots = [dirname(nodeExecutable), ...pathValue.split(delimiter).filter(Boolean)];
  roots.forEach((root) => candidates.push(resolve(root, ...relativePath)));
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

export function resolveInvocation(command, args, {
  platform = process.platform,
  env = process.env,
  nodeExecutable = process.execPath,
  nodeCliPaths = {},
} = {}) {
  const normalized = String(command).toLowerCase();
  if (platform !== 'win32' || !WINDOWS_NODE_CLIS[normalized]) return { command, args };
  const cliPath = nodeCliPaths[normalized] || findWindowsNodeCli(normalized, env, nodeExecutable);
  if (!cliPath) {
    throw new Error(`Windows 环境无法找到 ${command} 的 Node.js CLI。请重新安装 Node.js 22+。`);
  }
  return { command: nodeExecutable, args: [cliPath, ...args] };
}

export class CommandError extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'CommandError';
    this.status = result?.status ?? 1;
    this.stdout = String(result?.stdout || '');
    this.stderr = String(result?.stderr || '');
    this.output = [this.stdout, this.stderr].filter(Boolean).join('\n');
  }
}

export function isEmailRoutingConflictError(error) {
  const output = [error?.message, error?.stdout, error?.stderr, error?.output]
    .filter(Boolean)
    .join('\n');
  return /Email Routing has destructive changes|takeover conflict|邮件路由.*冲突|Catch-all.*冲突/i.test(output);
}

export class CommandRunner {
  constructor({ cwd, env = process.env, quiet = false } = {}) {
    this.cwd = cwd || process.cwd();
    this.env = { ...env };
    this.quiet = quiet;
  }

  run(command, args, { cwd = this.cwd, input, capture = false, env = {} } = {}) {
    if (!this.quiet && !capture) console.log(`\n> ${command} ${args.join(' ')}`);
    const invocation = resolveInvocation(command, args, { env: { ...this.env, ...env } });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd,
      env: { ...this.env, ...env },
      input,
      encoding: 'utf8',
      stdio: capture || input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
      throw new CommandError(detail || `${command} 执行失败。`, result);
    }
    return String(result.stdout || '').trim();
  }

  wrangler(args, options = {}) {
    return this.run('npx', ['--yes', `wrangler@${WRANGLER_VERSION}`, ...args], options);
  }

  upstreamWrangler(args, options = {}) {
    return this.run('npx', ['--yes', `wrangler@${UPSTREAM_WRANGLER_VERSION}`, ...args], options);
  }
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} 返回了无法识别的数据。请升级安装器后重试。`);
  }
}

export class CloudflareAdapter {
  constructor({ rootDir, runner }) {
    this.rootDir = rootDir;
    this.runner = runner;
  }

  whoami() {
    return parseJson(this.runner.wrangler(['whoami', '--json'], { capture: true }), 'Wrangler whoami');
  }

  login() {
    this.runner.wrangler(['login']);
  }

  useAccount(accountId) {
    this.runner.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  }

  listProjects() {
    return parseJson(this.runner.wrangler(['pages', 'project', 'list', '--json'], { capture: true }), 'Pages project list');
  }

  createProject(name) {
    this.runner.wrangler(['pages', 'project', 'create', name, '--production-branch', 'main', '--compatibility-date', '2026-05-11']);
  }

  listKvNamespaces() {
    return parseJson(this.runner.wrangler(['kv', 'namespace', 'list'], { capture: true }), 'KV namespace list');
  }

  createKvNamespace(title) {
    this.runner.wrangler(['kv', 'namespace', 'create', title]);
    const namespace = this.listKvNamespaces().find((item) => item.title === title);
    if (!namespace?.id) throw new Error(`KV ${title} 已创建，但无法读取 Namespace ID。`);
    return namespace;
  }

  listD1Databases() {
    return parseJson(this.runner.upstreamWrangler(['d1', 'list', '--json'], { capture: true }), 'D1 database list');
  }

  checkEmailRoutingDomain(domain) {
    return this.runner.upstreamWrangler(['email', 'routing', 'settings', domain], { capture: true });
  }

  enableEmailRouting(domain) {
    return this.runner.upstreamWrangler(['email', 'routing', 'enable', domain], { capture: true });
  }

  getEmailRoutingRules(domain) {
    return this.runner.upstreamWrangler(['email', 'routing', 'rules', 'list', domain], { capture: true });
  }

  workerExists(cwd, workerName) {
    return this.workerExistsAt(resolve(cwd, 'worker'), workerName);
  }

  workerExistsByName(workerName) {
    return this.workerExistsAt(this.rootDir, workerName);
  }

  workerExistsAt(cwd, workerName) {
    try {
      this.runner.upstreamWrangler(['versions', 'list', '--name', workerName, '--json'], {
        cwd,
        capture: true,
      });
      return true;
    } catch (error) {
      if (/does not exist|10007/i.test(String(error?.message || error))) return false;
      throw error;
    }
  }

  createD1Database(name) {
    this.runner.upstreamWrangler(['d1', 'create', name]);
    const database = this.listD1Databases().find((item) => item.name === name);
    if (!database?.uuid) throw new Error(`D1 ${name} 已创建，但无法读取 database_id。`);
    return { name, id: database.uuid };
  }

  executeD1Schema(databaseName, schemaPath, cwd) {
    this.runner.upstreamWrangler(['d1', 'execute', databaseName, '--file', schemaPath, '--remote', '--yes'], { cwd });
  }

  cloneUpstream({ repository, release, destination }) {
    this.runner.run('git', ['clone', '--quiet', '--depth', '1', '--branch', release, repository, destination], { cwd: this.rootDir });
    const commit = this.runner.run('git', ['rev-parse', 'HEAD'], { cwd: destination, capture: true });
    return commit.trim();
  }

  installUpstreamDependencies(cwd) {
    this.runner.run('npx', ['--yes', `pnpm@${UPSTREAM_PNPM_VERSION}`, 'install', '--frozen-lockfile'], { cwd: resolve(cwd, 'worker') });
  }

  writeUpstreamConfig(cwd, config) {
    writeFileSync(resolve(cwd, 'worker', 'wrangler.toml'), config, { encoding: 'utf8', mode: 0o600 });
  }

  listWorkerSecrets(cwd, workerName) {
    return this.listWorkerSecretsAt(resolve(cwd, 'worker'), workerName);
  }

  listWorkerSecretsByName(workerName) {
    return this.listWorkerSecretsAt(this.rootDir, workerName);
  }

  listWorkerSecretsAt(cwd, workerName) {
    try {
      const output = this.runner.upstreamWrangler(['secret', 'list', '--name', workerName, '--format', 'json'], {
        cwd,
        capture: true,
      });
      const values = parseJson(output, 'Worker secret list');
      return new Set(values.map((item) => item.name).filter(Boolean));
    } catch (error) {
      if (/does not exist|10007/i.test(String(error?.message || error))) return new Set();
      throw error;
    }
  }

  putWorkerSecrets(cwd, workerName, values) {
    this.runner.upstreamWrangler(['secret', 'bulk', '--name', workerName], {
      cwd: resolve(cwd, 'worker'),
      input: `${JSON.stringify(values)}\n`,
      capture: true,
    });
  }

  getWorkerUrl(workerName, deployOutput = '') {
    const deployedUrl = findWorkerUrl(deployOutput);
    if (deployedUrl) return deployedUrl;
    try {
      const output = this.runner.upstreamWrangler(['deployments', 'list', '--name', workerName, '--json'], { capture: true });
      const url = findWorkerUrl(output);
      if (url) return url;
    } catch {
      // Older Wrangler releases do not expose deployment metadata as JSON.
    }
    throw new Error(`Worker ${workerName} 已部署，但无法从 Wrangler 输出或部署元数据中确定公开地址。请在 Cloudflare Dashboard 查看地址后重新运行已有 Worker 模式。`);
  }

  deployUpstreamWorker(cwd, { interactive = false } = {}) {
    return this.runner.upstreamWrangler(['deploy', '--minify', '--config', 'wrangler.toml'], {
      cwd: resolve(cwd, 'worker'),
      capture: !interactive,
    });
  }

  putPagesSecret(projectName, key, value) {
    this.runner.wrangler(['pages', 'secret', 'put', key, '--project-name', projectName], {
      input: `${value}\n`,
      capture: true,
    });
  }

  listPagesSecrets(projectName) {
    const output = this.runner.wrangler(['pages', 'secret', 'list', '--project-name', projectName], { capture: true });
    return new Set([...output.matchAll(/^\s*-\s+([A-Z0-9_]+):\s+Value Encrypted\s*$/gim)].map((match) => match[1]));
  }

  deletePagesSecret(projectName, key) {
    this.runner.wrangler(['pages', 'secret', 'delete', key, '--project-name', projectName], { input: 'y\n', capture: true });
  }

  installDependencies() {
    this.runner.run('npm', ['--prefix', 'apps/admin', 'ci']);
    this.runner.run('npm', ['--prefix', 'apps/webmail', 'ci']);
  }

  validateAndBuild() {
    this.runner.run('npm', ['run', 'check:public']);
    this.runner.run('npm', ['run', 'check:cloudflare']);
    this.runner.run('npm', ['run', 'build']);
  }

  deployWithConfig({ app, projectName, config }) {
    const appDir = resolve(this.rootDir, 'apps', app);
    const deployDir = mkdtempSync(join(tmpdir(), `loven7-${app}-`));
    try {
      cpSync(resolve(appDir, 'dist'), resolve(deployDir, 'dist'), { recursive: true });
      cpSync(resolve(appDir, 'functions'), resolve(deployDir, 'functions'), { recursive: true });
      writeFileSync(resolve(deployDir, 'wrangler.toml'), config, { encoding: 'utf8', mode: 0o600 });
      this.runner.wrangler(['pages', 'deploy', 'dist', '--project-name', projectName], { cwd: deployDir });
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  }
}

export function findWorkerUrl(value) {
  const match = String(value || '').match(/https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.workers\.dev(?:\/[^\s"'<>]*)?/i);
  return match?.[0]?.replace(/[),.;]+$/, '').replace(/\/$/, '') || '';
}
