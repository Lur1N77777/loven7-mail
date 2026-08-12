import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAIL_LIST_CACHE_VERSION,
  mailDetailCacheKey,
  mailListCacheKey,
  parseMailListCache,
  readMailDetailCache,
  readMailListCache,
  writeMailDetailCache,
  writeMailListCache,
  type JsonStoragePort,
  type StringStoragePort,
} from '../src/features/mail/infrastructure/mailCache.ts';

test('mail cache keys isolate tenants and normalize mailbox filters', () => {
  const first = mailListCacheKey('tenant a', 'inbox', 1, 20, ' alice@example.test ');
  const same = mailListCacheKey('tenant a', 'inbox', 1, 20, 'alice@example.test');

  assert.equal(first, same);
  assert.notEqual(first, mailListCacheKey('tenant b', 'inbox', 1, 20, 'alice@example.test'));
  assert.notEqual(first, mailListCacheKey('tenant a', 'sent', 1, 20, 'alice@example.test'));
  assert.match(mailDetailCacheKey('tenant a', 'inbox', 9), /\.v6\./);
});

test('list cache adapter serializes through its storage port', () => {
  let storedKey = '';
  let storedValue: unknown;
  const storage: JsonStoragePort = {
    read<T>(_key: string, fallback: T): T {
      return storedValue === undefined ? fallback : storedValue as T;
    },
    write(key: string, value: unknown): void {
      storedKey = key;
      storedValue = value;
    },
  };

  const written = writeMailListCache(
    'cache-key',
    [{ id: 1, raw: 'large payload' }],
    7,
    (mail) => ({ id: mail.id }),
    storage,
    1234,
  );

  assert.equal(storedKey, 'cache-key');
  assert.deepEqual(written, {
    version: MAIL_LIST_CACHE_VERSION,
    count: 7,
    savedAt: 1234,
    items: [{ id: 1 }],
  });
  assert.deepEqual(storedValue, written);
  assert.deepEqual(readMailListCache<{ id: number }>('cache-key', storage), written);
});

test('list cache rejects stale payloads and repairs invalid metadata', () => {
  assert.equal(parseMailListCache({
    version: MAIL_LIST_CACHE_VERSION - 1,
    count: 1,
    savedAt: 1,
    items: [{ id: 1 }],
  }), null);
  assert.equal(parseMailListCache({
    version: MAIL_LIST_CACHE_VERSION,
    count: 1,
    savedAt: 1,
    items: 'not-an-array',
  }), null);
  assert.deepEqual(parseMailListCache<{ id: number }>({
    version: MAIL_LIST_CACHE_VERSION,
    count: 'invalid',
    savedAt: -5,
    items: [{ id: 2 }],
  }), {
    version: MAIL_LIST_CACHE_VERSION,
    count: 1,
    savedAt: 0,
    items: [{ id: 2 }],
  });
});

test('session detail cache validates identity and fails closed on storage errors', () => {
  const values = new Map<string, string>();
  const storage: StringStoragePort = {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
  };

  assert.equal(writeMailDetailCache(
    'tenant',
    'inbox',
    { id: 7, raw: 'large payload' },
    (mail) => ({ id: mail.id, raw: '' }),
    storage,
  ), true);
  assert.deepEqual(readMailDetailCache<{ id: number; raw: string }>('tenant', 'inbox', 7, storage), { id: 7, raw: '' });

  values.set(mailDetailCacheKey('tenant', 'inbox', 7), JSON.stringify({ id: 8, raw: '' }));
  assert.equal(readMailDetailCache('tenant', 'inbox', 7, storage), null);

  const throwingStorage: StringStoragePort = {
    getItem(): string | null {
      throw new Error('blocked');
    },
    setItem(): void {
      throw new Error('quota');
    },
  };
  assert.equal(readMailDetailCache('tenant', 'inbox', 7, throwingStorage), null);
  assert.equal(writeMailDetailCache('tenant', 'inbox', { id: 7 }, (mail) => mail, throwingStorage), false);
});
