export type ShareLifecycleStatus = 'active' | 'expired' | 'revoked';

export type ShareLifecycleRecord = {
  token?: string;
  status?: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
};

export function shareLifecycleStatus(row: ShareLifecycleRecord, now = Date.now()): ShareLifecycleStatus {
  if (row.revokedAt || row.status === 'revoked') return 'revoked';
  const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : 0;
  if (row.status === 'expired' || (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now)) return 'expired';
  return 'active';
}

export function selectExpiredShareTokens(rows: ShareLifecycleRecord[], now = Date.now()): string[] {
  return rows
    .filter((row) => shareLifecycleStatus(row, now) === 'expired')
    .map((row) => String(row.token || '').trim())
    .filter(Boolean);
}
