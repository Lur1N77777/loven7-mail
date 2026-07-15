import { spawnSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, '..');
process.chdir(appDir);

const projectName = (process.env.ADMIN_PAGES_PROJECT_NAME || '').trim();
const branch = (process.env.CF_PAGES_BRANCH || process.env.GITHUB_REF_NAME || 'main').trim();
const useLocalWranglerConfig = process.env.ADMIN_USE_LOCAL_WRANGLER_CONFIG === '1';

if (!projectName) {
  console.error('ADMIN_PAGES_PROJECT_NAME is required. Set it to the exact Admin Pages project you intend to deploy.');
  process.exit(1);
}
if (!/^[a-z0-9-]+$/i.test(projectName)) {
  console.error('ADMIN_PAGES_PROJECT_NAME may only contain letters, numbers and hyphens.');
  process.exit(1);
}
if (!/^[a-z0-9._/-]+$/i.test(branch)) {
  console.error('CF_PAGES_BRANCH/GITHUB_REF_NAME contains unsupported characters.');
  process.exit(1);
}

console.log(`Deploy target: project=${projectName}, branch=${branch}, environment=${branch === 'main' || branch === 'production' ? 'production' : 'preview'}`);

const wranglerConfigPath = resolve('wrangler.toml');
const ignoredConfigPath = resolve(`wrangler.toml.deploy-ignore-${process.pid}`);
let configTemporarilyMoved = false;

const isWindows = process.platform === 'win32';
const command = isWindows ? 'cmd.exe' : 'npx';
const args = isWindows
  ? ['/d', '/s', '/c', `npx --yes wrangler@4.86.0 pages deploy dist --project-name ${projectName} --branch ${branch}`]
  : ['--yes', 'wrangler@4.86.0', 'pages', 'deploy', 'dist', '--project-name', projectName, '--branch', branch];

try {
  if (!useLocalWranglerConfig && existsSync(wranglerConfigPath)) {
    renameSync(wranglerConfigPath, ignoredConfigPath);
    configTemporarilyMoved = true;
    console.log('Ignoring local wrangler.toml for deploy so Cloudflare Pages Dashboard bindings are preserved.');
    console.log('Set ADMIN_USE_LOCAL_WRANGLER_CONFIG=1 only when you intentionally want wrangler.toml to replace project bindings.');
  }
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
} finally {
  if (configTemporarilyMoved && existsSync(ignoredConfigPath)) {
    renameSync(ignoredConfigPath, wranglerConfigPath);
  }
}
