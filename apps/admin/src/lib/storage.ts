import { API_BASE, AUTH_IDLE_TIMEOUT_MS, COOKIE_MIRROR_MAX_AGE_DAYS, STORAGE_KEYS } from './constants';

export type AuthCookieMirror = {
  apiBase?: string;
  rememberedAt?: number;
};

type LegacyAuthCookieMirror = AuthCookieMirror & {
  adminPassword?: string;
  sitePassword?: string;
  userAccessToken?: string;
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

function deleteCookie(name: string): void {
  if (typeof document === 'undefined') return;
  const isHttps = typeof window !== 'undefined' && window.location?.protocol === 'https:';
  const secureFlag = isHttps ? '; Secure' : '';
  document.cookie = `${encodeURIComponent(name)}=; Max-Age=0; Path=/; SameSite=Strict${secureFlag}`;
}

export function readAuthCookieMirror(): AuthCookieMirror {
  const raw = readCookie(STORAGE_KEYS.authCookieMirror);
  if (!raw) return {};
  const decoded = decodeFromCookie<LegacyAuthCookieMirror>(raw);
  if (!decoded) return {};
  const safeMirror: AuthCookieMirror = {
    apiBase: decoded.apiBase || '',
    rememberedAt: decoded.rememberedAt || undefined,
  };
  if ("adminPassword" in decoded || "sitePassword" in decoded || "userAccessToken" in decoded) {
    try {
      writeCookie(STORAGE_KEYS.authCookieMirror, encodeForCookie(safeMirror));
    } catch {
      // Scrubbing a legacy cookie is best-effort.
    }
  }
  return safeMirror;
}

export function writeAuthCookieMirror(value: AuthCookieMirror): void {
  try {
    const compact: AuthCookieMirror = {
      apiBase: value.apiBase || '',
      rememberedAt: value.rememberedAt || Date.now(),
    };
    writeCookie(STORAGE_KEYS.authCookieMirror, encodeForCookie(compact));
  } catch {
    // Cookie mirror is best-effort; sensitive credentials stay in browser storage only.
  }
}

export type AuthExpiryCheck = {
  expired: boolean;
  migrated: boolean;
  rememberedAt: number;
  hadPrivateAuth: boolean;
};

export type BoundAuth = {
  adminPassword: string;
  sitePassword: string;
  userAccessToken: string;
  addressJwt: string;
  rememberedAt: number;
};

type BoundAuthField = keyof BoundAuth;

const BOUND_AUTH_FIELDS: BoundAuthField[] = [
  'adminPassword',
  'sitePassword',
  'userAccessToken',
  'addressJwt',
  'rememberedAt',
];

const BOUND_AUTH_LEGACY_KEY: Record<BoundAuthField, string> = {
  adminPassword: STORAGE_KEYS.adminPassword,
  sitePassword: STORAGE_KEYS.sitePassword,
  userAccessToken: STORAGE_KEYS.userAccessToken,
  addressJwt: STORAGE_KEYS.addressJwt,
  rememberedAt: STORAGE_KEYS.authRememberedAt,
};

const AUTH_PRIVATE_STORAGE_KEYS = [
  STORAGE_KEYS.adminPassword,
  STORAGE_KEYS.sitePassword,
  STORAGE_KEYS.userAccessToken,
  STORAGE_KEYS.addressJwt,
  STORAGE_KEYS.authRememberedAt,
  STORAGE_KEYS.authExpiredNotice,
  STORAGE_KEYS.addressUserFilter,
  STORAGE_KEYS.shareAdminListCache,
  STORAGE_KEYS.mailReadIds,
  STORAGE_KEYS.mailStarredIds,
  STORAGE_KEYS.mailReadAllBefore,
];

const AUTH_PRIVATE_STORAGE_PREFIXES = [
  STORAGE_KEYS.authScopedPrefix,
  STORAGE_KEYS.mailListCachePrefix,
  STORAGE_KEYS.mailDetailSessionPrefix,
  `${STORAGE_KEYS.mailReadIds}.`,
  `${STORAGE_KEYS.mailStarredIds}.`,
  `${STORAGE_KEYS.mailReadAllBefore}.`,
  STORAGE_KEYS.addressListCachePrefix,
  STORAGE_KEYS.senderAccessListCachePrefix,
  STORAGE_KEYS.userListCachePrefix,
];

function shouldTouchAuthCookieMirror(key: string): boolean {
  return key === STORAGE_KEYS.apiBase
    || key === STORAGE_KEYS.authRememberedAt
    || key === STORAGE_KEYS.adminPassword
    || key === STORAGE_KEYS.sitePassword
    || key === STORAGE_KEYS.userAccessToken;
}

function parseTimestamp(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function normalizeAuthApiBase(value: string): string {
  return (value || '').trim().replace(/\/+$/, '');
}

function toBase64Url(value: string): string {
  const encoded = base64Encode(value);
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function authScopeId(apiBase: string): string {
  return toBase64Url(normalizeAuthApiBase(apiBase) || 'same-origin') || 'same-origin';
}

function scopedAuthKeyByScope(scope: string, field: BoundAuthField): string {
  return `${STORAGE_KEYS.authScopedPrefix}${scope}.${field}`;
}

function scopedAuthKey(apiBase: string, field: BoundAuthField): string {
  return scopedAuthKeyByScope(authScopeId(apiBase), field);
}

function readStorageItem(storage: Storage, key: string): string {
  try {
    return storage.getItem(key) || '';
  } catch {
    return '';
  }
}

function getBrowserStorages(): Storage[] {
  if (typeof window === 'undefined') return [];
  const storages: Storage[] = [];
  [() => window.sessionStorage, () => window.localStorage].forEach((getStorage) => {
    try {
      storages.push(getStorage());
    } catch {
      // Accessing storage itself can fail in hardened/privacy browser modes.
    }
  });
  return storages;
}

function removeStorageKey(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // ignore storage failures in privacy mode
  }
}

function removeStoragePrefixes(storage: Storage, prefixes: string[]): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    keys.forEach((key) => storage.removeItem(key));
  } catch {
    // ignore storage failures in privacy mode
  }
}

