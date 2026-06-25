type KVNamespace = {
  get<T = unknown>(key: string, options?: { type?: "json" }): Promise<T | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

type MailStateEnv = {
  MAIL_READ_STATE_KV?: KVNamespace;
  MAIL_WORKER_BASE_URL?: string;
  ADMIN_PASSWORD?: string;
  SITE_PASSWORD?: string;
};

type PagesContext = {
  request: Request;
  env: MailStateEnv;
};

type MailMode = "inbox" | "unknown" | "sent";
type StoredMailState = {
  version: 1;
  readIds: string[];
  starredIds: string[];
  readAllBefore: number;
  updatedAt: number;
};

type IdentityCacheEntry = {
  identity: string;
  expiresAt: number;
};

const STATE_VERSION = 1;
const MAX_STATE_IDS = 5000;
const IDENTITY_CACHE_MS = 5 * 60 * 1000;
const identityCache = new Map<string, IdentityCacheEntry>();

const JSON_HEADERS = {
  "content-type": "application/json;charset=utf-8",
  "Cache-Control": "no-store, private, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-Content-Type-Options": "nosniff",
};

const CORS_ALLOW_HEADERS = "authorization,content-type,x-admin-auth,x-custom-auth,x-lang,x-user-access-token,x-user-token";

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...(init.headers || {}),
    },
  });
}

function jsonError(status: number, message: string, code = "mail_state_error") {
  return json({ error: { code, message } }, { status });
}

function sameOriginCorsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  if (!origin) return {};
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) return null;
  } catch {
    return null;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

export const onRequestOptions = ({ request }: PagesContext) => {
  const cors = sameOriginCorsHeaders(request);
  if (cors === null) return jsonError(403, "不允许的跨域来源。", "origin_not_allowed");
  return new Response(null, {
    status: 204,
    headers: {
      ...(cors || {}),
      "Access-Control-Allow-Methods": "GET,PATCH,OPTIONS",
      "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
      "Access-Control-Max-Age": "86400",
      ...JSON_HEADERS,
    },
  });
};

function normalizeMode(value: unknown): MailMode | null {
  return value === "inbox" || value === "unknown" || value === "sent" ? value : null;
}

function stateMode(mode: MailMode): MailMode {
  return mode === "unknown" ? "inbox" : mode;
}

function normalizeModeFromRequest(request: Request): MailMode | null {
  return normalizeMode(new URL(request.url).searchParams.get("mode"));
}

function normalizeId(mode: MailMode, value: unknown): string {
  const raw = String(value || "").trim();
  const id = raw.includes(":") ? raw.split(":").pop() || "" : raw;
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) return "";
  return `${stateMode(mode)}:${numeric}`;
}

function normalizeIds(mode: MailMode, value: unknown): string[] {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  for (const item of source) {
    const id = normalizeId(mode, item);
    if (id) seen.add(id);
  }
  return [...seen].slice(-MAX_STATE_IDS);
}

function compactIds(ids: Iterable<string>, readAllBefore = 0) {
  const seen = new Set<string>();
  for (const id of ids) {
    const numeric = Number(id.split(":").pop() || 0);
    if (readAllBefore > 0 && numeric > 0 && numeric <= readAllBefore) continue;
    if (id) seen.add(id);
  }
  return [...seen].slice(-MAX_STATE_IDS);
}

