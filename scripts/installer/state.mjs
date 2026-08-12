import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { redactInstallState } from './domain.mjs';

export function statePath(rootDir) {
  return resolve(rootDir, '.loven7-installer', 'state.json');
}

export function readState(rootDir) {
  try {
    return JSON.parse(readFileSync(statePath(rootDir), 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(rootDir, next) {
  const path = statePath(rootDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const state = redactInstallState({ ...next, version: 1, updatedAt: new Date().toISOString() });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return state;
}
