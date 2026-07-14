import { errorJson, extractJwt, fetchWorkerJson, getWorkerBaseUrl, json, mapUpstreamError, sanitizeSettings, UpstreamError } from "../_lib/http";
import type { CloudmailEnv, PagesHandler } from "../_lib/types";

type MailStateKv = NonNullable<CloudmailEnv["MAIL_READ_STATE_KV"] | CloudmailEnv["SHARE_KV"]>;

type StoredMailState = {
  version: 1;
  readIds: string[];
  starredIds: string[];
  readAllBefore: number;
  updatedAt: number;
  compactedThrough: string;
};

type MailStateOperation = {
  version: 2;
  createdAt: number;
  readIdsToAdd: string[];
  readIdsToRemove: string[];
  starredIdsToAdd: string[];
  starredIdsToRemove: string[];
  readAllBefore: number;
};

const STATE_VERSION = 1;
const MAX_STATE_IDS = 5000;
const STATE_MODE = "inbox";
const OPERATION_VERSION = 2;
const OPERATION_TTL_SECONDS = 365 * 24 * 60 * 60;
const OPERATION_COMPACTION_GRACE_MS = 5 * 60 * 1000;
const MAX_COMPACTION_OPERATIONS = 128;
const MAX_OPERATION_DELETES = 256;
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
    compactedThrough: "",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function resolveIdentity(env: CloudmailEnv, jwt: string) {
  // /api/settings is the signature-verification boundary. Never derive an
  // identity from the unverified JWT payload when the Worker rejects it.
  const raw = await fetchWorkerJson<unknown>(env, "/api/settings", { jwt });
  const settings = sanitizeSettings(raw);
  const address = String(settings.address || "").trim().toLowerCase();
  if (!address) throw new UpstreamError(401, "", "Verified credential has no mailbox identity");

  // The same KV namespace may be bound to preview/production or to multiple
  // Workers. Scope every identity to the configured Worker to prevent a
  // same-address collision across tenants.
  const workerScope = (await sha256Hex(`worker:${getWorkerBaseUrl(env).toLowerCase()}`)).slice(0, 24);
  return `tenant:${workerScope}:email:${address}`;
}

function stateKey(identity: string) {
  return `mail-state:v1:${identity}:${STATE_MODE}`;
}

function operationPrefix(identity: string) {
  return `mail-state-op:v2:${identity}:${STATE_MODE}:`;
}

