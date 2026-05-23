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

const JSON_HEADERS = {
  "content-type": "application/json;charset=utf-8",
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

export function json(data: unknown, init: ResponseInit = {}) {
  return withSecurityHeaders(
    new Response(JSON.stringify(data), {
      ...init,
      headers: {
        ...JSON_HEADERS,
        ...(init.headers || {}),
      },
    })
  );
}

export function errorJson(status: number, message: string, code = "request_failed") {
  return json({ error: { code, message } }, { status });
}

export function getWorkerBaseUrl(env: CloudmailEnv) {
  const base = env.MAIL_WORKER_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) {
    throw new UpstreamError(500, "", "MAIL_WORKER_BASE_URL is not configured");
  }
  return base;
}

export function extractJwt(request: Request) {
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || request.headers.get("x-user-token")?.trim() || "";
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

export function buildAdminWorkerHeaders(env: CloudmailEnv, adminPassword: string, hasJsonBody = false) {
  const headers: Record<string, string> = { "x-lang": "zh" };
  if (hasJsonBody) headers["content-type"] = "application/json";
  if (env.SITE_PASSWORD) headers["x-custom-auth"] = env.SITE_PASSWORD;
  if (adminPassword) headers["x-admin-auth"] = adminPassword;
  return headers;
}

export function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-admin-auth,x-custom-auth,x-lang",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function withCors(response: Response, request: Request) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value);
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

export async function fetchWorkerJson<T>(
  env: CloudmailEnv,
  path: string,
  init: { method?: string; jwt?: string; body?: unknown; search?: URLSearchParams } = {}
): Promise<T> {
  const text = await fetchWorkerText(env, path, init);
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

export function mapUpstreamError(error: unknown) {
  if (error instanceof UpstreamError) {
    const status = error.status === 500 ? 500 : error.status || 502;
    return errorJson(status, status === 500 ? error.message : "邮箱服务请求失败", "upstream_error");
  }
  return errorJson(500, "请求处理失败", "internal_error");
}
