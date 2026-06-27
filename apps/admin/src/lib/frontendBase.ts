export function normalizeFrontendBaseUrl(value: string): string {
  const cleaned = String(value || '')
    .trim()
    .replace(/%20/gi, '')
    .replace(/\s+/g, '')
    .replace(/\/+$/, '');
  if (!cleaned) return '';
  try {
    const url = new URL(cleaned);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    url.hash = '';
    url.search = '';
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
  } catch {
    return '';
  }
}

export function isLocalAdminOrigin(origin: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
}
