import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { isChunkLoadError } from '../src/lib/appRecovery.ts';
import { loadBoundedAddressIndex } from '../src/lib/addressIndex.ts';
import { subscribeAuthenticationFailures } from '../src/lib/authFailure.ts';
import { createApiClient } from '../src/lib/api.ts';
import { buildCacheScope, scopedStorageKey } from '../src/lib/cacheScope.ts';
import { buildAddressLoginUrl } from '../src/lib/clipboard.ts';
import { UserApiError, addressMailEndpoint, changeAddressPassword, createUserShare, fetchUserProfile, isAuthenticationFailure, loginAccountUser, registerAccountUser } from '../src/lib/userAuth.ts';
import { readTrustedMailFrameMessage } from '../src/lib/mailFrameMessages.ts';
import { preserveRowsBelowAuthoritativeHead } from '../src/lib/mailSync.ts';
import { createOutboundIdempotencyTracker } from '../src/lib/outboundIdempotency.ts';
import { selectExpiredShareTokens, shareLifecycleStatus } from '../src/lib/shareLifecycle.ts';

test('admin outbound attempts use RFC 4122 UUIDs by default', () => {
  const tracker = createOutboundIdempotencyTracker();
  assert.match(
    tracker.begin('/admin/send_mail', { subject: 'hello' }).key,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test('admin outbound retries reuse a key only for the same draft after network or 5xx errors', () => {
  let nextKey = 0;
  const tracker = createOutboundIdempotencyTracker(() => `admin-key-${++nextKey}`);
  const draft = { from_mail: 'sender@example.com', to_mail: 'to@example.com', subject: 'hello' };

  const first = tracker.begin('/admin/send_mail', draft);
  tracker.failed(first, { status: 0, message: 'network unavailable' });
  assert.equal(tracker.begin('/admin/send_mail', { ...draft }).key, first.key);

  tracker.failed(first, { status: 503, message: 'temporary outage' });
  assert.equal(tracker.begin('/admin/send_mail', { ...draft }).key, first.key);

  const edited = tracker.begin('/admin/send_mail', { ...draft, subject: 'edited' });
  assert.notEqual(edited.key, first.key);
});

test('admin outbound keys rotate after success or a definitive 4xx response', () => {
  let nextKey = 0;
  const tracker = createOutboundIdempotencyTracker(() => `admin-key-${++nextKey}`);
  const draft = { from_mail: 'sender@example.com', to_mail: 'to@example.com', subject: 'hello' };

  const delivered = tracker.begin('/admin/send_mail', draft);
  tracker.succeeded(delivered);
  assert.notEqual(tracker.begin('/admin/send_mail', draft).key, delivered.key);

  const rejected = tracker.begin('/admin/send_mail', { ...draft, subject: 'invalid' });
  tracker.failed(rejected, { status: 400, message: 'invalid input' });
  assert.notEqual(
    tracker.begin('/admin/send_mail', { ...draft, subject: 'invalid' }).key,
    rejected.key,
  );
});

test('admin compose sends the attempt UUID through Idempotency-Key and settles it', () => {
  const source = readFileSync(new URL('../src/views/ComposeView.tsx', import.meta.url), 'utf8');
  assert.equal(
    [...source.matchAll(/['"]Idempotency-Key['"]\s*:\s*attempt\.key/g)].length,
    2,
  );
  assert.equal([...source.matchAll(/outboundRequests\.succeeded\(attempt\)/g)].length, 2);
  assert.equal([...source.matchAll(/outboundRequests\.failed\(attempt,\s*error\)/g)].length, 2);
});

test('admin persistent cache keys are isolated by API and account', () => {
  const first = buildCacheScope('https://api-a.example', 'user:1');
  const otherApi = buildCacheScope('https://api-b.example', 'user:1');
  const otherAccount = buildCacheScope('https://api-a.example', 'user:2');
  assert.notEqual(first, otherApi);
  assert.notEqual(first, otherAccount);
  assert.match(scopedStorageKey('loven7.cache.', first, 'mail', 1), /^loven7\.cache\.v2\./);
});

test('one-click address links keep JWT out of the HTTP query', () => {
  const url = buildAddressLoginUrl('header.payload.signature', 'https://email.example');
  assert.equal(url, 'https://email.example/#JWT=header.payload.signature');
  assert.equal(new URL(url).search, '');
});

test('only explicit 401 and 403 responses invalidate an account session', () => {
  assert.equal(isAuthenticationFailure(new UserApiError(401, 'expired')), true);
  assert.equal(isAuthenticationFailure(new UserApiError(403, 'forbidden')), true);
  assert.equal(isAuthenticationFailure(new UserApiError(500, 'temporary outage')), false);
  assert.equal(isAuthenticationFailure(new TypeError('Failed to fetch')), false);
});

test('account login does not retry plaintext after a backend failure', async () => {
  const originalFetch = globalThis.fetch;
  let loginRequests = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'https://api.example');
    if (url.pathname === '/user_api/login') {
      loginRequests += 1;
      return new Response(JSON.stringify({ message: 'temporary outage' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      loginAccountUser('https://api.example', 'user@example.com', 'password123'),
      (error: any) => error instanceof UserApiError && error.status === 500,
    );
    assert.equal(loginRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('admin API boundaries report runtime 401/403 but preserve sessions for network and 5xx failures', async () => {
  const originalFetch = globalThis.fetch;
  const observedStatuses: number[] = [];
  const unsubscribe = subscribeAuthenticationFailures((error) => {
    observedStatuses.push(Number((error as { status?: unknown }).status));
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const pathname = new URL(String(input), 'https://api.example').pathname;
    if (pathname === '/network-error') throw new TypeError('network unavailable');
    const status = pathname === '/unauthorized'
      ? 401
      : pathname === '/forbidden' || pathname === '/user_api/settings'
        ? 403
        : 503;
    return new Response(JSON.stringify({ message: `status ${status}` }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const client = createApiClient(() => 'https://api.example', () => ({ userAccessToken: 'active-token' }));
    await assert.rejects(client.request('/unauthorized', { skipCache: true }), (error: any) => error?.status === 401);
    await assert.rejects(client.request('/forbidden', { skipCache: true }), (error: any) => error?.status === 403);
    await assert.rejects(client.request('/server-error', { skipCache: true }), (error: any) => error?.status === 503);
    await assert.rejects(client.request('/network-error', { skipCache: true }), /network unavailable/);
    await assert.rejects(fetchUserProfile('https://api.example', 'account-token'), (error: any) => error?.status === 403);
    assert.deepEqual(observedStatuses, [401, 403, 403]);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});

test('account mailbox data source supports inbox and sent without exposing global unknown mail', () => {
  assert.equal(addressMailEndpoint('inbox'), '/api/mails');
  assert.equal(addressMailEndpoint('sent'), '/api/sendbox');
  assert.equal(addressMailEndpoint('unknown'), null);
});

test('chunk load failures are recognized for recoverable update UI', () => {
  assert.equal(isChunkLoadError(new Error('Loading chunk 42 failed')), true);
  assert.equal(isChunkLoadError(new Error('ordinary validation failure')), false);
});

test('mail frame messages require the exact iframe window and bounded payloads', () => {
  const trustedWindow = {};
  assert.deepEqual(readTrustedMailFrameMessage({ source: trustedWindow, data: { type: 'loven7-mail-iframe-swipe', direction: 'left' } }, trustedWindow), { type: 'loven7-mail-iframe-swipe', direction: 'left' });
  assert.equal(readTrustedMailFrameMessage({ source: {}, data: { type: 'loven7-mail-iframe-swipe', direction: 'left' } }, trustedWindow), null);
  assert.equal(readTrustedMailFrameMessage({ source: trustedWindow, data: { type: 'loven7-mail-iframe-swipe-progress', dx: 9999 } }, trustedWindow), null);
});

test('admin head reconciliation drops deleted rows while preserving loaded older pages', () => {
  const existing = [10, 9, 8, 7].map((id) => ({ id }));
  const head = [10, 8].map((id) => ({ id }));
  assert.deepEqual(preserveRowsBelowAuthoritativeHead(existing, head, true).map((row) => row.id), [7]);
  assert.deepEqual(preserveRowsBelowAuthoritativeHead(existing, head, false), []);
});

test('address quick index stops at its explicit row budget and reports truncation', async () => {
  const offsets: number[] = [];
  const result = await loadBoundedAddressIndex({
    pageSize: 500,
    maxRows: 1_000,
    fetchPage: async (offset, limit) => {
      offsets.push(offset);
      return {
        count: 10_000,
        results: Array.from({ length: limit }, (_, index) => ({ id: offset + index + 1 })),
      };
    },
  });
  assert.deepEqual(offsets, [0, 500]);
  assert.equal(result.results.length, 1_000);
  assert.equal(result.reportedCount, 10_000);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
});

test('address quick index observes AbortController before requesting another page', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(loadBoundedAddressIndex({
    pageSize: 2,
    maxRows: 10,
    signal: controller.signal,
    fetchPage: async (offset, limit) => {
      calls += 1;
      controller.abort();
      return { count: 10, results: Array.from({ length: limit }, (_, index) => ({ id: offset + index + 1 })) };
    },
  }), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('multi-mailbox share credential lookup uses bounded concurrency and preserves order', async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  const rows = Array.from({ length: 9 }, (_, index) => ({ id: index + 1, name: `box-${index + 1}@example.com` }));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'https://api.example');
    if (url.pathname.startsWith('/user_api/bind_address_jwt/')) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(JSON.stringify({ jwt: `jwt-${url.pathname.split('/').pop()}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/share') {
      const payload = JSON.parse(String(init?.body || '{}')) as { addressCredentials?: Array<{ id: string }> };
      assert.deepEqual(payload.addressCredentials?.map((item) => item.id), rows.map((row) => String(row.id)));
      return new Response(JSON.stringify({ url: 'https://email.example/s/test', addresses: rows }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;
  try {
    await createUserShare('https://api.example', 'user.jwt', 'https://email.example', rows);
    assert.equal(maxActive, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('irreversibly revoked shares are never selected for expiry extension', () => {
  const now = Date.parse('2026-07-13T12:00:00.000Z');
  const shares = [
    { token: 'active-token', status: 'active', expiresAt: '2026-07-14T12:00:00.000Z', revokedAt: null },
    { token: 'expired-token', status: 'expired', expiresAt: '2026-07-12T12:00:00.000Z', revokedAt: null },
    { token: 'revoked-token', status: 'revoked', expiresAt: '2026-07-12T12:00:00.000Z', revokedAt: '2026-07-11T12:00:00.000Z' },
  ];
  assert.equal(shareLifecycleStatus(shares[2], now), 'revoked');
  assert.deepEqual(selectExpiredShareTokens(shares, now), ['expired-token']);
});

test('registration consumes the Worker-issued JWT without a second login attempt', async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'https://api.example');
    paths.push(url.pathname);
    if (url.pathname === '/user_api/register') return new Response(JSON.stringify({ jwt: 'issued.jwt.token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/user_api/settings') return new Response(JSON.stringify({ user_email: 'user@example.com', user_id: 7, role: 'user' }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;
  try {
    const profile = await registerAccountUser('https://api.example', 'user@example.com', 'password123', '123456');
    assert.equal(profile.userToken, 'issued.jwt.token');
    assert.deepEqual(paths, ['/user_api/register', '/user_api/settings']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('registration keeps the issued session when the immediate profile refresh is temporarily unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'https://api.example');
    paths.push(url.pathname);
    if (url.pathname === '/user_api/register') {
      return new Response(JSON.stringify({ jwt: 'issued.jwt.token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/user_api/settings') {
      return new Response(JSON.stringify({ message: 'temporary outage' }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;
  try {
    const profile = await registerAccountUser('https://api.example', 'New.User@example.com', 'password123', '123456');
    assert.equal(profile.userToken, 'issued.jwt.token');
    assert.equal(profile.userEmail, 'new.user@example.com');
    assert.deepEqual(paths, ['/user_api/register', '/user_api/settings']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('address password rotation returns and adopts the replacement JWT', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'https://api.example');
    assert.equal(url.pathname, '/api/address_change_password');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer old.jwt.token');
    return new Response(JSON.stringify({ success: true, jwt: 'new.jwt.token' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    assert.equal(await changeAddressPassword('https://api.example', 'old.jwt.token', 'new-password-123'), 'new.jwt.token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
