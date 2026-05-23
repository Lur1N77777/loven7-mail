import { decodeJwtAddress, errorJson, fetchAdminWorkerJson, fetchWorkerJson, normalizeMailPage, sanitizeSettings, UpstreamError } from "./http";
import type { CloudmailEnv } from "./types";

export type ShareStatus = "active" | "expired" | "revoked";
export type ShareMailVisibility = "new" | "all";

export type SharePermissions = {
  hideMail: boolean;
};

export type ShareMailbox = {
  id: string;
  address: string;
  jwt: string;
  sinceMailId?: number;
  sinceCreatedAt?: string | null;
  hiddenMailIds?: number[];
};

export type SharePayload = {
  version: 2;
  token?: string;
  createdAt: string;
  updatedAt?: string;
  expiresAt: string | null;
  revokedAt?: string | null;
  mailVisibility: ShareMailVisibility;
  permissions: SharePermissions;
  addresses: ShareMailbox[];
};

export type PublicShareMailbox = {
  id: string;
  address: string;
};

export type ShareAdminSummary = {
  token: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  status: ShareStatus;
  addressCount: number;
  hiddenAddressCount: number;
  hiddenMailCount: number;
  mailVisibility: ShareMailVisibility;
  permissions: SharePermissions;
  addresses: PublicShareMailbox[];
};

type StoredShareSummary = Omit<ShareAdminSummary, "url" | "status">;

export type ShareListOptions = {
  limit: number;
  cursor?: string;
  status?: string;
  query?: string;
  request: Request;
};

const SHARE_PREFIX = "share:";
const SHARE_SUMMARY_PREFIX = "share-summary:";
const TOKEN_BYTES = 18;
const MAX_LIST_SCAN_PAGES = 8;
const DEFAULT_PERMISSIONS: SharePermissions = { hideMail: true };

function base64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function normalizeIso(value: unknown, fallback: string | null): string | null {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return fallback;
  return new Date(time).toISOString();
}

function normalizeMailVisibility(value: unknown, fallback: ShareMailVisibility = "all"): ShareMailVisibility {
  return value === "new" || value === "all" ? value : fallback;
}

export function normalizeSharePermissions(value: unknown, fallback: SharePermissions = DEFAULT_PERMISSIONS): SharePermissions {
  const src = value && typeof value === "object" ? value as Partial<SharePermissions> : {};
  return {
    hideMail: typeof src.hideMail === "boolean" ? src.hideMail : fallback.hideMail,
  };
}

function normalizeNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => Number.parseInt(String(item), 10)).filter((item) => Number.isFinite(item) && item > 0))].slice(0, 1000);
}

function normalizeSharePayload(payload: Partial<SharePayload> | null, token: string): SharePayload | null {
  if (!payload || !Array.isArray(payload.addresses)) return null;
  const addresses = payload.addresses
    .map((item) => ({
      id: String(item?.id || "").trim(),
      address: String(item?.address || "").trim(),
      jwt: String(item?.jwt || "").trim(),
      sinceMailId: Number.isFinite(Number(item?.sinceMailId)) ? Math.max(0, Number(item?.sinceMailId)) : undefined,
      sinceCreatedAt: normalizeIso(item?.sinceCreatedAt, null),
      hiddenMailIds: normalizeNumberList(item?.hiddenMailIds),
    }))
    .filter((item) => item.id && item.address && item.jwt);
  if (addresses.length === 0) return null;
  const now = new Date().toISOString();
  const createdAt = normalizeIso(payload.createdAt, now) || now;
  const legacyVisibility = (payload as { mailVisibility?: unknown }).mailVisibility;
  return {
    version: 2,
    token,
    createdAt,
    updatedAt: normalizeIso(payload.updatedAt, createdAt) || createdAt,
    expiresAt: normalizeIso(payload.expiresAt, null),
    revokedAt: normalizeIso(payload.revokedAt, null),
    mailVisibility: normalizeMailVisibility(legacyVisibility, "all"),
    permissions: normalizeSharePermissions((payload as { permissions?: unknown }).permissions, DEFAULT_PERMISSIONS),
    addresses,
  };
}

