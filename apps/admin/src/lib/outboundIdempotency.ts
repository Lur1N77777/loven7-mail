export type OutboundIdempotencyAttempt = Readonly<{
  key: string;
  fingerprint: string;
}>;

type CreateKey = () => string;

function createUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Secure UUID generation is unavailable');
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10).join(''),
  ].join('-');
}

function payloadFingerprint(scope: string, payload: unknown): string {
  return `${scope}\n${JSON.stringify(payload)}`;
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as {
    status?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };
  const directStatus = record.status === null
    || typeof record.status === 'undefined'
    || record.status === ''
    ? Number.NaN
    : Number(record.status);
  if (Number.isInteger(directStatus) && directStatus >= 0 && directStatus <= 599) {
    return directStatus;
  }
  const rawResponseStatus = record.response?.status;
  const responseStatus = rawResponseStatus === null
    || typeof rawResponseStatus === 'undefined'
    || rawResponseStatus === ''
    ? Number.NaN
    : Number(rawResponseStatus);
  if (Number.isInteger(responseStatus) && responseStatus >= 100 && responseStatus <= 599) {
    return responseStatus;
  }
  const message = typeof record.message === 'string' ? record.message : '';
  const match = message.match(/(?:^|\[|Code\s+)([1-5]\d{2})(?=\]|:|\s|$)/i);
  return match ? Number(match[1]) : null;
}

export function isRetryableOutboundError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === null || status === 0 || status >= 500;
}

export function createOutboundIdempotencyTracker(createKey: CreateKey = createUuid) {
  let pending: OutboundIdempotencyAttempt | null = null;

  return {
    begin(scope: string, payload: unknown): OutboundIdempotencyAttempt {
      const fingerprint = payloadFingerprint(scope, payload);
      if (!pending || pending.fingerprint !== fingerprint) {
        pending = Object.freeze({ key: createKey(), fingerprint });
      }
      return pending;
    },
    succeeded(attempt: OutboundIdempotencyAttempt): void {
      if (pending?.key === attempt.key && pending.fingerprint === attempt.fingerprint) {
        pending = null;
      }
    },
    failed(attempt: OutboundIdempotencyAttempt, error: unknown): void {
      if (
        pending?.key === attempt.key
        && pending.fingerprint === attempt.fingerprint
        && !isRetryableOutboundError(error)
      ) {
        pending = null;
      }
    },
    clear(): void {
      pending = null;
    },
  };
}
