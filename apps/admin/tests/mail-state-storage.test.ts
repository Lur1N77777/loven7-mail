import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getMailStateStorageKeys,
  isSameMailStateScope,
  mailStateChangedDetail,
  persistMailState,
  readMailState,
  type MailStateStoragePort,
} from '../src/features/mail/infrastructure/mailStateStorage.ts';

function createStorage(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  const writes: Array<{ key: string; value: unknown }> = [];
  const storage: MailStateStoragePort = {
    read<T>(key: string, fallback: T): T {
      return values.has(key) ? values.get(key) as T : fallback;
    },
    write(key: string, value: unknown): void {
      values.set(key, value);
      writes.push({ key, value });
    },
  };
  return { storage, values, writes };
}

test('mail state storage keys isolate tenant scope with a default fallback', () => {
  assert.deepEqual(getMailStateStorageKeys('tenant-a'), {
    readIds: 'loven7.mailReadIds.tenant-a',
    readAllBefore: 'loven7.mailReadAllBefore.tenant-a',
    starredIds: 'loven7.mailStarredIds.tenant-a',
  });
  assert.deepEqual(getMailStateStorageKeys(''), {
    readIds: 'loven7.mailReadIds.default',
    readAllBefore: 'loven7.mailReadAllBefore.default',
    starredIds: 'loven7.mailStarredIds.default',
  });
});

test('mail state reader rejects malformed ids and watermarks', () => {
  const keys = getMailStateStorageKeys('tenant');
  const { storage } = createStorage({
    [keys.readIds]: ['inbox:1', '', 12, 'sent:2'],
    [keys.starredIds]: 'not-an-array',
    [keys.readAllBefore]: { inbox: 5, sent: '7', negative: -1, invalid: 'nope' },
  });

  const state = readMailState(keys, storage);
  assert.deepEqual([...state.readIds], ['inbox:1', 'sent:2']);
  assert.deepEqual([...state.starredIds], []);
  assert.deepEqual(state.readAllBefore, { inbox: 5, sent: 7 });
});

test('mail state persistence writes only requested fields and bounds id history', () => {
  const keys = getMailStateStorageKeys('tenant');
  const { storage, writes } = createStorage();

  const persisted = persistMailState(keys, {
    readIds: new Set(['inbox:1', 'inbox:2', 'inbox:3']),
    readAllBefore: { inbox: 9 },
  }, storage, 2);

  assert.deepEqual(persisted, {
    readIds: ['inbox:2', 'inbox:3'],
    readAllBefore: { inbox: 9 },
  });
  assert.deepEqual(writes, [
    { key: keys.readIds, value: ['inbox:2', 'inbox:3'] },
    { key: keys.readAllBefore, value: { inbox: 9 } },
  ]);
});

test('mail state events only match the exact storage scope', () => {
  const keys = getMailStateStorageKeys('tenant');
  const detail = mailStateChangedDetail(keys);

  assert.equal(isSameMailStateScope(detail, keys), true);
  assert.equal(isSameMailStateScope({ ...detail, readIdsKey: 'other' }, keys), false);
  assert.equal(isSameMailStateScope(null, keys), false);
});
