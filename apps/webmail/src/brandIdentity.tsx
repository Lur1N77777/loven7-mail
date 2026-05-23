import { useEffect, useMemo, useState, type CSSProperties } from 'react';

export type BrandIdentity = {
  domain: string;
  displayName: string;
  iconUrl?: string;
  source?: 'cache' | 'proxy' | 'fallback';
  failed?: boolean;
};

type BrandIconCacheRecord = {
  domain: string;
  displayName: string;
  iconUrl: string;
  source: 'cache' | 'proxy' | 'fallback';
  savedAt: number;
};

type NegativeCacheRecord = { domain: string; savedAt: number };

const BRAND_ICON_CACHE_KEY = 'loven7.brandIconCache';
const BRAND_ICON_NEGATIVE_CACHE_KEY = 'loven7.brandIconNegativeCache';
const ICON_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ITEMS = 240;

const BRAND_NAMES: Record<string, string> = {
  'paypal.com': 'PayPal',
  'openai.com': 'OpenAI',
  'chatgpt.com': 'ChatGPT',
  'apple.com': 'Apple',
  'icloud.com': 'Apple',
  'microsoft.com': 'Microsoft',
  'office.com': 'Microsoft 365',
  'outlook.com': 'Outlook',
  'live.com': 'Microsoft',
  'github.com': 'GitHub',
  'google.com': 'Google',
  'gmail.com': 'Gmail',
  'youtube.com': 'YouTube',
  'x.com': 'X',
  'twitter.com': 'X',
  'facebook.com': 'Facebook',
  'meta.com': 'Meta',
  'instagram.com': 'Instagram',
  'linkedin.com': 'LinkedIn',
  'amazon.com': 'Amazon',
  'aws.amazon.com': 'AWS',
  'cloudflare.com': 'Cloudflare',
  'stripe.com': 'Stripe',
  'notion.so': 'Notion',
  'figma.com': 'Figma',
  'slack.com': 'Slack',
  'discord.com': 'Discord',
  'anthropic.com': 'Anthropic',
  'claude.ai': 'Claude',
  'vercel.com': 'Vercel',
  'netflix.com': 'Netflix',
  'shopify.com': 'Shopify',
};

const MULTI_PART_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.hk', 'com.tw', 'co.jp', 'ne.jp', 'or.jp',
  'co.kr', 'com.au', 'net.au', 'org.au', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.br', 'com.mx', 'com.tr', 'co.in', 'firm.in', 'net.in', 'org.in', 'co.nz',
]);

function readMap<T>(key: string): Record<string, T> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed as Record<string, T> : {};
  } catch {
    return {};
  }
}

function writeMap<T extends { savedAt?: number }>(key: string, value: Record<string, T>) {
  if (typeof window === 'undefined') return;
  try {
    const entries = Object.entries(value)
      .sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0))
      .slice(0, MAX_CACHE_ITEMS);
    window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // localStorage can be unavailable in private mode; avatar fallback is enough.
  }
}

function cleanDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

export function extractSenderDomain(value?: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const emailMatch = raw.match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (emailMatch?.[1]) return cleanDomain(emailMatch[1]);
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    if (url.hostname.includes('.')) return cleanDomain(url.hostname);
  } catch {
    // fall through
  }
  const domainMatch = raw.match(/([a-z0-9-]+\.)+[a-z]{2,}/i);
  return domainMatch ? cleanDomain(domainMatch[0]) : '';
}

export function getRegistrableDomain(domain: string): string {
  const clean = cleanDomain(domain);
  if (!clean) return '';
  const brandMatch = Object.keys(BRAND_NAMES)
    .sort((a, b) => b.length - a.length)
    .find((brandDomain) => clean === brandDomain || clean.endsWith(`.${brandDomain}`));
  if (brandMatch) return brandMatch;
  const parts = clean.split('.').filter(Boolean);
  if (parts.length <= 2) return clean;
  const suffix2 = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(suffix2) && parts.length >= 3) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

function humanizeDomain(domain: string): string {
  const root = getRegistrableDomain(domain);
  if (BRAND_NAMES[root]) return BRAND_NAMES[root];
  const first = root.split('.')[0] || domain.split('.')[0] || 'Mail';
  return first
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Mail';
}

