import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as Record<string, any>;
}

test('admin build enforces the strict TypeScript contract', () => {
  const packageJson = readJson('../package.json');
  const tsconfig = readJson('../tsconfig.json');

  assert.match(
    String(packageJson.scripts?.build || ''),
    /^tsc -p tsconfig\.json && vite build/,
    'the deployable Admin build must fail before Vite when TypeScript is invalid',
  );
  assert.equal(tsconfig.compilerOptions?.strict, true);
  assert.equal(tsconfig.compilerOptions?.allowJs, false);
  assert.deepEqual(tsconfig.include, ['src', 'functions']);
});

test('admin owns the React type declarations required by its source', () => {
  const packageJson = readJson('../package.json');

  assert.equal(typeof packageJson.devDependencies?.['@types/react'], 'string');
  assert.equal(typeof packageJson.devDependencies?.['@types/react-dom'], 'string');
});

test('the repository module boundary covers shared TypeScript test imports', () => {
  const packageJson = readJson('../../../package.json');
  assert.equal(packageJson.type, 'module');
});