function writeStorageItem(storage: Storage, key: string, value: string): void {
  try {
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
  } catch {
    // ignore storage failures in privacy mode
  }
}

function readFirstStorageItem(storages: Storage[], key: string): string {
  for (const storage of storages) {
    const value = readStorageItem(storage, key);
    if (value) return value;
  }
  return '';
}

function hasPrivateAuthValue(auth: BoundAuth): boolean {
  return Boolean(auth.adminPassword || auth.sitePassword || auth.userAccessToken || auth.addressJwt);
}

function emptyBoundAuth(): BoundAuth {
  return {
    adminPassword: '',
    sitePassword: '',
    userAccessToken: '',
    addressJwt: '',
    rememberedAt: 0,
  };
}

function readLegacyBoundAuth(storages: Storage[], mirror: AuthCookieMirror): BoundAuth {
  const auth = emptyBoundAuth();
  auth.adminPassword = readFirstStorageItem(storages, STORAGE_KEYS.adminPassword);
  auth.sitePassword = readFirstStorageItem(storages, STORAGE_KEYS.sitePassword);
  auth.userAccessToken = readFirstStorageItem(storages, STORAGE_KEYS.userAccessToken);
  auth.addressJwt = readFirstStorageItem(storages, STORAGE_KEYS.addressJwt);
  const storageRememberedAtValues = storages
    .map((storage) => parseTimestamp(readStorageItem(storage, STORAGE_KEYS.authRememberedAt)))
    .filter((value) => value > 0);
  auth.rememberedAt = storageRememberedAtValues.length
    ? Math.max(...storageRememberedAtValues)
    : parseTimestamp(mirror.rememberedAt);
  return auth;
}

function readBoundAuthFromStorages(storages: Storage[], apiBase: string): BoundAuth {
  const auth = emptyBoundAuth();
  auth.adminPassword = readFirstStorageItem(storages, scopedAuthKey(apiBase, 'adminPassword'));
  auth.sitePassword = readFirstStorageItem(storages, scopedAuthKey(apiBase, 'sitePassword'));
  auth.userAccessToken = readFirstStorageItem(storages, scopedAuthKey(apiBase, 'userAccessToken'));
  auth.addressJwt = readFirstStorageItem(storages, scopedAuthKey(apiBase, 'addressJwt'));
  auth.rememberedAt = Math.max(...storages.map((storage) => parseTimestamp(readStorageItem(storage, scopedAuthKey(apiBase, 'rememberedAt')))), 0);
  return auth;
}

function writeBoundAuthToStorages(storages: Storage[], apiBase: string, auth: Partial<BoundAuth>, rememberedAt = Date.now()): void {
  const hasAuth = Boolean(auth.adminPassword || auth.sitePassword || auth.userAccessToken || auth.addressJwt);
  const values: Record<BoundAuthField, string> = {
    adminPassword: auth.adminPassword || '',
    sitePassword: auth.sitePassword || '',
    userAccessToken: auth.userAccessToken || '',
    addressJwt: auth.addressJwt || '',
    rememberedAt: hasAuth ? String(auth.rememberedAt || rememberedAt) : '',
  };
  storages.forEach((storage) => {
    BOUND_AUTH_FIELDS.forEach((field) => writeStorageItem(storage, scopedAuthKey(apiBase, field), values[field]));
  });
}

