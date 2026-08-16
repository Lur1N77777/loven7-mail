import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('prints every --domains value and the default domain in a new-worker plan', () => {
  const result = spawnSync(process.execPath, [
    'scripts/installer/cli.mjs',
    '--plan',
    '--new-worker',
    '--domains',
    'primary.example.net,second.example.net',
  ], { cwd: rootDir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /邮箱域名：primary\.example\.net、second\.example\.net/);
  assert.match(result.stdout, /默认域名：primary\.example\.net/);
  assert.match(result.stdout, /Catch-all.*loven7-mail-worker/);
});

test('keeps --domain as a backwards-compatible single-domain option', () => {
  const result = spawnSync(process.execPath, [
    'scripts/installer/cli.mjs', '--plan', '--new-worker', '--domain', 'mail.example.net',
  ], { cwd: rootDir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /邮箱域名：mail\.example\.net/);
});

test('prints a fully English plan when --lang en is selected', () => {
  const result = spawnSync(process.execPath, [
    'scripts/installer/cli.mjs', '--plan', '--new-worker', '--lang=en', '--domains', 'mail.example.net',
  ], { cwd: rootDir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Loven7 Mail installation plan/);
  assert.match(result.stdout, /Mail domains: mail\.example\.net/);
  assert.doesNotMatch(result.stdout, /[\u4e00-\u9fff]/, 'English plan must not leak Chinese labels or prompts');
});

test('authenticates a new installation before asking for its Cloudflare mail domains', () => {
  const source = readFileSync(resolve(rootDir, 'scripts/installer/cli.mjs'), 'utf8');
  const authentication = source.indexOf('installer.ensureAuthentication()');
  const domainPrompt = source.indexOf('Mail domains (comma-separated');
  assert(authentication >= 0, 'new-worker flow must authenticate explicitly');
  assert(domainPrompt > authentication, 'domain prompt must happen after Cloudflare authentication');
});

test('makes the complete new-worker installation the beginner default', () => {
  const source = readFileSync(resolve(rootDir, 'scripts/installer/ui.mjs'), 'utf8');
  assert.match(source, /是否从零部署完整邮箱系统/);
  assert.match(source, /是否从零部署完整邮箱系统[\s\S]*?, true\)/);
});

test('requires an explicit yes before a new installation can change mail MX', () => {
  const source = readFileSync(resolve(rootDir, 'scripts/installer/cli.mjs'), 'utf8');
  assert.match(source, /ui\.confirm\(confirmation, mode !== 'new-worker'\)/);
});

test('runs installer regression tests in the main CI workflow', () => {
  const workflow = readFileSync(resolve(rootDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /run:\s*npm run test:installer/);
});
