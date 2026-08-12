import assert from 'node:assert/strict';
import test from 'node:test';

import { createMailListGateway } from '../src/features/mail/infrastructure/mailListGateway.ts';
import type { ApiRequestOptions, Requester } from '../src/lib/api.ts';

test('mail list gateway selects the correct endpoint and address policy', async () => {
  const calls: Array<{ path: string; options?: ApiRequestOptions }> = [];
  const request: Requester = async <T>(path: string, options?: ApiRequestOptions): Promise<T> => {
    calls.push({ path, options });
    return { results: [{ id: 1, raw: 'From: sender@example.test\r\nSubject: Inbox\r\n\r\nBody', address: 'box@example.test' }], count: 1 } as T;
  };
  const gateway = createMailListGateway(request);

  const inbox = await gateway.load({ mode: 'inbox', offset: 20, limit: 20, address: ' box@example.test ', forceRefresh: true });
  const unknown = await gateway.load({ mode: 'unknown', offset: 0, limit: 240, address: 'ignored@example.test' });

  assert.equal(inbox.results[0].id, 1);
  assert.equal(unknown.results[0].id, 1);
  assert.equal(calls[0].path, '/admin/mails?limit=20&offset=20&address=box%40example.test');
  assert.equal(calls[1].path, '/admin/mails_unknow?limit=240&offset=0');
  assert.deepEqual(calls[0].options, { forceRefresh: true, signal: undefined, cacheTtlMs: 30_000 });
  assert.deepEqual(calls[1].options, { forceRefresh: false, signal: undefined, cacheTtlMs: 30_000 });
});

test('sent mail list gateway parses sendbox records and forwards abort signals', async () => {
  const signal = new AbortController().signal;
  const calls: Array<{ path: string; options?: ApiRequestOptions }> = [];
  const request: Requester = async <T>(path: string, options?: ApiRequestOptions): Promise<T> => {
    calls.push({ path, options });
    return { results: [{ id: 8, address: 'sender@example.test', raw: JSON.stringify({ to_mail: 'recipient@example.test', subject: 'Sent', content: 'Body' }) }], count: 1 } as T;
  };
  const gateway = createMailListGateway(request);
  const result = await gateway.load({ mode: 'sent', offset: 0, limit: 20, address: 'sender@example.test', signal });

  assert.equal(result.count, 1);
  assert.equal(result.results[0].id, 8);
  assert.equal(result.results[0].subject, 'Sent');
  assert.equal(calls[0].path, '/admin/sendbox?limit=20&offset=0&address=sender%40example.test');
  assert.equal(calls[0].options?.signal, signal);
});
