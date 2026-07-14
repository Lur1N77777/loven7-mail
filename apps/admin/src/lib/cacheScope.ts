function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeApiScope(apiBase: string): string {
  const trimmed = String(apiBase || '').trim().replace(/\/+$/, '');
  if (trimmed) {
    try {
      const url = new URL(trimmed);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  }
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin.toLowerCase();
  return 'same-origin';
}

export function buildCacheScope(apiBase: string, identity: string): string {
  const api = normalizeApiScope(apiBase);
  const subject = String(identity || 'anonymous').trim().toLowerCase();
  return `${stableHash(api)}.${stableHash(subject)}`;
}

export function scopedStorageKey(prefix: string, scope: string, ...parts: Array<string | number>): string {
  const safeScope = String(scope || 'anonymous').replace(/[^a-z0-9._-]/gi, '_');
  const suffix = parts.map((part) => encodeURIComponent(String(part))).join('.');
  return `${prefix}v2.${safeScope}${suffix ? `.${suffix}` : ''}`;
}
