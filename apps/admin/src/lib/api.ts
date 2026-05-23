export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiCredentials {
  adminPassword?: string;
  sitePassword?: string;
  userAccessToken?: string;
  addressJwt?: string;
  lang?: string;
}

export interface ApiRequestOptions extends ApiCredentials {
  method?: HttpMethod;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  skipCache?: boolean;
  invalidates?: string[];
}

export type Requester = <T>(path: string, options?: ApiRequestOptions) => Promise<T>;

let fingerprintCache: string | null = null;
const DEFAULT_GET_CACHE_TTL = 60_000;
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_CACHE_ENTRIES = 160;
const requestCache = new Map<string, { expiresAt: number; value?: unknown; promise?: Promise<unknown> }>();

export function clearApiCache(match?: string) {
  if (!match) {
    requestCache.clear();
    return;
  }
  for (const key of requestCache.keys()) {
    if (key.includes(match)) requestCache.delete(key);
  }
}

function getClientFingerprint(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  if (fingerprintCache) return fingerprintCache;
  try {
    const key = 'loven7.fingerprint';
    const stored = window.localStorage.getItem(key);
    if (stored) {
      fingerprintCache = stored;
      return stored;
    }
    const value = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(key, value);
    fingerprintCache = value;
    return value;
  } catch {
    return undefined;
  }
}

export class ApiError extends Error {
  status: number;
  body: string;
  url?: string;
  method?: string;

  constructor(status: number, body: string, message?: string, meta?: { url?: string; method?: string }) {
    super(message || `[${status}] ${body || 'Request failed'}`);
    this.status = status;
    this.body = body;
    this.url = meta?.url;
    this.method = meta?.method;
  }
}

function safeHeaderValue(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'undefined' || /[\r\n\0]/.test(trimmed)) return undefined;
  return trimmed;
}

function shortHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  return (hash >>> 0).toString(36);
}

function authCacheFingerprint(credentials: ApiCredentials, headers?: Record<string, string>): string {
  return shortHash(JSON.stringify({
    admin: safeHeaderValue(credentials.adminPassword) || '',
    site: safeHeaderValue(credentials.sitePassword) || '',
    userAccessToken: safeHeaderValue(credentials.userAccessToken) || '',
    addressJwt: safeHeaderValue(credentials.addressJwt) || '',
    lang: credentials.lang || 'zh',
    headers: headers || {},
  }));
}

function pruneRequestCache() {
  const now = Date.now();
  for (const [key, entry] of requestCache) {
    if (!entry.promise && entry.expiresAt <= now) requestCache.delete(key);
  }
  while (requestCache.size > MAX_CACHE_ENTRIES) {
    const oldest = requestCache.keys().next().value;
    if (!oldest) break;
    requestCache.delete(oldest);
  }
}

function normalizeErrorBody(raw: string): string {
  const text = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 360 ? `${text.slice(0, 360)}…` : text;
}

const INVALIDATION_RULES: Array<{ matcher: RegExp; tags: string[] }> = [
  { matcher: /\/admin\/mails(\b|\/)/, tags: ['/admin/mails', '/admin/statistics'] },
  { matcher: /\/admin\/sendbox(\b|\/)/, tags: ['/admin/sendbox', '/admin/statistics'] },
  { matcher: /\/admin\/send_mail/, tags: ['/admin/sendbox', '/admin/statistics'] },
  { matcher: /\/admin\/users\/bind_address/, tags: ['/admin/users/bind_address', '/admin/address', '/admin/users'] },
  { matcher: /\/admin\/users(\b|\/)/, tags: ['/admin/users', '/admin/address', '/admin/statistics'] },
  { matcher: /\/admin\/address_sender(\b|\/)/, tags: ['/admin/address_sender'] },
  { matcher: /\/admin\/address(\b|\/)/, tags: ['/admin/address', '/admin/statistics', '/admin/users/bind_address'] },
  { matcher: /\/admin\/role_address_config/, tags: ['/admin/role_address_config', '/admin/user_roles'] },
  { matcher: /\/admin\/account_settings/, tags: ['/admin/account_settings'] },
];

function invalidationsForUrl(url: string): string[] {
  for (const rule of INVALIDATION_RULES) if (rule.matcher.test(url)) return rule.tags;
  return [];
}

