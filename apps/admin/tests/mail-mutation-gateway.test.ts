import assert from 'node:assert/strict';
import test from 'node:test';

import { createMailMutationGateway } from '../src/features/mail/infrastructure/mailMutationGateway.ts';
import type { ApiRequestOptions, Requester } from '../src/lib/api.ts';

const MAIL_INVALIDATIONS = ['/admin/mails', '/admin/mails_unknow', '/admin/sendbox', '/admin/statistics'];

test('mail mutation gateway deletes inbox and unknown records through the raw-mail endpoint', async () => {
  const calls: Array<{ path: string; options?: ApiRequestOptions }> = [];
  const request: Requester = async <T>(path: string, options?: ApiRequestOptions): Promise<T> => {
    calls.push({ path, options });
    return undefined as T;
  };
  const gateway = createMailMutationGateway(request);

  await gateway.delete('inbox', 12);
  await gateway.delete('unknown', 34);

  assert.deepEqual(calls, [
    { path: '/admin/mails/12', options: { method: 'DELETE', invalidates: MAIL_INVALIDATIONS } },
    { path: '/admin/mails/34', options: { method: 'DELETE', invalidates: MAIL_INVALIDATIONS } },
  ]);
});

test('mail mutation gateway deletes sent records through the sendbox endpoint', async () => {
  const calls: Array<{ path: string; options?: ApiRequestOptions }> = [];
  const request: Requester = async <T>(path: string, options?: ApiRequestOptions): Promise<T> => {
    calls.push({ path, options });
    return undefined as T;
  };
  const gateway = createMailMutationGateway(request);

  await gateway.delete('sent', 56);

  assert.deepEqual(calls, [
    { path: '/admin/sendbox/56', options: { method: 'DELETE', invalidates: MAIL_INVALIDATIONS } },
  ]);
});

test('mail mutation gateway rejects invalid mail ids before issuing a request', async () => {
  let requestCount = 0;
  const request: Requester = async <T>(): Promise<T> => {
    requestCount += 1;
    return undefined as T;
  };
  const gateway = createMailMutationGateway(request);

  for (const mailId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(gateway.delete('inbox', mailId), /positive integer/);
  }
  assert.equal(requestCount, 0);
});
