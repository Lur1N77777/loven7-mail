import type { CloudmailEnv } from "./types";

export class UpstreamError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string, message = "Upstream request failed") {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export type RuntimeConfigErrorCode =
  | "mail_worker_not_configured"
  | "share_kv_not_configured"
  | "share_secret_not_configured";

const RUNTIME_CONFIG_MESSAGES: Record<RuntimeConfigErrorCode, string> = {
  mail_worker_not_configured: "邮箱 API 未配置。请在 Cloudflare Pages 环境变量中填写 MAIL_WORKER_BASE_URL 后重新部署。",
  share_kv_not_configured: "共享功能未完成配置。请在 Cloudflare Pages 为 Webmail 绑定 SHARE_KV 后重新部署。",
  share_secret_not_configured: "共享功能未完成配置。请在 Cloudflare Pages 设置 SHARE_ENCRYPTION_SECRET 后重新部署。",
};

export class RuntimeConfigError extends UpstreamError {
  code: RuntimeConfigErrorCode;

  constructor(code: RuntimeConfigErrorCode) {
    super(500, "", RUNTIME_CONFIG_MESSAGES[code]);
    this.name = "RuntimeConfigError";
    this.code = code;
  }
}

const JSON_HEADERS = {
  "content-type": "application/json;charset=utf-8",
};

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, private, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
};

const SECURITY_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'; object-src 'none'; upgrade-insecure-requests",
};

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function mergeHeaders(...sources: Array<HeadersInit | undefined>) {
  const headers = new Headers();
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

export function json(data: unknown, init: ResponseInit = {}) {
  return withSecurityHeaders(
    new Response(JSON.stringify(data), {
      ...init,
      headers: mergeHeaders(init.headers, JSON_HEADERS, NO_STORE_HEADERS),
    })
  );
}

export function errorJson(status: number, message: string, code = "request_failed") {
  return json({ error: { code, message } }, { status });
}

export function runtimeConfigErrorJson(code: RuntimeConfigErrorCode) {
  return errorJson(500, RUNTIME_CONFIG_MESSAGES[code], code);
}

export function runtimeConfigCodeFromMessage(message: string, body = ""): RuntimeConfigErrorCode | "" {
  const text = `${message || ""}\n${body || ""}`;
  if (/MAIL_WORKER_BASE_URL/i.test(text)) return "mail_worker_not_configured";
  if (/SHARE_KV/i.test(text)) return "share_kv_not_configured";
  if (/SHARE_ENCRYPTION_SECRET/i.test(text)) return "share_secret_not_configured";
  return "";
}

export function getWorkerBaseUrl(env: CloudmailEnv) {
  const base = env.MAIL_WORKER_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) {
    throw new RuntimeConfigError("mail_worker_not_configured");
  }
  return base;
}

export function extractJwt(request: Request) {
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || request.headers.get("x-user-token")?.trim() || "";
}

export function extractUserToken(request: Request) {
  return extractJwt(request) || request.headers.get("x-user-access-token")?.trim() || "";
}

export function buildWorkerHeaders(env: CloudmailEnv, jwt?: string, hasJsonBody = false) {
  const headers: Record<string, string> = { "x-lang": "zh" };
  if (hasJsonBody) headers["content-type"] = "application/json";
  if (env.SITE_PASSWORD) headers["x-custom-auth"] = env.SITE_PASSWORD;
  if (jwt) {
    headers.Authorization = `Bearer ${jwt}`;
    headers["x-user-token"] = jwt;
  }
  return headers;
}

export function buildAddressWorkerHeaders(env: CloudmailEnv, addressJwt: string, userAccessToken?: string, hasJsonBody = false) {
  const headers: Record<string, string> = { "x-lang": "zh" };
  if (hasJsonBody) headers["content-type"] = "application/json";
  if (env.SITE_PASSWORD) headers["x-custom-auth"] = env.SITE_PASSWORD;
  if (addressJwt) headers.Authorization = `Bearer ${addressJwt}`;
  if (userAccessToken) headers["x-user-access-token"] = userAccessToken;
  return headers;
}

