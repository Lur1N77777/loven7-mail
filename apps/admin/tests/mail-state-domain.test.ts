import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addMailStateIds,
  applyMailState,
  deleteMailStateId,
  hasMailStateId,
  normalizeRemoteIds,
  normalizeRemoteMailState,
  readAllBeforeValue,
  storageId,
  withReadAllBeforeValue,
} from '../src/features/mail/domain/mailState.ts';

test('legacy unknown mail state shares the canonical inbox identity', () => {
  const ids = new Set<string>();

  addMailStateIds(ids, 'unknown', 42);
  assert.deepEqual([...ids].sort(), ['inbox:42', 'unknown:42']);
  assert.equal(hasMailStateId(ids, 'inbox', 42), true);
  assert.equal(hasMailStateId(ids, 'unknown', 42), true);
  assert.equal(storageId('unknown', 42), 'inbox:42');

  deleteMailStateId(ids, 'inbox', 42);
  assert.deepEqual([...ids], []);
});

test('read-all watermark preserves the legacy unknown inbox value', () => {
  assert.equal(readAllBeforeValue({ inbox: 12, unknown: 18 }, 'inbox'), 18);

  const next = withReadAllBeforeValue({ sent: 4 }, 'unknown', 27);
  assert.deepEqual(next, { sent: 4, inbox: 27, unknown: 27 });
});

test('remote mail state rejects invalid ids and applies local flags', () => {
  const remote = normalizeRemoteMailState({
    readIds: ['1', 'unknown:2', 'invalid', '0'],
    starredIds: ['sent:3'],
    readAllBefore: { unknown: 1 },
  }, 'unknown');

  assert.deepEqual([...normalizeRemoteIds(['1', 'unknown:2', 'invalid'], 'unknown')].sort(), ['inbox:1', 'inbox:2']);
  assert.deepEqual([...remote.readIds].sort(), ['inbox:1', 'inbox:2']);
  assert.deepEqual([...remote.starredIds], ['inbox:3']);
  assert.equal(remote.readAllBefore, 1);

  const items = applyMailState(
    [
      { id: 1, isUnread: true, isStarred: false },
      { id: 3, isUnread: true, isStarred: false },
    ],
    'unknown',
    remote.readIds,
    remote.starredIds,
    { inbox: remote.readAllBefore },
  );
  assert.deepEqual(items, [
    { id: 1, isUnread: false, isStarred: false },
    { id: 3, isUnread: true, isStarred: true },
  ]);
});
