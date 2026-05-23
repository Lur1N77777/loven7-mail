import type { PagesHandler } from '../_lib/types';

type PagesContext = Parameters<PagesHandler>[0];

type IconCandidate = { url: URL; source: string };

const MAX_ICON_BYTES = 768 * 1024;
const CACHE_SECONDS = 7 * 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 8000;
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
]);

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      'content-type': 'application/json;charset=utf-8',
      'cache-control': 'public, max-age=1800',
      'x-content-type-options': 'nosniff',
    },
  });
}

function isPrivateIpv4(hostname: string) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function normalizeDomain(value: string | null) {
  const raw = String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!raw || raw.length > 253 || BLOCKED_HOSTS.has(raw) || isPrivateIpv4(raw)) return '';
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(raw)) return '';
  return raw;
}

function normalizeExternalUrl(value: string, base?: URL) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(host) || isPrivateIpv4(host)) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string | URL, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url.toString(), { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function unquoteDnsTxt(value: string) {
  return value.replace(/^"|"$/g, '').replace(/"\s+"/g, '').replace(/\\"/g, '"');
}

async function findBimiCandidate(domain: string): Promise<IconCandidate | null> {
  try {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', `default._bimi.${domain}`);
    url.searchParams.set('type', 'TXT');
    const response = await fetchWithTimeout(url, { headers: { accept: 'application/dns-json' } }, 5000);
    if (!response.ok) return null;
    const data = await response.json() as { Answer?: Array<{ data?: string }> };
    const answers = Array.isArray(data.Answer) ? data.Answer : [];
    for (const answer of answers) {
      const txt = unquoteDnsTxt(String(answer.data || ''));
      if (!/\bv\s*=\s*BIMI1\b/i.test(txt)) continue;
      const logoMatch = txt.match(/(?:^|;)\s*l\s*=\s*([^;\s]+)/i);
      const iconUrl = logoMatch?.[1] ? normalizeExternalUrl(logoMatch[1]) : null;
      if (iconUrl) return { url: iconUrl, source: 'bimi' };
    }
  } catch {
    return null;
  }
  return null;
}

async function findHtmlIconCandidates(domain: string): Promise<IconCandidate[]> {
  const candidates: IconCandidate[] = [];
  const home = normalizeExternalUrl(`https://${domain}/`);
  if (!home) return candidates;
  try {
    const response = await fetchWithTimeout(home, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Loven7-Mail Brand Icon Resolver',
      },
      redirect: 'follow',
    }, 6500);
    if (!response.ok) return candidates;
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    if (!contentType.includes('html')) return candidates;
    const text = (await response.text()).slice(0, 240_000);
    const linkRegex = /<link\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(text))) {
      const tag = match[0];
      const rel = tag.match(/\brel\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() || '';
      if (!rel.includes('icon')) continue;
      const href = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (!href) continue;
      const iconUrl = normalizeExternalUrl(href, response.url ? new URL(response.url) : home);
      if (!iconUrl) continue;
      const score = rel.includes('apple-touch-icon') ? 0 : rel.includes('shortcut') ? 2 : 1;
      candidates.splice(score, 0, { url: iconUrl, source: rel.includes('apple') ? 'apple-touch-icon' : 'html-icon' });
    }
  } catch {
    // ignore homepage parsing failures
  }
  return candidates.slice(0, 5);
}

function baseCandidates(domain: string): IconCandidate[] {
  const urls = [
    `https://${domain}/apple-touch-icon.png`,
    `https://${domain}/apple-touch-icon-precomposed.png`,
    `https://${domain}/favicon.ico`,
    `https://www.${domain}/apple-touch-icon.png`,
    `https://www.${domain}/favicon.ico`,
  ];
  return urls
    .map((value) => normalizeExternalUrl(value))
    .filter((url): url is URL => Boolean(url))
    .map((url) => ({ url, source: url.pathname.includes('apple') ? 'apple-touch-icon' : 'favicon' }));
}

function sniffImageType(bytes: Uint8Array, declared: string) {
  const cleanDeclared = declared.split(';')[0]?.trim().toLowerCase() || '';
  if (ALLOWED_IMAGE_TYPES.has(cleanDeclared)) return cleanDeclared === 'image/jpg' ? 'image/jpeg' : cleanDeclared;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'image/x-icon';
  const prefix = new TextDecoder().decode(bytes.slice(0, 256)).trimStart().toLowerCase();
  if (prefix.startsWith('<svg') || prefix.includes('<svg')) return 'image/svg+xml';
  return '';
}

function sanitizeSvgText(text: string) {
  const lowered = text.toLowerCase();
  if (lowered.includes('<script') || lowered.includes('<foreignobject') || /\son[a-z]+\s*=/.test(lowered) || lowered.includes('javascript:')) {
    return '';
  }
  return text;
}

async function fetchIcon(candidate: IconCandidate) {
  const response = await fetchWithTimeout(candidate.url, {
    redirect: 'follow',
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'user-agent': 'Loven7-Mail Brand Icon Resolver',
    },
  });
  if (!response.ok) return null;
  const length = Number(response.headers.get('content-length') || '0');
  if (length > MAX_ICON_BYTES) return null;
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > MAX_ICON_BYTES) return null;
  const bytes = new Uint8Array(buffer);
  const type = sniffImageType(bytes, response.headers.get('content-type') || '');
  if (!type || !ALLOWED_IMAGE_TYPES.has(type)) return null;

  let body: BodyInit = buffer;
  if (type === 'image/svg+xml') {
    const text = new TextDecoder().decode(bytes);
    const sanitized = sanitizeSvgText(text);
    if (!sanitized) return null;
    body = sanitized;
  }

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': type,
      'cache-control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, immutable`,
      'cross-origin-resource-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
      'x-loven7-brand-source': candidate.source,
    },
  });
}

async function resolveIcon(domain: string) {
  const tried = new Set<string>();
  const candidates: IconCandidate[] = [];
  const bimi = await findBimiCandidate(domain);
  if (bimi) candidates.push(bimi);
  candidates.push(...baseCandidates(domain));
  candidates.push(...await findHtmlIconCandidates(domain));

  for (const candidate of candidates) {
    const key = candidate.url.toString();
    if (tried.has(key)) continue;
    tried.add(key);
    const icon = await fetchIcon(candidate);
    if (icon) return icon;
  }
  return null;
}

export const onRequestGet = async ({ request }: PagesContext) => {
  const requestUrl = new URL(request.url);
  const domain = normalizeDomain(requestUrl.searchParams.get('domain'));
  if (!domain) return jsonError(400, 'domain 参数无效');

  const cache = typeof caches !== 'undefined' ? (caches as unknown as { default?: Cache }).default || null : null;
  const cacheKey = new Request(requestUrl.toString(), { method: 'GET' });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const icon = await resolveIcon(domain);
  if (!icon) return jsonError(404, '未找到可用品牌图标');
  if (cache) await cache.put(cacheKey, icon.clone());
  return icon;
};