function operationKey(identity: string, createdAt: number) {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : Array.from(crypto.getRandomValues(new Uint8Array(16))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${operationPrefix(identity)}${String(createdAt).padStart(13, "0")}:${random}`;
}

function operationCreatedAtFromKey(key: string, prefix: string) {
  if (!key.startsWith(prefix)) return 0;
  const match = /^(\d{13}):.+$/.exec(key.slice(prefix.length));
  return match ? Math.max(0, Number(match[1]) || 0) : 0;
}

function normalizeCompactedThrough(value: unknown, prefix: string) {
  const key = typeof value === "string" ? value.trim() : "";
  return operationCreatedAtFromKey(key, prefix) > 0 ? key : "";
}

async function readState(kv: MailStateKv, key: string, prefix: string): Promise<StoredMailState> {
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
    compactedThrough: normalizeCompactedThrough(raw.compactedThrough, prefix),
  };
}

async function readOperations(kv: MailStateKv, identity: string, compactedThrough: string) {
  const prefix = operationPrefix(identity);
  const observedKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    observedKeys.push(...page.keys.map((item) => item.name));
    cursor = page.list_complete ? undefined : page.cursor || undefined;
  } while (cursor);
  observedKeys.sort((left, right) => left.localeCompare(right));

  // KV list/read propagation is eventually consistent. Only advance across an
  // old, contiguous prefix so a same-millisecond sibling still converging at
  // another edge cannot fall behind the watermark.
  const compactableKeys: string[] = [];
  const compactBefore = Date.now() - OPERATION_COMPACTION_GRACE_MS;
  for (const key of observedKeys) {
    if (compactedThrough && key <= compactedThrough) continue;
    const createdAt = operationCreatedAtFromKey(key, prefix);
    if (!createdAt || createdAt > compactBefore) break;
    compactableKeys.push(key);
    if (compactableKeys.length >= MAX_COMPACTION_OPERATIONS) break;
  }
  const nextCompactedThrough = compactableKeys.at(-1) || compactedThrough;
  const compactableOperations: Array<{ key: string; value: MailStateOperation }> = [];
  const tailOperations: Array<{ key: string; value: MailStateOperation }> = [];

  for (const key of observedKeys) {
    if (compactedThrough && key <= compactedThrough) continue;
    const raw = await kv.get(key).catch(() => null);
    if (!raw) continue;
    try {
      const value = JSON.parse(raw) as Partial<MailStateOperation>;
      if (value.version !== OPERATION_VERSION) continue;
      const operation = {
        key,
        value: {
          version: OPERATION_VERSION,
          createdAt: Math.max(0, Number(value.createdAt) || 0),
          readIdsToAdd: normalizeIds(value.readIdsToAdd),
          readIdsToRemove: normalizeIds(value.readIdsToRemove),
          starredIdsToAdd: normalizeIds(value.starredIdsToAdd),
          starredIdsToRemove: normalizeIds(value.starredIdsToRemove),
          readAllBefore: Math.max(0, Number(value.readAllBefore) || 0),
        },
      } satisfies { key: string; value: MailStateOperation };
      if (nextCompactedThrough && key <= nextCompactedThrough) compactableOperations.push(operation);
      else tailOperations.push(operation);
    } catch {
      // An old malformed event is covered by the observed watermark; a recent
      // malformed event remains isolated until it ages out or expires.
    }
  }

  const deleteThrough = nextCompactedThrough || compactedThrough;
  const deleteKeys = deleteThrough
    ? observedKeys.filter((key) => key <= deleteThrough).slice(0, MAX_OPERATION_DELETES)
    : [];
  return {
    compactableOperations,
    tailOperations,
    nextCompactedThrough,
    deleteKeys,
  };
}

function applyOperations(snapshot: StoredMailState, operations: Array<{ value: MailStateOperation }>) {
  const read = new Set(snapshot.readIds);
  const starred = new Set(snapshot.starredIds);
  let readAllBefore = snapshot.readAllBefore;
  let updatedAt = snapshot.updatedAt;
  for (const { value } of operations) {
    for (const id of value.readIdsToAdd) read.add(id);
    for (const id of value.readIdsToRemove) read.delete(id);
    for (const id of value.starredIdsToAdd) starred.add(id);
    for (const id of value.starredIdsToRemove) starred.delete(id);
    readAllBefore = Math.max(readAllBefore, value.readAllBefore);
    updatedAt = Math.max(updatedAt, value.createdAt);
  }
  return {
    version: STATE_VERSION,
    readIds: compactIds(read, readAllBefore),
    starredIds: compactIds(starred, 0),
    readAllBefore,
    updatedAt,
    compactedThrough: snapshot.compactedThrough,
  } satisfies StoredMailState;
}

async function deleteObservedOperations(kv: MailStateKv, keys: string[]) {
  for (let offset = 0; offset < keys.length; offset += 32) {
    await Promise.all(keys.slice(offset, offset + 32).map((key) => kv.delete(key).catch(() => undefined)));
  }
}

async function readMergedState(kv: MailStateKv, identity: string) {
  const key = stateKey(identity);
  const prefix = operationPrefix(identity);
  const snapshot = await readState(kv, key, prefix);
  const operations = await readOperations(kv, identity, snapshot.compactedThrough);
  const compactedSnapshot = applyOperations(snapshot, operations.compactableOperations);
  compactedSnapshot.compactedThrough = operations.nextCompactedThrough;
  const response = applyOperations(compactedSnapshot, operations.tailOperations);
  const shouldPersist = operations.nextCompactedThrough !== snapshot.compactedThrough || operations.deleteKeys.length > 0;
  if (shouldPersist) {
    try {
      await kv.put(key, JSON.stringify(compactedSnapshot));
      await deleteObservedOperations(kv, operations.deleteKeys);
    } catch {
      // A snapshot failure must never be followed by event deletion.
    }
  }
  return response;
}

function operationFromBody(body: Record<string, unknown>, createdAt: number): MailStateOperation {
  const readAllBeforeInput = asRecord(body.readAllBefore);
  return {
    version: OPERATION_VERSION,
    createdAt,
    readIdsToAdd: normalizeIds([...(Array.isArray(body.readIds) ? body.readIds : []), ...(Array.isArray(body.readIdsToAdd) ? body.readIdsToAdd : [])]),
    readIdsToRemove: normalizeIds(body.readIdsToRemove),
    starredIdsToAdd: normalizeIds([...(Array.isArray(body.starredIds) ? body.starredIds : []), ...(Array.isArray(body.starredIdsToAdd) ? body.starredIdsToAdd : [])]),
    starredIdsToRemove: normalizeIds(body.starredIdsToRemove),
    readAllBefore: Math.max(
      0,
      Number(body.readAllBefore || 0) || 0,
      Number(readAllBeforeInput[STATE_MODE] || 0) || 0,
      Number(readAllBeforeInput.unknown || 0) || 0,
    ),
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
    const state = await readMergedState(kv, identity);
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
    const createdAt = Date.now();
    const operation = operationFromBody(body, createdAt);
    await kv.put(operationKey(identity, createdAt), JSON.stringify(operation), { expirationTtl: OPERATION_TTL_SECONDS });
    const next = await readMergedState(kv, identity);
    return json(responseState(next));
  } catch (error) {
    return mapUpstreamError(error);
  }
};
