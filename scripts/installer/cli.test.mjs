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

test('runs installer regression tests in the main CI workflow', () => {
  const workflow = readFileSync(resolve(rootDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /run:\s*npm run test:installer/);
});