export function buildUserWorkerHeaders(env: CloudmailEnv, userToken: string, hasJsonBody = false) {
  const headers: Record<string, string> = { "x-lang": "zh" };
  if (hasJsonBody) headers["content-type"] = "application/json";
  if (env.SITE_PASSWORD) headers["x-custom-auth"] = env.SITE_PASSWORD;
  if (userToken) {
    headers.Authorization = `Bearer ${userToken}`;
    headers["x-user-token"] = userToken;
  }
  return headers;
}

export function buildBindAddressWorkerHeaders(env: CloudmailEnv, userToken: string, addressJwt: string, hasJsonBody = false) {
  return {
    ...buildAddressWorkerHeaders(env, addressJwt, undefined, hasJsonBody),
    "x-user-token": userToken,
  };
}

export function buildAdminWorkerHeaders(env: CloudmailEnv, adminPassword: string, hasJsonBody = false) {
  const headers: Record<string, string> = { "x-lang": "zh" };
  if (hasJsonBody) headers["content-type"] = "application/json";
  if (env.SITE_PASSWORD) headers["x-custom-auth"] = env.SITE_PASSWORD;
  if (adminPassword) headers["x-admin-auth"] = adminPassword;
  return headers;
}

type CorsMode = "public" | "admin";

function normalizeOrigin(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return "";
  }
}

function splitOrigins(value: string | undefined) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => normalizeOrigin(item))
    .filter(Boolean);
}