async function importShareKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`loven7-mail-share:${secret}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function requireShareEnv(env: CloudmailEnv) {
  if (!env.SHARE_KV) throw new UpstreamError(500, "", "SHARE_KV is not configured");
  if (!env.SHARE_ENCRYPTION_SECRET?.trim()) throw new UpstreamError(500, "", "SHARE_ENCRYPTION_SECRET is not configured");
  return { kv: env.SHARE_KV, secret: env.SHARE_ENCRYPTION_SECRET.trim() };
}

export function parseShareTtl(value: unknown): { label: string; expiresAt: string | null; ttlSeconds?: number } {
  const key = String(value || "30d").trim().toLowerCase();
  const days = key === "1d" ? 1 : key === "7d" ? 7 : key === "30d" ? 30 : key === "forever" || key === "never" ? 0 : 30;
  if (days <= 0) return { label: "永久", expiresAt: null };
  const ttlSeconds = days * 24 * 60 * 60;
  return { label: `${days}天`, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(), ttlSeconds };
}

export function newShareToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sealPayload(payload: SharePayload, secret: string) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await importShareKey(secret);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return JSON.stringify({ v: 1, iv: base64Url(iv), data: base64Url(encrypted) });
}

async function openPayload(value: string, secret: string, token: string): Promise<SharePayload | null> {
  try {
    const sealed = JSON.parse(value) as { v?: number; iv?: string; data?: string };
    if (sealed.v !== 1 || !sealed.iv || !sealed.data) return null;
    const key = await importShareKey(secret);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(sealed.iv) }, key, fromBase64Url(sealed.data));
    const payload = JSON.parse(new TextDecoder().decode(decrypted)) as Record<string, unknown>;
    if (payload.version !== 1 && payload.version !== 2) return null;
    return normalizeSharePayload(payload as Partial<SharePayload>, token);
  } catch {
    return null;
  }
}

export function shareStatus(payload: Pick<SharePayload, "expiresAt" | "revokedAt">, now = Date.now()): ShareStatus {
  if (payload.revokedAt) return "revoked";
  if (payload.expiresAt && Date.parse(payload.expiresAt) <= now) return "expired";
  return "active";
}

function publicAddresses(payload: SharePayload) {
  return payload.addresses.map(({ id, address }) => ({ id, address }));
}

function summaryFromPayload(token: string, payload: SharePayload): StoredShareSummary {
  const hiddenMailCount = payload.addresses.reduce((sum, item) => sum + (item.hiddenMailIds?.length || 0), 0);
  return {
    token,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt || payload.createdAt,
    expiresAt: payload.expiresAt,
    revokedAt: payload.revokedAt || null,
    addressCount: publicAddresses(payload).length,
    hiddenAddressCount: 0,
    hiddenMailCount,
    mailVisibility: payload.mailVisibility,
    permissions: payload.permissions,
    addresses: publicAddresses(payload),
  };
}

function adminShareFromSummary(request: Request, summary: StoredShareSummary): ShareAdminSummary {
  return {
    ...summary,
    url: shareUrlFromRequest(request, summary.token),
    status: shareStatus(summary),
  };
}

async function saveShareSummary(env: CloudmailEnv, token: string, payload: SharePayload) {
  const { kv } = requireShareEnv(env);
  await kv.put(`${SHARE_SUMMARY_PREFIX}${token}`, JSON.stringify(summaryFromPayload(token, payload)));
}

function normalizeStoredSummary(raw: unknown, token: string): StoredShareSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Partial<StoredShareSummary>;
  const addresses = Array.isArray(src.addresses)
    ? src.addresses.map((item) => ({ id: String(item?.id || ""), address: String(item?.address || "") })).filter((item) => item.id && item.address)
    : [];
  const createdAt = normalizeIso(src.createdAt, null);
  if (!createdAt) return null;
  return {
    token,
    createdAt,
    updatedAt: normalizeIso(src.updatedAt, createdAt) || createdAt,
    expiresAt: normalizeIso(src.expiresAt, null),
    revokedAt: normalizeIso(src.revokedAt, null),
    addressCount: Number.isFinite(Number(src.addressCount)) ? Number(src.addressCount) : addresses.length,
    hiddenAddressCount: 0,
    hiddenMailCount: Number.isFinite(Number(src.hiddenMailCount)) ? Number(src.hiddenMailCount) : 0,
    mailVisibility: normalizeMailVisibility(src.mailVisibility, "all"),
    permissions: normalizeSharePermissions(src.permissions, DEFAULT_PERMISSIONS),
    addresses,
  };
}

async function readShareSummary(env: CloudmailEnv, token: string): Promise<StoredShareSummary | null> {
  const { kv } = requireShareEnv(env);
  const raw = await kv.get(`${SHARE_SUMMARY_PREFIX}${token}`);
  if (!raw) return null;
  try {
    return normalizeStoredSummary(JSON.parse(raw), token);
  } catch {
    return null;
  }
}

export async function saveShare(env: CloudmailEnv, token: string, payload: SharePayload) {
  const { kv, secret } = requireShareEnv(env);
  const normalized = normalizeSharePayload({ ...payload, token }, token);
  if (!normalized) throw new UpstreamError(500, "", "共享记录格式无效");
  await kv.put(`${SHARE_PREFIX}${token}`, await sealPayload(normalized, secret));
  await saveShareSummary(env, token, normalized).catch(() => undefined);
}

export async function readShareRecord(env: CloudmailEnv, token: string): Promise<SharePayload | null> {
  const { kv, secret } = requireShareEnv(env);
  if (!/^[A-Za-z0-9_-]{12,96}$/.test(token)) return null;
  const raw = await kv.get(`${SHARE_PREFIX}${token}`);
  if (!raw) return null;
  const payload = await openPayload(raw, secret, token);
  if (payload) void saveShareSummary(env, token, payload);
  return payload;
}

export async function readShare(env: CloudmailEnv, token: string): Promise<SharePayload | null> {
  const payload = await readShareRecord(env, token);
  if (!payload) return null;
  return shareStatus(payload) === "active" ? payload : null;
}

export async function updateShareRecord(env: CloudmailEnv, token: string, updater: (payload: SharePayload) => SharePayload): Promise<SharePayload | null> {
  const current = await readShareRecord(env, token);
  if (!current) return null;
  const next = normalizeSharePayload(updater(current), token);
  if (!next) throw new UpstreamError(500, "", "共享记录更新后格式无效");
  await saveShare(env, token, next);
  return next;
}

export async function revokeShare(env: CloudmailEnv, token: string): Promise<SharePayload | null> {
  return updateShareRecord(env, token, (payload) => ({
    ...payload,
    revokedAt: payload.revokedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
}

export function publicShare(token: string, payload: SharePayload) {
  return {
    ok: true,
    token,
    expiresAt: payload.expiresAt,
    mailVisibility: payload.mailVisibility,
    permissions: payload.permissions,
    addresses: publicAddresses(payload),
  };
}

export function adminShare(request: Request, token: string, payload: SharePayload): ShareAdminSummary {
  return adminShareFromSummary(request, summaryFromPayload(token, payload));
}

function summaryMatches(summary: ShareAdminSummary, status: string, query: string) {
  if (status && summary.status !== status) return false;
  if (!query) return true;
  const haystack = `${summary.token} ${summary.url} ${summary.mailVisibility} ${summary.addresses.map((item) => item.address).join(" ")}`.toLowerCase();
  return haystack.includes(query);
}

export async function listShareRecords(env: CloudmailEnv, options: ShareListOptions) {
  const { kv } = requireShareEnv(env);
  const limit = Math.min(100, Math.max(1, options.limit || 20));
  const normalizedStatus = ["active", "expired", "revoked"].includes(String(options.status)) ? String(options.status) : "";
  const normalizedQuery = String(options.query || "").trim().toLowerCase();
  const results = new Map<string, ShareAdminSummary>();
  let cursor = options.cursor || undefined;
  let complete = false;
  let scannedPages = 0;

  while (results.size < limit && !complete && scannedPages < MAX_LIST_SCAN_PAGES) {
    scannedPages += 1;
    const page = await kv.list({ prefix: SHARE_SUMMARY_PREFIX, cursor, limit: 100 });
    cursor = page.cursor || undefined;
    complete = Boolean(page.list_complete);
    for (const key of page.keys) {
      const token = key.name.slice(SHARE_SUMMARY_PREFIX.length);
      const summary = await readShareSummary(env, token).catch(() => null);
      if (!summary) continue;
      const admin = adminShareFromSummary(options.request, summary);
      if (!summaryMatches(admin, normalizedStatus, normalizedQuery)) continue;
      results.set(token, admin);
      if (results.size >= limit) break;
    }
    if (!cursor) complete = true;
  }

  if (results.size < limit) {
    let legacyCursor: string | undefined;
    let legacyComplete = false;
    let legacyPages = 0;
    while (results.size < limit && !legacyComplete && legacyPages < MAX_LIST_SCAN_PAGES) {
      legacyPages += 1;
      const page = await kv.list({ prefix: SHARE_PREFIX, cursor: legacyCursor, limit: 80 });
      legacyCursor = page.cursor || undefined;
      legacyComplete = Boolean(page.list_complete);
      for (const key of page.keys) {
        const token = key.name.slice(SHARE_PREFIX.length);
        if (results.has(token)) continue;
        const payload = await readShareRecord(env, token).catch(() => null);
        if (!payload) continue;
        const summary = adminShare(options.request, token, payload);
        if (!summaryMatches(summary, normalizedStatus, normalizedQuery)) continue;
        results.set(token, summary);
        if (results.size >= limit) break;
      }
      if (!legacyCursor) legacyComplete = true;
    }
  }

  const sorted = Array.from(results.values()).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return {
    results: sorted.slice(0, limit),
    cursor: complete ? null : cursor || null,
    hasMore: !complete && Boolean(cursor),
  };
}

export async function assertShareAdmin(request: Request, env: CloudmailEnv) {
  const adminPassword = request.headers.get("x-admin-auth")?.trim() || "";
  if (!adminPassword) throw new UpstreamError(401, "", "缺少管理员凭证");
  const requestSitePassword = request.headers.get("x-custom-auth")?.trim() || "";
  const workerEnv = requestSitePassword && !env.SITE_PASSWORD ? { ...env, SITE_PASSWORD: requestSitePassword } : env;
  await fetchAdminWorkerJson<unknown>(workerEnv, "/admin/statistics", adminPassword, { search: new URLSearchParams() });
  return { adminPassword, workerEnv };
}

export async function resolveSharedMailbox(env: CloudmailEnv, token: string, mailboxId: string) {
  const share = await readShare(env, token);
  if (!share) return null;
  const mailbox = share.addresses.find((item) => item.id === mailboxId) || share.addresses[0];
  if (!mailbox) return null;
  if (mailboxId && mailbox.id !== mailboxId) return null;
  return { share, mailbox };
}

export function filterSharedMailPage(raw: unknown, mailbox: ShareMailbox, share: SharePayload) {
  const page = normalizeMailPage(raw);
  const hidden = new Set((mailbox.hiddenMailIds || []).map(Number));
  const sinceMailId = Number(mailbox.sinceMailId || 0);
  const sinceTime = mailbox.sinceCreatedAt ? Date.parse(mailbox.sinceCreatedAt) : 0;
  const results = page.results.filter((item: any) => {
    const id = Number(item?.id || 0);
    if (hidden.has(id)) return false;
    if (share.mailVisibility !== "new") return true;
    if (sinceMailId > 0) return id > sinceMailId;
    if (sinceTime > 0) {
      const itemTime = Date.parse(String(item?.created_at || ""));
      return Number.isFinite(itemTime) && itemTime > sinceTime;
    }
    return true;
  });
  return { results, count: share.mailVisibility === "new" ? results.length : Math.max(results.length, page.count) };
}

export async function validateJwtAddress(env: CloudmailEnv, jwt: string, fallback = "") {
  const fallbackAddress = fallback || decodeJwtAddress(jwt);
  const settingsRaw = await fetchWorkerJson<unknown>(env, "/api/settings", { jwt });
  const settings = sanitizeSettings(settingsRaw, fallbackAddress);
  return settings.address || fallbackAddress;
}

export async function getLatestMailCutoff(env: CloudmailEnv, jwt: string) {
  try {
    const search = new URLSearchParams({ limit: "1", offset: "0" });
    const raw = await fetchWorkerJson<unknown>(env, "/api/mails", { jwt, search });
    const page = normalizeMailPage(raw);
    const first = page.results[0] as { id?: unknown; created_at?: unknown } | undefined;
    return {
      sinceMailId: Number.isFinite(Number(first?.id)) ? Number(first?.id) : 0,
      sinceCreatedAt: typeof first?.created_at === "string" ? first.created_at : new Date().toISOString(),
    };
  } catch {
    return { sinceMailId: 0, sinceCreatedAt: new Date().toISOString() };
  }
}

export function shareInactiveError(status: ShareStatus) {
  if (status === "revoked") return errorJson(410, "共享链接已撤销", "share_revoked");
  if (status === "expired") return errorJson(410, "共享链接已失效", "share_expired");
  return errorJson(404, "共享链接不存在", "share_not_found");
}

export function shareError(error: unknown) {
  if (error instanceof UpstreamError) {
    if (error.status === 401 && error.message === "缺少管理员凭证") return errorJson(401, "缺少管理员凭证", "missing_admin_auth");
    if (error.status === 401 || error.status === 403) return errorJson(401, "管理员凭证无效", "invalid_admin_auth");
    if (error.status === 500) return errorJson(500, error.message, "share_not_configured");
  }
  return errorJson(500, "共享链接处理失败", "share_failed");
}

export function shareUrlFromRequest(request: Request, token: string) {
  const url = new URL(request.url);
  return `${url.origin}/s/${encodeURIComponent(token)}`;
}
