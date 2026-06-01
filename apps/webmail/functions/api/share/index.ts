import { corsHeaders, decodeJwtAddress, errorJson, fetchAdminWorkerJson, fetchWorkerJson, json, mapUpstreamError, UpstreamError, withCors } from "../../_lib/http";
import { getLatestMailCutoff, newShareToken, normalizeSharePermissions, parseShareTtl, saveShare, shareError, shareUrlFromRequest, type ShareMailVisibility, type SharePayload } from "../../_lib/share";
import type { PagesHandler } from "../../_lib/types";

type AddressHint = {
  id: string;
  address: string;
};

type CreateShareBody = {
  addressIds?: unknown;
  addresses?: unknown;
  expiresIn?: unknown;
  mailVisibility?: unknown;
  permissions?: unknown;
};

type AddressLoginResponse = {
  jwt?: string;
  address?: string;
};

function parseAddressIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  const ids = value
    .map((item) => Number.parseInt(String(item), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  return [...new Set(ids)].slice(0, 50);
}

function normalizeAddress(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : "";
}

function sameAddress(left: unknown, right: unknown) {
  const normalizedLeft = normalizeAddress(left);
  const normalizedRight = normalizeAddress(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function parseAddressHints(value: unknown) {
  const hints = new Map<string, AddressHint>();
  if (!Array.isArray(value)) return hints;
  for (const item of value) {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const id = String(record.id || "").trim();
    const address = normalizeAddress(record.address || record.name || record.email);
    if (id && address) hints.set(id, { id, address });
  }
  return hints;
}

function extractJwtFromCredential(value: unknown) {
  const src = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const nested = src.data && typeof src.data === "object" ? src.data as Record<string, unknown> : {};
  for (const record of [src, nested]) {
    for (const key of ["jwt", "JWT", "token", "access_token"]) {
      const candidate = String(record[key] || "").trim();
      if (candidate) return candidate;
    }
  }
  return "";
}

function extractAddressPassword(value: unknown) {
  const src = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const nested = src.data && typeof src.data === "object" ? src.data as Record<string, unknown> : {};
  for (const record of [src, nested]) {
    for (const key of ["credential", "password"]) {
      const candidate = String(record[key] || "").trim();
      if (candidate) return candidate;
    }
  }
  return "";
}

function looksLikeJwt(value: string) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function loginAddressPassword(env: Parameters<PagesHandler>[0]["env"], address: string, password: string) {
  const attempts = [await sha256Hex(password)];
  if (/^[a-f0-9]{64}$/i.test(password)) attempts.push(password);
  let lastError: unknown = null;
  for (const hashedPassword of [...new Set(attempts)]) {
    try {
      const loginBody = await fetchWorkerJson<AddressLoginResponse>(env, "/api/address_login", {
        method: "POST",
        body: { email: address, password: hashedPassword },
      });
      const jwt = String(loginBody?.jwt || "").trim();
      const resolvedAddress = normalizeAddress(loginBody?.address);
      if (resolvedAddress && !sameAddress(resolvedAddress, address)) {
        throw new Error(`地址登录返回了不匹配的邮箱：${resolvedAddress}`);
      }
      if (jwt) return jwt;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return "";
}

async function resolveVerifiedJwtAddress(env: Parameters<PagesHandler>[0]["env"], jwt: string, fallbackAddress = "") {
  const decodedAddress = normalizeAddress(decodeJwtAddress(jwt));
  if (decodedAddress) return { address: decodedAddress, verifiedBy: "jwt-payload" as const };
  try {
    const settingsRaw = await fetchWorkerJson<unknown>(env, "/api/settings", { jwt });
    const settings = settingsRaw && typeof settingsRaw === "object" ? settingsRaw as Record<string, unknown> : {};
    const settingsAddress = normalizeAddress(settings.address);
    if (settingsAddress) return { address: settingsAddress, verifiedBy: "settings" as const };
  } catch {
    // The caller must not treat fallbackAddress as verified. It is only for error context.
  }
  return { address: normalizeAddress(fallbackAddress), verifiedBy: "unverified" as const };
}

export const onRequestOptions: PagesHandler = ({ request }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
};

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  try {
    const adminPassword = request.headers.get("x-admin-auth")?.trim() || "";
    if (!adminPassword) return withCors(errorJson(401, "缺少管理员凭证", "missing_admin_auth"), request);
    const requestSitePassword = request.headers.get("x-custom-auth")?.trim() || "";
    const workerEnv = requestSitePassword && !env.SITE_PASSWORD ? { ...env, SITE_PASSWORD: requestSitePassword } : env;

    const body = (await request.json().catch(() => null)) as CreateShareBody | null;
    const addressIds = parseAddressIds(body?.addressIds);
    const addressHints = parseAddressHints(body?.addresses);
    if (!addressIds.length) return withCors(errorJson(400, "请选择至少一个邮箱地址", "missing_addresses"), request);

    const ttl = parseShareTtl(body?.expiresIn);
    const mailVisibility: ShareMailVisibility = body?.mailVisibility === "all" ? "all" : "new";
    const permissions = normalizeSharePermissions(body?.permissions);
    const addresses = [];
    for (const id of addressIds) {
      let credential: unknown;
      try {
        credential = await fetchAdminWorkerJson<unknown>(workerEnv, `/admin/show_password/${id}`, adminPassword);
      } catch (error) {
        if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) throw error;
        throw new Error(`无法读取地址 #${id} 的访问凭证，请确认 Worker API 地址、管理员密码和站点访问密码是否正确`);
      }
      let jwt = extractJwtFromCredential(credential);
      let fallbackAddress = addressHints.get(String(id))?.address || decodeJwtAddress(jwt);
      const password = extractAddressPassword(credential);
      if (!jwt && looksLikeJwt(password)) jwt = password;
      if (!jwt && password && fallbackAddress) {
        try {
          jwt = await loginAddressPassword(workerEnv, fallbackAddress, password);
        } catch (error) {
          if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) {
            throw new Error(`地址 #${id} 的邮箱密码无法登录，请先在地址管理中重置密码后再创建分享`);
          }
          throw error;
        }
      }
      if (!jwt) throw new Error(`地址 #${id} 没有返回可用于分享的 JWT`);
      if (!fallbackAddress) fallbackAddress = decodeJwtAddress(jwt);
      const resolved = await resolveVerifiedJwtAddress(workerEnv, jwt, fallbackAddress);
      const address = resolved.address;
      if (!address || resolved.verifiedBy === "unverified") {
        throw new Error(`地址 #${id} 的访问凭证无法验证邮箱归属，请刷新地址列表或重置密码后重试`);
      }
      if (fallbackAddress && !sameAddress(address, fallbackAddress)) {
        throw new Error(`地址 #${id} 的访问凭证属于其他邮箱，请刷新地址列表后重试`);
      }
      const snapshot = await getLatestMailCutoff(workerEnv, jwt);
      const cutoff = mailVisibility === "new"
        ? { sinceMailId: snapshot.sinceMailId, sinceCreatedAt: snapshot.sinceCreatedAt, mailCount: 0 }
        : { sinceMailId: 0, sinceCreatedAt: null, mailCount: snapshot.mailCount };
      addresses.push({ id: String(id), address, jwt, ...cutoff, hiddenMailIds: [] });
    }

    const token = newShareToken();
    const payload: SharePayload = {
      version: 2,
      token,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: ttl.expiresAt,
      revokedAt: null,
      mailVisibility,
      permissions,
      addresses,
    };
    await saveShare(env, token, payload);

    return withCors(
      json({
        ok: true,
        token,
        url: shareUrlFromRequest(request, token),
        expiresAt: payload.expiresAt,
        mailVisibility: payload.mailVisibility,
        permissions: payload.permissions,
        addresses: addresses.map(({ id, address, mailCount }) => ({ id, address, mailCount })),
      }),
      request
    );
  } catch (error) {
    if (error instanceof Error && !(error as any).status) {
      return withCors(errorJson(500, error.message || "创建共享链接失败", "share_create_failed"), request);
    }
    const response = shareError(error);
    if (response.status !== 500) return withCors(response, request);
    return withCors(mapUpstreamError(error), request);
  }
};