function emptyState(): StoredMailState {
  return {
    version: STATE_VERSION,
    readIds: [],
    starredIds: [],
    readAllBefore: 0,
    updatedAt: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tokenFromRequest(request: Request) {
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  return request.headers.get("x-user-token")?.trim()
    || request.headers.get("x-user-access-token")?.trim()
    || bearer
    || "";
}

function workerBase(env: MailStateEnv) {
  const base = env.MAIL_WORKER_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("missing_worker_base");
  return base;
}

async function fetchUserIdentity(env: MailStateEnv, token: string) {
  const tokenHash = await sha256(token);
  const cached = identityCache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) return cached.identity;

  const headers: Record<string, string> = {
    "x-lang": "zh",
    "x-user-token": token,
    "Authorization": `Bearer ${token}`,
  };
  if (env.SITE_PASSWORD) headers["x-custom-auth"] = env.SITE_PASSWORD;
  const response = await fetch(`${workerBase(env)}/user_api/settings`, { headers });
  if (!response.ok) throw new Error("invalid_user_token");
  const profile = asRecord(await response.json().catch(() => null));
  const user = asRecord(profile.user) || profile;
  const userId = firstString({ ...profile, ...user }, ["user_id", "userId", "id", "sub"]);
  const email = firstString({ ...profile, ...user }, ["user_email", "userEmail", "email", "mail"]).toLowerCase();
  const identity = userId
    ? `user:${userId}`
    : email
      ? `email:${email}`
      : `token:${tokenHash.slice(0, 32)}`;
  identityCache.set(tokenHash, { identity, expiresAt: Date.now() + IDENTITY_CACHE_MS });
  return identity;
}

async function resolveIdentity(context: PagesContext) {
  const token = tokenFromRequest(context.request);
  if (token) return fetchUserIdentity(context.env, token);

  const providedAdminPassword = context.request.headers.get("x-admin-auth")?.trim() || "";
  const configuredAdminPassword = context.env.ADMIN_PASSWORD?.trim() || "";
  if (providedAdminPassword && configuredAdminPassword && providedAdminPassword === configuredAdminPassword) {
    return `admin:${(await sha256(configuredAdminPassword)).slice(0, 32)}`;
  }
  throw new Error("unauthorized");
}

function stateKey(identity: string, mode: MailMode) {
  return `mail-state:v1:${identity}:${mode}`;
}

async function readState(kv: KVNamespace, key: string, mode: MailMode): Promise<StoredMailState> {
  const raw = await kv.get<Partial<StoredMailState>>(key, { type: "json" }).catch(() => null);
  if (!raw || typeof raw !== "object") return emptyState();
  const readAllBefore = Math.max(0, Number(raw.readAllBefore || 0) || 0);
  return {
    version: STATE_VERSION,
    readIds: compactIds(normalizeIds(mode, raw.readIds), readAllBefore),
    starredIds: compactIds(normalizeIds(mode, raw.starredIds), 0),
    readAllBefore,
    updatedAt: Math.max(0, Number(raw.updatedAt || 0) || 0),
  };
}

function mergeStates(mode: MailMode, states: StoredMailState[]): StoredMailState {
  const readAllBefore = Math.max(0, ...states.map((state) => Number(state.readAllBefore || 0) || 0));
  return {
    version: STATE_VERSION,
    readIds: compactIds(states.flatMap((state) => normalizeIds(mode, state.readIds)), readAllBefore),
    starredIds: compactIds(states.flatMap((state) => normalizeIds(mode, state.starredIds)), 0),
    readAllBefore,
    updatedAt: Math.max(0, ...states.map((state) => Number(state.updatedAt || 0) || 0)),
  };
}

async function readMergedState(kv: KVNamespace, identity: string, mode: MailMode): Promise<StoredMailState> {
  const canonicalMode = stateMode(mode);
  if (canonicalMode !== "inbox") {
    return readState(kv, stateKey(identity, canonicalMode), canonicalMode);
  }
  const [inboxState, legacyUnknownState] = await Promise.all([
    readState(kv, stateKey(identity, "inbox"), "inbox"),
    readState(kv, stateKey(identity, "unknown"), "unknown"),
  ]);
  return mergeStates(canonicalMode, [inboxState, legacyUnknownState]);
}

function responseState(mode: MailMode, state: StoredMailState) {
  const canonicalMode = stateMode(mode);
  return {
    mode,
    readIds: state.readIds,
    starredIds: state.starredIds,
    readAllBefore: canonicalMode === mode
      ? { [mode]: state.readAllBefore }
      : { [canonicalMode]: state.readAllBefore, [mode]: state.readAllBefore },
    updatedAt: state.updatedAt,
  };
}

export async function onRequestGet(context: PagesContext) {
  const mode = normalizeModeFromRequest(context.request);
  if (!mode) return jsonError(400, "邮件状态 mode 无效。", "invalid_mode");
  const kv = context.env.MAIL_READ_STATE_KV;
  if (!kv) return jsonError(503, "邮件已读状态存储未绑定。", "missing_kv_binding");

  try {
    const identity = await resolveIdentity(context);
    const state = await readMergedState(kv, identity, mode);
    return json(responseState(mode, state));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "unauthorized" || message === "invalid_user_token") return jsonError(401, "请先登录后再同步邮件状态。", "unauthorized");
    if (message === "missing_worker_base") return jsonError(500, "邮件状态接口缺少 Worker 地址配置。", "missing_worker_base");
    return jsonError(500, "邮件状态读取失败。", "read_failed");
  }
}

export async function onRequestPatch(context: PagesContext) {
  const kv = context.env.MAIL_READ_STATE_KV;
  if (!kv) return jsonError(503, "邮件已读状态存储未绑定。", "missing_kv_binding");

  const body = asRecord(await context.request.json().catch(() => null));
  const mode = normalizeMode(body.mode);
  if (!mode) return jsonError(400, "邮件状态 mode 无效。", "invalid_mode");

  try {
    const identity = await resolveIdentity(context);
    const canonicalMode = stateMode(mode);
    const key = stateKey(identity, canonicalMode);
    const current = await readMergedState(kv, identity, mode);
    const readAllBeforeInput = asRecord(body.readAllBefore);
    const nextReadAllBefore = Math.max(
      current.readAllBefore,
      Number(body.readAllBefore || 0) || 0,
      Number(readAllBeforeInput[mode] || 0) || 0,
      Number(readAllBeforeInput[canonicalMode] || 0) || 0,
    );

    const readIds = compactIds([
      ...current.readIds,
      ...normalizeIds(canonicalMode, body.readIds),
      ...normalizeIds(canonicalMode, body.readIdsToAdd),
    ], nextReadAllBefore);

    const starred = new Set(compactIds([
      ...current.starredIds,
      ...normalizeIds(canonicalMode, body.starredIds),
      ...normalizeIds(canonicalMode, body.starredIdsToAdd),
    ], 0));
    for (const id of normalizeIds(canonicalMode, body.starredIdsToRemove)) starred.delete(id);

    const next: StoredMailState = {
      version: STATE_VERSION,
      readIds,
      starredIds: [...starred].slice(-MAX_STATE_IDS),
      readAllBefore: nextReadAllBefore,
      updatedAt: Date.now(),
    };
    await kv.put(key, JSON.stringify(next));
    return json(responseState(mode, next));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "unauthorized" || message === "invalid_user_token") return jsonError(401, "请先登录后再同步邮件状态。", "unauthorized");
    if (message === "missing_worker_base") return jsonError(500, "邮件状态接口缺少 Worker 地址配置。", "missing_worker_base");
    return jsonError(500, "邮件状态保存失败。", "write_failed");
  }
}
