type AdminProxyEnv = {
  MAIL_WORKER_BASE_URL?: string;
  ADMIN_PASSWORD?: string;
  SITE_PASSWORD?: string;
};

type PagesContext<Params extends Record<string, string | string[] | undefined> = Record<string, string | string[] | undefined>> = {
  request: Request;
  env: AdminProxyEnv;
  params: Params;
};

type UserSettings = {
  is_admin?: boolean;
  isAdmin?: boolean;
  role?: unknown;
  role_text?: unknown;
  roleText?: unknown;
  role_key?: unknown;
  roleKey?: unknown;
  user_role?: unknown;
  userRole?: unknown;
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const ADMIN_PROXY_HEADERS = {
  "Cache-Control": "no-store, private, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-Content-Type-Options": "nosniff",
};

const CORS_ALLOW_HEADERS = "authorization,content-type,x-admin-auth,x-custom-auth,x-fingerprint,x-lang,x-user-access-token,x-user-token";

function jsonError(status: number, message: string, code = "admin_proxy_error") {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json;charset=utf-8",
      ...ADMIN_PROXY_HEADERS,
    },
  });
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

function workerBase(env: AdminProxyEnv) {
  const base = env.MAIL_WORKER_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("missing_worker_base");
  return base;
}

function pathParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join("/");
  return value || "";
}

function targetUrl(context: PagesContext, prefix: string) {
  const source = new URL(context.request.url);
  const rest = pathParam(context.params.path);
  const target = new URL(`${workerBase(context.env)}/${prefix}${rest ? `/${rest}` : ""}`);
  target.search = source.search;
  return target;
}

function tokenFromRequest(request: Request) {
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer
    || request.headers.get("x-user-access-token")?.trim()
    || request.headers.get("x-user-token")?.trim()
    || "";
}

function normalizeRole(value: unknown) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim().toLowerCase();
  return "";
}

function isAdminRole(value: unknown) {
  const role = normalizeRole(value);
  return role === "admin" || role === "administrator" || role === "管理员";
}

function isTrueFlag(value: unknown) {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return /^(1|true|yes|y)$/i.test(value.trim());
}

function profileIsAdmin(profile: UserSettings) {
  const userRole = profile.user_role || profile.userRole;
  const roleRecord = userRole && typeof userRole === "object" && !Array.isArray(userRole) ? userRole as Record<string, unknown> : {};
  return isTrueFlag(profile.is_admin)
    || isTrueFlag(profile.isAdmin)
    || isAdminRole(profile.role)
    || isAdminRole(profile.role_text)
    || isAdminRole(profile.roleText)
    || isAdminRole(profile.role_key)
    || isAdminRole(profile.roleKey)
    || isAdminRole(userRole)
    || isAdminRole(roleRecord.role)
    || isAdminRole(roleRecord.role_text)
    || isAdminRole(roleRecord.roleText)
    || isAdminRole(roleRecord.label)
    || isAdminRole(roleRecord.key)
    || isAdminRole(roleRecord.value);
}

async function verifyAdminAccount(env: AdminProxyEnv, token: string) {
  if (!token) return false;
  const url = new URL(`${workerBase(env)}/user_api/settings`);
  const headers: Record<string, string> = {
    "x-lang": "zh",
    "x-user-token": token,
    "Authorization": `Bearer ${token}`,
  };
  if (env.SITE_PASSWORD) headers["x-custom-auth"] = env.SITE_PASSWORD;
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) return false;
  const raw = await response.json().catch(() => null) as unknown;
  const profile = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as UserSettings : {};
  return profileIsAdmin(profile);
}

function upstreamHeaders(request: Request, env: AdminProxyEnv, hasBody: boolean) {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (lower === "origin" || lower === "referer") return;
    if (lower === "x-admin-auth" || lower === "x-custom-auth") return;
    headers.set(key, value);
  });
  if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("x-lang", request.headers.get("x-lang") || "zh");
  if (env.SITE_PASSWORD && !headers.has("x-custom-auth")) headers.set("x-custom-auth", env.SITE_PASSWORD);
  return headers;
}

function proxyResponse(response: Response, request: Request) {
  const headers = new Headers(response.headers);
  for (const key of HOP_BY_HOP_HEADERS) headers.delete(key);
  for (const [key, value] of Object.entries(ADMIN_PROXY_HEADERS)) headers.set(key, value);
  const cors = sameOriginCorsHeaders(request);
  if (cors) for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function proxyToWorker(context: PagesContext, prefix: string, options: { admin: boolean }) {
  let url: URL;
  try {
    url = targetUrl(context, prefix);
  } catch {
    return jsonError(500, "管理员后台代理未配置 MAIL_WORKER_BASE_URL。", "missing_worker_base");
  }

  const request = context.request;
  const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());
  const headers = upstreamHeaders(request, context.env, hasBody);

  if (options.admin) {
    const providedAdminPassword = request.headers.get("x-admin-auth")?.trim() || "";
    const adminPassword = context.env.ADMIN_PASSWORD?.trim() || "";
    if (!adminPassword) return jsonError(500, "管理员后台代理未配置 ADMIN_PASSWORD。", "missing_admin_password");
    if (providedAdminPassword) {
      if (providedAdminPassword !== adminPassword) return jsonError(403, "管理员凭据无效。", "invalid_admin_password");
      headers.set("x-admin-auth", adminPassword);
    } else {
      let isAdmin = false;
      try {
        isAdmin = await verifyAdminAccount(context.env, tokenFromRequest(request));
      } catch {
        isAdmin = false;
      }
      if (!isAdmin) return jsonError(403, "当前账号不是管理员或登录已失效。", "not_admin");
      headers.set("x-admin-auth", adminPassword);
    }
  }

  try {
    const upstream = await fetch(url.toString(), {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
    });
    return proxyResponse(upstream, request);
  } catch {
    return jsonError(502, "上游邮件 Worker 暂时不可用。", "upstream_unavailable");
  }
}

export function proxyOptions(context: { request: Request }) {
  const cors = sameOriginCorsHeaders(context.request);
  if (cors === null) return jsonError(403, "不允许的跨域来源。", "origin_not_allowed");
  return new Response(null, {
    status: 204,
    headers: {
      ...(cors || {}),
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
      "Access-Control-Max-Age": "86400",
      ...ADMIN_PROXY_HEADERS,
    },
  });
}

export type { PagesContext };
