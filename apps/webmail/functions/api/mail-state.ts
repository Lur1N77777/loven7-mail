import { decodeJwtAddress, errorJson, extractJwt, fetchWorkerJson, json, mapUpstreamError, sanitizeSettings } from "../_lib/http";
import type { CloudmailEnv, PagesHandler } from "../_lib/types";

type MailStateKv = NonNullable<CloudmailEnv["MAIL_READ_STATE_KV"] | CloudmailEnv["SHARE_KV"]>;

type StoredMailState = {
  version: 1;
  readIds: string[];
  starredIds: string[];
  readAllBefore: number;
  updatedAt: number;
};

const STATE_VERSION = 1;
const MAX_STATE_IDS = 5000;
const STATE_MODE = "inbox";
const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type,x-user-token,x-user-access-token",
  "Access-Control-Max-Age": "86400",
};

function stateKv(env: CloudmailEnv): MailStateKv | null {
  return env.MAIL_READ_STATE_KV || env.SHARE_KV || null;
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeId(value: unknown): string {
  const raw = String(value || "").trim();
  const id = raw.includes(":") ? raw.split(":").pop() || "" : raw;
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) return "";
  return `${STATE_MODE}:${numeric}`;
}

function normalizeIds(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  for (const item of source) {
    const id = normalizeId(item);
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

async function resolveIdentity(env: CloudmailEnv, jwt: string) {
  const fallbackAddress = decodeJwtAddress(jwt).trim().toLowerCase();
  try {
    const raw = await fetchWorkerJson<unknown>(env, "/api/settings", { jwt });
    const settings = sanitizeSettings(raw, fallbackAddress);
    const address = String(settings.address || fallbackAddress || "").trim().toLowerCase();
    if (address) return `email:${address}`;
  } catch {
    if (fallbackAddress) return `email:${fallbackAddress}`;
  }
  return `token:${(await sha256Hex(jwt)).slice(0, 32)}`;
}

function stateKey(identity: string) {
  return `mail-state:v1:${identity}:${STATE_MODE}`;
}

async function readState(kv: MailStateKv, key: string): Promise<StoredMailState> {
  const rawText = await kv.get(key).catch(() => null);
  if (!rawText) return emptyState();
  const raw = asRecord(JSON.parse(rawText || "{}"));
  const readAllBefore = Math.max(0, Number(raw.readAllBefore || 0) || 0);
  return {
    version: STATE_VERSION,
    readIds: compactIds(normalizeIds(raw.readIds), readAllBefore),
    starredIds: compactIds(normalizeIds(raw.starredIds), 0),
    readAllBefore,
    updatedAt: Math.max(0, Number(raw.updatedAt || 0) || 0),
  };
}

function responseState(state: StoredMailState) {
  return {
    mode: STATE_MODE,
    readIds: state.readIds,
    starredIds: state.starredIds,
    readAllBefore: { [STATE_MODE]: state.readAllBefore, unknown: state.readAllBefore },
    updatedAt: state.updatedAt,
  };
}

export const onRequestOptions: PagesHandler = () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  const kv = stateKv(env);
  if (!kv) return errorJson(503, "邮件已读状态存储未绑定", "mail_state_kv_not_configured");

  try {
    const jwt = extractJwt(request);
    if (!jwt) return errorJson(401, "请先登录后再同步邮件状态", "missing_jwt");
    const identity = await resolveIdentity(env, jwt);
    const state = await readState(kv, stateKey(identity));
    return json(responseState(state));
  } catch (error) {
    return mapUpstreamError(error);
  }
};

export const onRequestPatch: PagesHandler = async ({ request, env }) => {
  const kv = stateKv(env);
  if (!kv) return errorJson(503, "邮件已读状态存储未绑定", "mail_state_kv_not_configured");

  try {
    const jwt = extractJwt(request);
    if (!jwt) return errorJson(401, "请先登录后再同步邮件状态", "missing_jwt");
    const body = asRecord(await request.json().catch(() => null));
    const identity = await resolveIdentity(env, jwt);
    const key = stateKey(identity);
    const current = await readState(kv, key);
    const readAllBeforeInput = asRecord(body.readAllBefore);
    const nextReadAllBefore = Math.max(
      current.readAllBefore,
      Number(body.readAllBefore || 0) || 0,
      Number(readAllBeforeInput[STATE_MODE] || 0) || 0,
      Number(readAllBeforeInput.unknown || 0) || 0,
    );
    const next: StoredMailState = {
      version: STATE_VERSION,
      readIds: compactIds([
        ...current.readIds,
        ...normalizeIds(body.readIds),
        ...normalizeIds(body.readIdsToAdd),
      ], nextReadAllBefore),
      starredIds: current.starredIds,
      readAllBefore: nextReadAllBefore,
      updatedAt: Date.now(),
    };
    await kv.put(key, JSON.stringify(next));
    return json(responseState(next));
  } catch (error) {
    return mapUpstreamError(error);
  }
};
