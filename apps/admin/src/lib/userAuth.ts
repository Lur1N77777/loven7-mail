import { sha256Hex } from './crypto';
import { normalizeFrontendBaseUrl } from './frontendBase';

export type OAuthClientInfo = {
  clientID: string;
  name: string;
  icon?: string;
};

export type OpenUserSettings = {
  enable?: boolean;
  enableMailVerify?: boolean;
  oauth2ClientIDs?: OAuthClientInfo[];
};

export type AccountUserProfile = {
  userToken: string;
  userEmail: string;
  userId: number;
  username: string;
  isAdmin: boolean;
  roleKey: string;
  roleLabel: string;
  userRole?: Record<string, unknown> | string | null;
  accessToken: string;
  newUserToken?: string;
  linuxDoEmail?: string;
  linuxDoId?: string;
};

export type UserAddress = {
  id: number;
  name: string;
  mail_count?: number;
  send_count?: number;
  created_at?: string;
  updated_at?: string;
};

export type AddressSettings = {
  address?: string;
  domains?: string[];
  defaultDomains?: string[];
  domainLabels?: string[];
  randomSubdomainDomains?: string[];
};

export type AddressMail = {
  id: number;
  source?: string;
  address?: string;
  subject?: string;
  raw?: string;
  metadata?: string;
  created_at?: string;
};

export type UserShareExpiry = '1d' | '7d' | '30d' | 'forever';
export type UserShareMailVisibility = 'new' | 'all';
export type UserShareResult = {
  url: string;
  token?: string;
  expiresAt?: string | null;
  addresses?: Array<{ id: string; address: string; mailCount?: number }>;
};

type RequestInitLite = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  search?: URLSearchParams;
};

function baseUrl(apiBase: string) {
  return String(apiBase || '').replace(/\/+$/, '');
}

function endpoint(apiBase: string, path: string, search?: URLSearchParams) {
  const base = baseUrl(apiBase);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (!base) {
    const query = search?.toString();
    return `${normalizedPath}${query ? `?${query}` : ''}`;
  }
  let url: URL;
  try {
    url = new URL(`${base}${normalizedPath}`);
  } catch {
    throw new Error('后台 API 地址无效，请联系管理员检查 API 地址配置。');
  }
  if (search) url.search = search.toString();
  return url.toString();
}

async function apiRequest<T>(apiBase: string, path: string, init: RequestInitLite = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  const response = await fetch(endpoint(apiBase, path, init.search), {
    method: init.method || (hasBody ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      'x-lang': 'zh',
      ...(init.headers || {}),
    },
    body: hasBody ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const record = data && typeof data === 'object' ? data as Record<string, any> : {};
    const message = record?.error?.message || record?.message || (typeof data === 'string' ? data : '') || response.statusText || 'Request failed';
    throw new Error(String(message));
  }
  return data as T;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const segment = token.split('.')[1] || '';
    const json = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  } catch {
    return {};
  }
}

function extractRoleLabel(userRole: unknown) {
  if (typeof userRole === 'string') return userRole;
  if (!userRole || typeof userRole !== 'object') return '';
  const role = userRole as Record<string, unknown>;
  return String(role.label || role.roleLabel || role.role_text || role.roleText || role.role || role.name || '');
}

function normalizeRoleValue(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim().toLowerCase();
  return '';
}

function isTrueFlag(value: unknown) {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return /^(1|true|yes|y)$/i.test(value.trim());
}

export function isAdminRoleValue(value: unknown) {
  const role = normalizeRoleValue(value);
  return role === 'admin' || role === 'administrator' || role === '管理员';
}

