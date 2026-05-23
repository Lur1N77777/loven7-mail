import { COOKIE_MIRROR_MAX_AGE_DAYS, STORAGE_KEYS } from './constants';

export type AuthCookieMirror = {
  apiBase?: string;
  adminPassword?: string;
  sitePassword?: string;
  userAccessToken?: string;
  rememberedAt?: number;
};

function base64Encode(value: string): string {
  if (typeof TextEncoder === 'undefined' || typeof btoa === 'undefined') return value;
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64Decode(value: string): string {
  if (typeof TextDecoder === 'undefined' || typeof atob === 'undefined') return value;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function encodeForCookie(value: unknown): string {
  return base64Encode(JSON.stringify(value));
}

function decodeFromCookie<T>(value: string): T | null {
  const decoded = base64Decode(value);
  if (!decoded) return null;
  try {
    return JSON.parse(decoded) as T;
  } catch {
    return null;
  }
}

function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const prefix = `${encodeURIComponent(name)}=`;
  const item = document.cookie.split('; ').find((part) => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : '';
}

function writeCookie(name: string, value: string, maxAgeDays = COOKIE_MIRROR_MAX_AGE_DAYS): void {
  if (typeof document === 'undefined') return;
  const maxAge = Math.max(1, Math.floor(maxAgeDays * 86400));
  const isHttps = typeof window !== 'undefined' && window.location?.protocol === 'https:';
  const secureFlag = isHttps ? '; Secure' : '';
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Strict${secureFlag}`;
}

export function readAuthCookieMirror(): AuthCookieMirror {
  const raw = readCookie(STORAGE_KEYS.authCookieMirror);
  if (!raw) return {};
  return decodeFromCookie<AuthCookieMirror>(raw) || {};
}

export function writeAuthCookieMirror(value: AuthCookieMirror): void {
  try {
    const compact: AuthCookieMirror = {
      apiBase: value.apiBase || '',
      adminPassword: value.adminPassword || '',
      sitePassword: value.sitePassword || '',
      userAccessToken: value.userAccessToken || '',
      rememberedAt: value.rememberedAt || Date.now(),
    };
    writeCookie(STORAGE_KEYS.authCookieMirror, encodeForCookie(compact));
  } catch {
    // Cookie mirror is best-effort; localStorage remains the primary store.
  }
}

export function readStorage(key: string, fallback = ''): string {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.sessionStorage.getItem(key) ?? window.localStorage.getItem(key);
    if (stored !== null) return stored;
    const mirror = readAuthCookieMirror();
    if (key === STORAGE_KEYS.apiBase) return mirror.apiBase ?? fallback;
    if (key === STORAGE_KEYS.adminPassword) return mirror.adminPassword ?? fallback;
    if (key === STORAGE_KEYS.sitePassword) return mirror.sitePassword ?? fallback;
    if (key === STORAGE_KEYS.userAccessToken) return mirror.userAccessToken ?? fallback;
    if (key === STORAGE_KEYS.authRememberedAt) return mirror.rememberedAt ? String(mirror.rememberedAt) : fallback;
    return fallback;
  } catch {
    return fallback;
  }
}

export function writeSessionStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // ignore storage failures in privacy mode
  }
}

export function writeLocalStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // ignore storage failures in privacy mode
  }
}

export function readJsonStorage<T>(key: string, fallback: T): T {
  const raw = readStorage(key, '');
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonStorage(key: string, value: unknown): void {
  writeLocalStorage(key, JSON.stringify(value));
}
