export function cls(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function parseBackendDate(value?: string | number | Date | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const hasExplicitZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const naiveDateTime = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)$/);
  const naiveDateOnly = raw.match(/^\d{4}-\d{2}-\d{2}$/);
  // Cloudflare D1 / SQLite datetime('now') commonly returns UTC without a timezone suffix.
  // Treat timezone-less backend timestamps as UTC, then format them in Asia/Shanghai.
  const normalized = !hasExplicitZone && naiveDateTime
    ? `${naiveDateTime[1]}T${naiveDateTime[2]}Z`
    : !hasExplicitZone && naiveDateOnly
      ? `${raw}T00:00:00Z`
      : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value?: string | number | Date | null): string {
  if (!value) return '-';
  const date = parseBackendDate(value);
  if (!date) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

export function formatShortDate(value?: string | number | Date | null): string {
  if (!value) return '-';
  const date = parseBackendDate(value);
  if (!date) return String(value);
  const now = new Date();
  const dayFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  const sameDay = dayFormatter.format(date) === dayFormatter.format(now);
  if (sameDay) {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'short', day: 'numeric' }).format(date);
}

export function humanBytes(size = 0): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function normalizeSearch(value: unknown): string {
  return String(value ?? '').toLowerCase().trim();
}

export function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function jsonPretty(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}