export function createApiClient(getBaseUrl: () => string, getCredentials: () => ApiCredentials) {
  async function request<T = unknown>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const base = getBaseUrl().replace(/\/$/, '');
    const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? path : `/${path}`}`;
    const method = options.method || 'GET';
    const credentialsForCache = { ...getCredentials(), ...options };
    const useCache = method === 'GET' && options.body === undefined && !options.signal && !options.skipCache;
    const cacheKey = `GET ${url} auth:${authCacheFingerprint(credentialsForCache, options.headers)}`;
    pruneRequestCache();
    if (useCache) {
      if (options.forceRefresh) {
        requestCache.delete(cacheKey);
      } else {
        const cached = requestCache.get(cacheKey);
        if (cached) {
          if (cached.promise) return cached.promise as Promise<T>;
          if (cached.expiresAt > Date.now() && 'value' in cached) return cached.value as T;
          requestCache.delete(cacheKey);
        }
      }
    }

    const execute = async (): Promise<T> => {
      const credentials = { ...getCredentials(), ...options };
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-lang': credentials.lang || 'zh',
        ...(options.headers || {}),
      };
      const fingerprint = getClientFingerprint();
      if (fingerprint) headers['x-fingerprint'] = fingerprint;
      const sitePassword = safeHeaderValue(credentials.sitePassword);
      if (sitePassword) headers['x-custom-auth'] = sitePassword;
      const adminPassword = safeHeaderValue(credentials.adminPassword);
      if (adminPassword) headers['x-admin-auth'] = adminPassword;
      const userAccessToken = safeHeaderValue(credentials.userAccessToken);
      if (userAccessToken) headers['x-user-access-token'] = userAccessToken;
      const addressJwt = safeHeaderValue(credentials.addressJwt);
      if (addressJwt) headers.Authorization = `Bearer ${addressJwt}`;

      const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
      const timeoutController = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const externalSignal = options.signal;
      if (externalSignal && timeoutController) {
        if (externalSignal.aborted) timeoutController.abort();
        else externalSignal.addEventListener('abort', () => timeoutController.abort(), { once: true });
      }
      const timeoutId = timeoutController ? globalThis.setTimeout(() => timeoutController.abort(), timeoutMs) : undefined;
      const init: RequestInit = {
        method,
        headers,
        signal: timeoutController?.signal ?? externalSignal,
      };
      if (options.body !== undefined && init.method !== 'GET') {
        init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      }

      try {
        const response = await fetch(url, init);
        const contentType = response.headers.get('content-type') || '';
        const raw = await response.text();
        if (!response.ok) {
          const body = normalizeErrorBody(raw);
          throw new ApiError(response.status, body, body ? `[${response.status}] ${body}` : `[${response.status}] ${response.statusText}`, { url, method });
        }
        if (!raw) return undefined as T;
        if (contentType.includes('application/json')) {
          try {
            return JSON.parse(raw) as T;
          } catch {
            throw new ApiError(response.status, normalizeErrorBody(raw), `[${response.status}] JSON 解析失败`, { url, method });
          }
        }
        try {
          return JSON.parse(raw) as T;
        } catch {
          return raw as T;
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new ApiError(0, '', `请求超时或已取消：${url}`, { url, method });
        }
        throw error;
      } finally {
        if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
      }
    };

    if (!useCache) {
      const result = await execute();
      if (method !== 'GET') {
        const tags = options.invalidates ?? invalidationsForUrl(url);
        if (tags.length === 0) clearApiCache();
        else for (const tag of tags) clearApiCache(tag);
      }
      return result;
    }

    const promise = execute()
      .then((value) => {
        const entry = requestCache.get(cacheKey);
        if (!entry || entry.promise === promise) {
          requestCache.set(cacheKey, {
            expiresAt: Date.now() + (options.cacheTtlMs ?? DEFAULT_GET_CACHE_TTL),
            value,
          });
        }
        return value;
      })
      .catch((error) => {
        const entry = requestCache.get(cacheKey);
        if (entry?.promise === promise) requestCache.delete(cacheKey);
        throw error;
      });

    requestCache.set(cacheKey, {
      expiresAt: Date.now() + (options.cacheTtlMs ?? DEFAULT_GET_CACHE_TTL),
      promise,
    });
    return promise;
  }

  return { request };
}

export function buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}