function removeLegacyAuthKeys(storages: Storage[]): void {
  storages.forEach((storage) => {
    BOUND_AUTH_FIELDS.forEach((field) => removeStorageKey(storage, BOUND_AUTH_LEGACY_KEY[field]));
  });
}

function resolveStoredApiBase(fallback = API_BASE): string {
  const storages = getBrowserStorages();
  const stored = readFirstStorageItem(storages, STORAGE_KEYS.apiBase);
  if (stored) return normalizeAuthApiBase(stored);
  const mirror = readAuthCookieMirror();
  return normalizeAuthApiBase(mirror.apiBase || fallback);
}

function collectAuthScopes(storages: Storage[]): Set<string> {
  const scopes = new Set<string>();
  storages.forEach((storage) => {
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key?.startsWith(STORAGE_KEYS.authScopedPrefix)) continue;
        const rest = key.slice(STORAGE_KEYS.authScopedPrefix.length);
        const separator = rest.lastIndexOf('.');
        if (separator > 0) scopes.add(rest.slice(0, separator));
      }
    } catch {
      // ignore storage failures in privacy mode
    }
  });
  return scopes;
}

function readScopedAuthByScope(storages: Storage[], scope: string): BoundAuth {
  const auth = emptyBoundAuth();
  auth.adminPassword = readFirstStorageItem(storages, scopedAuthKeyByScope(scope, 'adminPassword'));
  auth.sitePassword = readFirstStorageItem(storages, scopedAuthKeyByScope(scope, 'sitePassword'));
  auth.userAccessToken = readFirstStorageItem(storages, scopedAuthKeyByScope(scope, 'userAccessToken'));
  auth.addressJwt = readFirstStorageItem(storages, scopedAuthKeyByScope(scope, 'addressJwt'));
  auth.rememberedAt = Math.max(...storages.map((storage) => parseTimestamp(readStorageItem(storage, scopedAuthKeyByScope(scope, 'rememberedAt')))), 0);
  return auth;
}

function writeScopedRememberedAtByScope(storages: Storage[], scope: string, rememberedAt: number): void {
  storages.forEach((storage) => writeStorageItem(storage, scopedAuthKeyByScope(scope, 'rememberedAt'), String(rememberedAt)));
}

function removeAuthScope(storages: Storage[], scope: string): void {
  storages.forEach((storage) => {
    BOUND_AUTH_FIELDS.forEach((field) => removeStorageKey(storage, scopedAuthKeyByScope(scope, field)));
  });
}

function clearPrivateCaches(storages: Storage[]): void {
  const cachePrefixes = AUTH_PRIVATE_STORAGE_PREFIXES.filter((prefix) => prefix !== STORAGE_KEYS.authScopedPrefix);
  storages.forEach((storage) => {
    removeStorageKey(storage, STORAGE_KEYS.addressUserFilter);
    removeStorageKey(storage, STORAGE_KEYS.shareAdminListCache);
    removeStorageKey(storage, STORAGE_KEYS.mailReadIds);
    removeStorageKey(storage, STORAGE_KEYS.mailStarredIds);
    removeStorageKey(storage, STORAGE_KEYS.mailReadAllBefore);
    removeStoragePrefixes(storage, cachePrefixes);
  });
}

export function readBoundAuth(apiBase: string): BoundAuth {
  if (typeof window === 'undefined') return emptyBoundAuth();
  return readBoundAuthFromStorages(getBrowserStorages(), normalizeAuthApiBase(apiBase));
}

export function writeBoundAuth(apiBase: string, auth: Partial<BoundAuth>, rememberedAt = Date.now()): void {
  if (typeof window === 'undefined') return;
  const normalizedBase = normalizeAuthApiBase(apiBase);
  const storages = getBrowserStorages();
  writeBoundAuthToStorages(storages, normalizedBase, auth, rememberedAt);
  removeLegacyAuthKeys(storages);
  if (auth.adminPassword || auth.sitePassword || auth.userAccessToken || auth.addressJwt) {
    writeAuthCookieMirror({ apiBase: normalizedBase, rememberedAt: auth.rememberedAt || rememberedAt });
  }
}