function isLocalDevOrigin(origin: string) {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function allowedCorsOrigin(request: Request, env: CloudmailEnv | undefined, mode: CorsMode) {
  const origin = normalizeOrigin(request.headers.get("origin"));
  if (!origin) return "";

  const requestOrigin = normalizeOrigin(new URL(request.url).origin);
  if (origin === requestOrigin || (isLocalDevOrigin(origin) && isLocalDevOrigin(requestOrigin))) return origin;

  const configuredOrigins = mode === "admin"
    ? [
        ...splitOrigins(env?.SHARE_ADMIN_CORS_ORIGINS),
        ...splitOrigins(env?.SHARE_ADMIN_ALLOWED_ORIGINS),
        ...splitOrigins(env?.CORS_ALLOWED_ORIGINS),
      ]
    : [
        ...splitOrigins(env?.SHARE_PUBLIC_CORS_ORIGINS),
        ...splitOrigins(env?.SHARE_PUBLIC_ALLOWED_ORIGINS),
      ];

  return configuredOrigins.includes(origin) ? origin : "";
}

export function corsHeaders(request: Request, env?: CloudmailEnv, mode: CorsMode = "public") {
  const origin = allowedCorsOrigin(request, env, mode);
  if (!origin) return { "Vary": "Origin" };
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": mode === "admin" ? "GET,POST,PATCH,DELETE,OPTIONS" : "GET,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": mode === "admin" ? "authorization,content-type,x-admin-auth,x-custom-auth,x-lang,x-user-access-token,x-user-token" : "content-type,x-lang",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  return headers;
}

export function withCors(response: Response, request: Request, env?: CloudmailEnv, mode: CorsMode = "public") {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env, mode))) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function fetchWorkerText(
  env: CloudmailEnv,
  path: string,
  init: { method?: string; jwt?: string; body?: unknown; search?: URLSearchParams } = {}
) {
  const url = new URL(`${getWorkerBaseUrl(env)}${path}`);
  if (init.search) url.search = init.search.toString();
  const hasJsonBody = init.body !== undefined;
  const response = await fetch(url.toString(), {
    method: init.method || (hasJsonBody ? "POST" : "GET"),
    headers: buildWorkerHeaders(env, init.jwt, hasJsonBody),
    body: hasJsonBody ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new UpstreamError(response.status, text);
  }
  return text;
}

export async function fetchWorkerTextWithHeaders(
  env: CloudmailEnv,
  path: string,
  headers: Record<string, string>,
  init: { method?: string; body?: unknown; search?: URLSearchParams } = {}
) {
  const url = new URL(`${getWorkerBaseUrl(env)}${path}`);
  if (init.search) url.search = init.search.toString();
  const hasJsonBody = init.body !== undefined;
  const response = await fetch(url.toString(), {
    method: init.method || (hasJsonBody ? "POST" : "GET"),
    headers,
    body: hasJsonBody ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new UpstreamError(response.status, text);
  }
  return text;
}

export async function fetchWorkerJson<T>(
  env: CloudmailEnv,
  path: string,
  init: { method?: string; jwt?: string; body?: unknown; search?: URLSearchParams } = {}
): Promise<T> {
  const text = await fetchWorkerText(env, path, init);
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

export async function fetchWorkerJsonWithHeaders<T>(
  env: CloudmailEnv,
  path: string,
  headers: Record<string, string>,
  init: { method?: string; body?: unknown; search?: URLSearchParams } = {}
): Promise<T> {
  const text = await fetchWorkerTextWithHeaders(env, path, headers, init);
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

export async function fetchAdminWorkerJson<T>(
  env: CloudmailEnv,
  path: string,
  adminPassword: string,
  init: { method?: string; body?: unknown; search?: URLSearchParams } = {}
): Promise<T> {
  const url = new URL(`${getWorkerBaseUrl(env)}${path}`);
  if (init.search) url.search = init.search.toString();
  const hasJsonBody = init.body !== undefined;
  const response = await fetch(url.toString(), {
    method: init.method || (hasJsonBody ? "POST" : "GET"),
    headers: buildAdminWorkerHeaders(env, adminPassword, hasJsonBody),
    body: hasJsonBody ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new UpstreamError(response.status, text);
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

export function normalizeMailPage(value: unknown) {
  if (Array.isArray(value)) return { results: value, count: value.length };
  if (value && typeof value === "object") {
    const page = value as { results?: unknown; count?: unknown };
    return {
      results: Array.isArray(page.results) ? page.results : [],
      count: typeof page.count === "number" ? page.count : 0,
    };
  }
  return { results: [], count: 0 };
}

export function sanitizeSettings(raw: unknown, fallbackAddress?: string) {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const arrayOfStrings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
  return {
    address: typeof src.address === "string" ? src.address : fallbackAddress || "",
    enableSendMail: typeof src.enableSendMail === "boolean" ? src.enableSendMail : undefined,
    enableAutoReply: typeof src.enableAutoReply === "boolean" ? src.enableAutoReply : undefined,
    sendBalance: typeof src.send_balance === "number" ? src.send_balance : undefined,
    domains: arrayOfStrings(src.domains),
    defaultDomains: arrayOfStrings(src.defaultDomains),
    domainLabels: arrayOfStrings(src.domainLabels),
    randomSubdomainDomains: arrayOfStrings(src.randomSubdomainDomains),
  };
}

export function decodeJwtAddress(jwt: string) {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return "";
    const jsonText = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const data = JSON.parse(jsonText) as Record<string, unknown>;
    for (const key of ["address", "email", "mail", "sub"]) {
      if (typeof data[key] === "string" && data[key].includes("@")) return data[key] as string;
    }
    return "";
  } catch {
    return "";
  }
}

function readableUpstreamMessage(error: UpstreamError) {
  const body = String(error.body || "").trim();
  if (body) {
    try {
      const data = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
      const message = data?.error?.message || data?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {
      // fall through to text cleanup
    }
    const text = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (text && !/^<!doctype html/i.test(body)) return text.slice(0, 240);
  }
  if (error.status === 405) return "邮箱服务接口方法不匹配，请确认 Pages Functions 和 Worker API 已部署到最新版本。";
  if (error.status === 401 || error.status === 403) return "登录凭据无效或权限不足。";
  return "邮箱服务请求失败";
}

export function mapUpstreamError(error: unknown) {
  if (error instanceof RuntimeConfigError) return runtimeConfigErrorJson(error.code);
  if (error instanceof UpstreamError) {
    const configCode = error.status === 500 ? runtimeConfigCodeFromMessage(error.message, error.body) : "";
    if (configCode) return runtimeConfigErrorJson(configCode);
    const status = error.status === 500 ? 500 : error.status || 502;
    return errorJson(status, status === 500 ? error.message : readableUpstreamMessage(error), "upstream_error");
  }
  return errorJson(500, "请求处理失败", "internal_error");
}