function extractRoleKey(source: Record<string, unknown>, userRole: unknown) {
  const directRole = normalizeRoleValue(source.role_text || source.roleText || source.role || source.role_name || source.roleName || source.roleLabel || source.role_key || source.roleKey);
  if (directRole) return directRole;
  if (typeof userRole === 'string' || typeof userRole === 'number') return normalizeRoleValue(userRole);
  if (userRole && typeof userRole === 'object') {
    const role = userRole as Record<string, unknown>;
    return normalizeRoleValue(role.role_text || role.roleText || role.role || role.key || role.value || role.name || role.label);
  }
  return '';
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function collectProfileRecords(raw: Record<string, unknown>) {
  const records: Record<string, unknown>[] = [raw];
  const nestedKeys = ['user', 'profile', 'data', 'result'];
  for (const key of nestedKeys) {
    const nested = asRecord(raw[key]);
    if (!nested) continue;
    records.push(nested);
    for (const childKey of nestedKeys) {
      const child = asRecord(nested[childKey]);
      if (child) records.push(child);
    }
  }
  return records;
}

function normalizeProfile(userToken: string, raw: Record<string, unknown>): AccountUserProfile {
  const tokenPayload = decodeJwtPayload(userToken);
  const source = Object.assign({}, tokenPayload, ...collectProfileRecords(raw));
  const rawRole = source.user_role || source.userRole;
  const userRole = rawRole && (typeof rawRole === 'object' || typeof rawRole === 'string') ? rawRole as Record<string, unknown> | string : null;
  const userEmail = firstString(source, ['user_email', 'userEmail', 'email', 'mail']);
  const userId = Number(firstString(source, ['user_id', 'userId', 'id', 'sub']) || 0);
  const username = firstString(source, ['username', 'user_name', 'userName', 'name', 'preferred_username', 'preferredUsername', 'display_name', 'displayName']);
  const roleKey = extractRoleKey(source, userRole);
  return {
    userToken,
    userEmail,
    userId: Number.isFinite(userId) ? userId : 0,
    username,
    isAdmin: isTrueFlag(source.is_admin) || isTrueFlag(source.isAdmin) || isTrueFlag(source.admin) || isTrueFlag(source.is_administrator) || isTrueFlag(source.isAdministrator) || isAdminRoleValue(roleKey),
    roleKey,
    roleLabel: extractRoleLabel(userRole) || roleKey,
    userRole,
    accessToken: firstString(source, ['access_token', 'user_access_token', 'accessToken', 'userAccessToken', 'admin_access_token', 'adminAccessToken']),
    newUserToken: firstString(source, ['new_user_token', 'newUserToken']),
    linuxDoEmail: firstString(source, ['linuxdo_email', 'linuxDoEmail', 'linux_do_email', 'oauth_email', 'oauthEmail', 'external_email', 'externalEmail']),
    linuxDoId: firstString(source, ['linuxdo_id', 'linuxDoId', 'linux_do_id', 'oauth_id', 'oauthId', 'external_id', 'externalId']),
  };
}

export function roleDomains(profile: AccountUserProfile | null) {
  const domains = profile?.userRole && typeof profile.userRole === 'object' ? profile.userRole.domains : undefined;
  if (!Array.isArray(domains)) return [];
  return domains.map((domain) => String(domain || '').trim()).filter(Boolean);
}

export async function fetchAdminUserRole(apiBase: string, adminPassword: string, email: string) {
  const cleanEmail = email.trim().toLowerCase();
  if (!adminPassword || !cleanEmail) return '';
  const search = new URLSearchParams({ limit: '20', offset: '0', query: cleanEmail });
  const raw = await apiRequest<{ results?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(apiBase, '/admin/users', {
    search,
    headers: { 'x-admin-auth': adminPassword },
  });
  const users = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : [];
  const exact = users.find((user) => String(user.user_email || user.email || '').trim().toLowerCase() === cleanEmail);
  return normalizeRoleValue(exact?.role_text || exact?.role || exact?.user_role || '');
}

export async function fetchOpenUserSettings(apiBase: string): Promise<OpenUserSettings> {
  return apiRequest<OpenUserSettings>(apiBase, '/user_api/open_settings');
}

export async function requestUserVerifyCode(apiBase: string, email: string): Promise<void> {
  await apiRequest(apiBase, '/user_api/verify_code', { method: 'POST', body: { email } });
}

export async function fetchUserProfile(apiBase: string, userToken: string): Promise<AccountUserProfile> {
  const raw = await apiRequest<Record<string, unknown>>(apiBase, '/user_api/settings', {
    headers: { Authorization: `Bearer ${userToken}`, 'x-user-token': userToken },
  });
  return normalizeProfile(userToken, raw || {});
}

async function loginWithPasswordAttempt(apiBase: string, email: string, password: string) {
  const raw = await apiRequest<{ jwt?: string }>(apiBase, '/user_api/login', {
    method: 'POST',
    body: { email, password },
  });
  const userToken = String(raw?.jwt || '').trim();
  if (!userToken) throw new Error('邮箱或密码错误');
  return fetchUserProfile(apiBase, userToken);
}

export async function loginAccountUser(apiBase: string, email: string, password: string) {
  const hashed = await sha256Hex(password);
  const attempts = Array.from(new Set([hashed, password]));
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      return await loginWithPasswordAttempt(apiBase, email, attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('邮箱或密码错误');
}

export async function registerAccountUser(apiBase: string, email: string, password: string, code = '') {
  const hashed = await sha256Hex(password);
  await apiRequest(apiBase, '/user_api/register', {
    method: 'POST',
    body: { email, password: hashed, code },
  });
  return loginWithPasswordAttempt(apiBase, email, hashed);
}

export async function fetchOAuthLoginUrl(apiBase: string, clientID: string, state: string) {
  const search = new URLSearchParams({ clientID, state });
  const raw = await apiRequest<{ url?: string }>(apiBase, '/user_api/oauth2/login_url', { search });
  if (!raw?.url) throw new Error('OAuth 登录地址为空');
  return raw.url;
}

export async function completeOAuthLogin(apiBase: string, code: string, clientID: string) {
  const raw = await apiRequest<{ jwt?: string }>(apiBase, '/user_api/oauth2/callback', {
    method: 'POST',
    body: { code, clientID },
  });
  const userToken = String(raw?.jwt || '').trim();
  if (!userToken) throw new Error('OAuth 登录失败');
  return fetchUserProfile(apiBase, userToken);
}

export async function fetchUserAddresses(apiBase: string, userToken: string) {
  const raw = await apiRequest<{ results?: UserAddress[] } | UserAddress[]>(apiBase, '/user_api/bind_address', {
    headers: { Authorization: `Bearer ${userToken}`, 'x-user-token': userToken },
  });
  return Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : [];
}

export async function createUserAddress(apiBase: string, userToken: string, input: { name?: string; domain?: string; enableRandomSubdomain?: boolean }) {
  const created = await apiRequest<{ jwt?: string; address?: string; address_id?: number }>(apiBase, '/api/new_address', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}`, 'x-user-token': userToken },
    body: input,
  });
  const addressJwt = String(created?.jwt || '').trim();
  if (addressJwt) {
    await apiRequest(apiBase, '/user_api/bind_address', {
      method: 'POST',
      headers: { Authorization: `Bearer ${addressJwt}`, 'x-user-token': userToken },
      body: {},
    });
  }
  return created;
}

export async function fetchAddressJwt(apiBase: string, userToken: string, addressId: number) {
  const raw = await apiRequest<{ jwt?: string }>(apiBase, `/user_api/bind_address_jwt/${encodeURIComponent(String(addressId))}`, {
    headers: { Authorization: `Bearer ${userToken}`, 'x-user-token': userToken },
  });
  const jwt = String(raw?.jwt || '').trim();
  if (!jwt) throw new Error('邮箱凭据为空');
  return jwt;
}

export async function fetchAddressSettings(apiBase: string, addressJwt: string) {
  return apiRequest<AddressSettings>(apiBase, '/api/settings', {
    headers: { Authorization: `Bearer ${addressJwt}` },
  });
}

export async function fetchAddressMails(apiBase: string, addressJwt: string, limit = 50, offset = 0) {
  const search = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const raw = await apiRequest<{ results?: AddressMail[]; count?: number } | AddressMail[]>(apiBase, '/api/mails', {
    search,
    headers: { Authorization: `Bearer ${addressJwt}` },
  });
  return Array.isArray(raw) ? { results: raw, count: raw.length } : { results: raw?.results || [], count: Number(raw?.count || 0) };
}

export async function createUserShare(
  apiBase: string,
  userToken: string,
  frontendBase: string,
  rows: UserAddress[],
  options: {
    expiresIn?: UserShareExpiry;
    mailVisibility?: UserShareMailVisibility;
    allowHideMail?: boolean;
  } = {},
): Promise<UserShareResult> {
  const base = normalizeFrontendBaseUrl(frontendBase);
  if (!base) throw new Error('请先配置用户站前端地址');
  if (!rows.length) throw new Error('请选择至少一个邮箱地址');
  const credentials = await Promise.all(rows.map(async (row) => ({
    id: String(row.id),
    address: row.name,
    jwt: await fetchAddressJwt(apiBase, userToken, row.id),
  })));
  let response: Response;
  try {
    response = await fetch(`${base}/api/share`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${userToken}`,
        'x-user-token': userToken,
      },
      body: JSON.stringify({
        addressCredentials: credentials,
        addresses: rows.map((row) => ({ id: row.id, address: row.name })),
        expiresIn: options.expiresIn || '30d',
        mailVisibility: options.mailVisibility || 'new',
        permissions: { hideMail: options.allowHideMail !== false },
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    throw new Error(`共享链接暂不可用：${base}${message ? ` ${message}` : ''}`);
  }
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || '创建共享链接失败');
  }
  const result: UserShareResult = {
    url: String(data?.url || ''),
    token: data?.token ? String(data.token) : undefined,
    expiresAt: data?.expiresAt ?? null,
    addresses: Array.isArray(data?.addresses) ? data.addresses : [],
  };
  if (!result.url) throw new Error('共享接口没有返回链接');
  return result;
}

export async function loginDirectAddress(apiBase: string, email: string, password: string) {
  const hashed = await sha256Hex(password);
  const raw = await apiRequest<{ jwt?: string; address?: string }>(apiBase, '/api/address_login', {
    method: 'POST',
    body: { email, password: hashed },
  });
  const jwt = String(raw?.jwt || '').trim();
  if (!jwt) throw new Error('邮箱或密码错误');
  const settings = await fetchAddressSettings(apiBase, jwt);
  return { jwt, address: settings.address || raw.address || email, settings };
}