export function purgeExpiredAuthStorage(now = Date.now()): AuthExpiryCheck {
  const fallback: AuthExpiryCheck = { expired: false, migrated: false, rememberedAt: 0, hadPrivateAuth: false };
  if (typeof window === 'undefined') return fallback;
  try {
    const storages = getBrowserStorages();
    const mirror = readAuthCookieMirror();
    const currentApiBase = resolveStoredApiBase();
    const currentScope = authScopeId(currentApiBase);
    const legacyAuth = readLegacyBoundAuth(storages, mirror);
    const hadLegacyAuth = hasPrivateAuthValue(legacyAuth);
    const existingCurrentAuth = readScopedAuthByScope(storages, currentScope);
    const currentScopeAlreadyBound = hasPrivateAuthValue(existingCurrentAuth);
    let expired = false;
    let migrated = false;
    let rememberedAt = Math.max(legacyAuth.rememberedAt, existingCurrentAuth.rememberedAt);
    let hadPrivateAuth = hadLegacyAuth;
    if (hadLegacyAuth) {
      if (!legacyAuth.rememberedAt) {
        legacyAuth.rememberedAt = now;
        rememberedAt = Math.max(rememberedAt, now);
        migrated = true;
      }
      if (now - legacyAuth.rememberedAt > AUTH_IDLE_TIMEOUT_MS) {
        removeLegacyAuthKeys(storages);
        if (!currentScopeAlreadyBound) {
          clearPrivateCaches(storages);
          deleteCookie(STORAGE_KEYS.authCookieMirror);
          writeLocalStorage(STORAGE_KEYS.authExpiredNotice, String(now));
          expired = true;
        }
      } else if (currentScopeAlreadyBound) {
        removeLegacyAuthKeys(storages);
        migrated = true;
      } else {
        writeBoundAuthToStorages(storages, currentApiBase, legacyAuth, legacyAuth.rememberedAt);
        writeAuthCookieMirror({ apiBase: currentApiBase, rememberedAt: legacyAuth.rememberedAt });
        removeLegacyAuthKeys(storages);
        migrated = true;
      }
    }
    const scopes = collectAuthScopes(storages);
    scopes.forEach((scope) => {
      const scopedAuth = readScopedAuthByScope(storages, scope);
      if (!hasPrivateAuthValue(scopedAuth)) return;
      hadPrivateAuth = true;
      if (!scopedAuth.rememberedAt) {
        writeScopedRememberedAtByScope(storages, scope, now);
        scopedAuth.rememberedAt = now;
        migrated = true;
      }
      rememberedAt = Math.max(rememberedAt, scopedAuth.rememberedAt);
      if (now - scopedAuth.rememberedAt <= AUTH_IDLE_TIMEOUT_MS) return;
      removeAuthScope(storages, scope);
      clearPrivateCaches(storages);
      if (scope === currentScope) {
        deleteCookie(STORAGE_KEYS.authCookieMirror);
        writeLocalStorage(STORAGE_KEYS.authExpiredNotice, String(now));
        expired = true;
      }
    });
    if (!hadPrivateAuth) return { ...fallback, rememberedAt };
    return { expired, migrated, rememberedAt, hadPrivateAuth };
  } catch {
    return fallback;
  }
}

export function forgetAuthBrowserStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    deleteCookie(STORAGE_KEYS.authCookieMirror);
  } catch {
    // Cookie mirror deletion is best-effort.
  }
  getBrowserStorages().forEach((storage) => {
    AUTH_PRIVATE_STORAGE_KEYS.forEach((key) => removeStorageKey(storage, key));
    removeStoragePrefixes(storage, AUTH_PRIVATE_STORAGE_PREFIXES);
  });
}

export function readStorage(key: string, fallback = ''): string {
  if (typeof window === 'undefined') return fallback;
  try {
    const mirror = shouldTouchAuthCookieMirror(key) ? readAuthCookieMirror() : {};
    if (key === STORAGE_KEYS.adminPassword) return readBoundAuth(resolveStoredApiBase()).adminPassword || fallback;
    if (key === STORAGE_KEYS.sitePassword) return readBoundAuth(resolveStoredApiBase()).sitePassword || fallback;
    if (key === STORAGE_KEYS.userAccessToken) return readBoundAuth(resolveStoredApiBase()).userAccessToken || fallback;
    if (key === STORAGE_KEYS.addressJwt) return readBoundAuth(resolveStoredApiBase()).addressJwt || fallback;
    if (key === STORAGE_KEYS.authRememberedAt) {
      const rememberedAt = readBoundAuth(resolveStoredApiBase()).rememberedAt || parseTimestamp(mirror.rememberedAt);
      return rememberedAt ? String(rememberedAt) : fallback;
    }
    const stored = window.sessionStorage.getItem(key) ?? window.localStorage.getItem(key);
    if (stored !== null) return stored;
    if (key === STORAGE_KEYS.apiBase) return mirror.apiBase ?? fallback;
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
