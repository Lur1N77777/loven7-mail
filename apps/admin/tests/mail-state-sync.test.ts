import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileMailState } from '../src/features/mail/application/reconcileMailState.ts';
import { createAdminMailStateGateway } from '../src/features/mail/infrastructure/mailStateGateway.ts';
import type { ApiRequestOptions, Requester } from '../src/lib/api.ts';

test('mail state reconciliation preserves local changes and requests a canonical backfill', () => {
  const result = reconcileMailState({
    readIds: new Set(['inbox:1']),
    starredIds: new Set(['inbox:3']),
    readAllBefore: { inbox: 9 },
  }, {
    readIds: ['inbox:2'],
    starredIds: ['inbox:4'],
    readAllBefore: { inbox: 5 },
  }, 'inbox');

  assert.deepEqual([...result.state.readIds], ['inbox:1', 'inbox:2']);
  assert.deepEqual([...result.state.starredIds], ['inbox:3', 'inbox:4']);
  assert.deepEqual(result.state.readAllBefore, { inbox: 9, unknown: 9 });
  assert.deepEqual(result.backfill, {
    readIds: ['inbox:1', 'inbox:2'],
    starredIds: ['inbox:3', 'inbox:4'],
    readAllBefore: 9,
  });
});

test('mail state reconciliation skips backfill when remote state is already newer', () => {
  const result = reconcileMailState({
    readIds: new Set(['inbox:1']),
    starredIds: new Set(['inbox:3']),
    readAllBefore: { inbox: 4 },
  }, {
    readIds: ['inbox:1', 'inbox:2'],
    starredIds: ['inbox:3', 'inbox:4'],
    readAllBefore: { unknown: 8 },
  }, 'unknown');

  assert.deepEqual([...result.state.readIds], ['inbox:1', 'inbox:2']);
  assert.deepEqual([...result.state.starredIds], ['inbox:3', 'inbox:4']);
  assert.deepEqual(result.state.readAllBefore, { inbox: 8, unknown: 8 });
  assert.equal(result.backfill, null);
});

test('Admin mail state gateway centralizes non-authoritative GET and PATCH options', async () => {
  const calls: Array<{ path: string; options?: ApiRequestOptions }> = [];
  const request: Requester = async <T>(path: string, options?: ApiRequestOptions): Promise<T> => {
    calls.push({ path, options });
    return {} as T;
  };
  const gateway = createAdminMailStateGateway(request);

  await gateway.load('unknown');
  await gateway.patch('sent', { starredIdsToAdd: ['sent:7'] });

  assert.deepEqual(calls, [
    {
      path: '/api/mail-state?mode=unknown',
      options: {
        forceRefresh: true,
        skipCache: true,
        timeoutMs: 6500,
        reportAuthFailure: false,
      },
    },
    {
      path: '/api/mail-state',
      options: {
        method: 'PATCH',
        body: { mode: 'sent', starredIdsToAdd: ['sent:7'] },
        timeoutMs: 6500,
        reportAuthFailure: false,
        invalidates: ['/api/mail-state'],
      },
    },
  ]);
});