export function getBrandIdentity(sender?: string, senderName?: string): BrandIdentity {
  const senderDomain = extractSenderDomain(sender);
  const domain = getRegistrableDomain(senderDomain);
  const displayName = domain ? humanizeDomain(domain) : (senderName || 'Mail');
  return { domain, displayName };
}

function getCachedIcon(domain: string): BrandIconCacheRecord | null {
  const cache = readMap<BrandIconCacheRecord>(BRAND_ICON_CACHE_KEY);
  const record = cache[domain];
  if (!record || Date.now() - Number(record.savedAt || 0) > ICON_TTL_MS) return null;
  return record;
}

function rememberIcon(domain: string, displayName: string, iconUrl: string) {
  const cache = readMap<BrandIconCacheRecord>(BRAND_ICON_CACHE_KEY);
  cache[domain] = { domain, displayName, iconUrl, source: 'proxy', savedAt: Date.now() };
  writeMap(BRAND_ICON_CACHE_KEY, cache);
  const negative = readMap<NegativeCacheRecord>(BRAND_ICON_NEGATIVE_CACHE_KEY);
  if (negative[domain]) {
    delete negative[domain];
    writeMap(BRAND_ICON_NEGATIVE_CACHE_KEY, negative);
  }
}

function isNegativeCached(domain: string): boolean {
  const negative = readMap<NegativeCacheRecord>(BRAND_ICON_NEGATIVE_CACHE_KEY);
  const record = negative[domain];
  return Boolean(record && Date.now() - Number(record.savedAt || 0) < NEGATIVE_TTL_MS);
}

function rememberNegative(domain: string) {
  const negative = readMap<NegativeCacheRecord>(BRAND_ICON_NEGATIVE_CACHE_KEY);
  negative[domain] = { domain, savedAt: Date.now() };
  writeMap(BRAND_ICON_NEGATIVE_CACHE_KEY, negative);
}

function iconEndpoint(domain: string, size: number) {
  const safeSize = Math.max(24, Math.min(96, Math.round(size || 64)));
  return `/api/brand-icon?domain=${encodeURIComponent(domain)}&size=${safeSize}`;
}

function fallbackLetters(identity: BrandIdentity, senderName?: string) {
  const source = senderName || identity.displayName || identity.domain || 'M';
  const ascii = source.match(/[A-Za-z0-9]/)?.[0];
  const char = ascii || source.trim().charAt(0) || 'M';
  return char.toUpperCase();
}

function joinClassName(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(' ');
}

export function BrandAvatar({
  sender,
  senderName,
  size = 32,
  className = '',
}: {
  sender?: string;
  senderName?: string;
  size?: number;
  className?: string;
}) {
  const identity = useMemo(() => getBrandIdentity(sender, senderName), [sender, senderName]);
  const [iconUrl, setIconUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!identity.domain) {
      setIconUrl('');
      setFailed(false);
      return;
    }
    const cached = getCachedIcon(identity.domain);
    if (cached?.iconUrl) {
      setIconUrl(cached.iconUrl);
      setFailed(false);
      return;
    }
    if (isNegativeCached(identity.domain)) {
      setIconUrl('');
      setFailed(true);
      return;
    }
    setIconUrl(iconEndpoint(identity.domain, size));
    setFailed(false);
  }, [identity.domain, size]);

  const label = identity.domain ? `${identity.displayName} 图标` : `${senderName || '发件人'} 头像`;

  return (
    <span
      className={joinClassName('brand-avatar', failed && 'brand-avatar-fallback', className)}
      style={{ '--brand-avatar-size': `${size}px` } as CSSProperties}
      title={identity.domain ? `${identity.displayName} · ${identity.domain}` : senderName || '发件人'}
      aria-label={label}
    >
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => identity.domain && rememberIcon(identity.domain, identity.displayName, iconUrl)}
          onError={() => {
            if (identity.domain) rememberNegative(identity.domain);
            setIconUrl('');
            setFailed(true);
          }}
        />
      ) : (
        <span aria-hidden="true">{fallbackLetters(identity, senderName)}</span>
      )}
    </span>
  );
}

