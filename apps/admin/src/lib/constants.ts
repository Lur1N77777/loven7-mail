export const DEFAULT_PAGE_SIZE = 20;

export const STORAGE_KEYS = {
  adminPassword: 'loven7.adminPassword',
  sitePassword: 'loven7.sitePassword',
  userAccessToken: 'loven7.userAccessToken',
  addressJwt: 'loven7.addressJwt',
  apiBase: 'loven7.apiBase',
  authRememberedAt: 'loven7.authRememberedAt',
  authCookieMirror: 'loven7.authCookieMirror',
  uiTheme: 'loven7.uiTheme',
  addressUserFilter: 'loven7.addressUserFilter',
  newAddressDraft: 'loven7.newAddressDraft',
  frontendLoginBase: 'loven7.frontendLoginBase',
  mailAutoRefreshEnabled: 'loven7.mailAutoRefreshEnabled',
  mailAutoRefreshSeconds: 'loven7.mailAutoRefreshSeconds',
  mailReadIds: 'loven7.mailReadIds',
  mailStarredIds: 'loven7.mailStarredIds',
  mailReadAllBefore: 'loven7.mailReadAllBefore',
  mailListCachePrefix: 'loven7.mailListCache.',
  mailDetailSessionPrefix: 'loven7.mailDetailSession.',
  addressListCachePrefix: 'loven7.addressListCache.',
  senderAccessListCachePrefix: 'loven7.senderAccessListCache.',
  userListCachePrefix: 'loven7.userListCache.',
};

export const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
export const FRONTEND_LOGIN_BASE = (import.meta.env.VITE_FRONTEND_LOGIN_BASE || '').replace(/\/$/, '');

export const CACHE_TTL = {
  stats: 30_000,
  settings: 120_000,
  list: 60_000,
  shortList: 30_000,
  senderAccess: 45_000,
  userOptions: 120_000,
  role: 120_000,
} as const;

export const SWIPE = {
  startThreshold: 18,
  ratio: 1.15,
  pageMinDistance: 78,
  pageMaxVertical: 96,
  pageRatio: 1.25,
  mailMinDistance: 72,
  mailMaxVertical: 64,
} as const;

export const TOAST_MS = 3600;
export const COPY_HINT_MS = 1300;
export const NEW_MAIL_FLASH_MS = 1600;
export const ADDRESS_INPUT_DEBOUNCE_MS = 120;

export const PREVIEW_LEN = 180;
export const MAIL_READ_HISTORY_MAX = 2000;
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

export const COOKIE_MIRROR_MAX_AGE_DAYS = 7;
export const AUTH_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

export function isAllowedApiBase(value: string): { ok: boolean; reason?: string } {
  const trimmed = (value || '').trim();
  if (!trimmed) return { ok: true };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: '不是有效的 URL，请填写完整的 https:// 地址' };
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return { ok: false, reason: '为了防止凭证泄漏，仅允许 https:// 地址（本地测试可用 localhost/127.0.0.1）' };
  }
  return { ok: true };
}
