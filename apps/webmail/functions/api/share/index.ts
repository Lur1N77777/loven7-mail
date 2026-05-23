import { corsHeaders, errorJson, fetchAdminWorkerJson, json, mapUpstreamError, withCors } from "../../_lib/http";
import { getLatestMailCutoff, newShareToken, normalizeSharePermissions, parseShareTtl, saveShare, shareError, shareUrlFromRequest, validateJwtAddress, type ShareMailVisibility, type SharePayload } from "../../_lib/share";
import type { PagesHandler } from "../../_lib/types";

type CreateShareBody = {
  addressIds?: unknown;
  expiresIn?: unknown;
  mailVisibility?: unknown;
  permissions?: unknown;
};

function parseAddressIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  const ids = value
    .map((item) => Number.parseInt(String(item), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  return [...new Set(ids)].slice(0, 50);
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
    if (!addressIds.length) return withCors(errorJson(400, "请选择至少一个邮箱地址", "missing_addresses"), request);

    const ttl = parseShareTtl(body?.expiresIn);
    const mailVisibility: ShareMailVisibility = body?.mailVisibility === "all" ? "all" : "new";
    const permissions = normalizeSharePermissions(body?.permissions);
    const addresses = [];
    for (const id of addressIds) {
      const credential = await fetchAdminWorkerJson<{ jwt?: string }>(workerEnv, `/admin/show_password/${id}`, adminPassword);
      const jwt = String(credential?.jwt || "").trim();
      if (!jwt) throw new Error(`地址 #${id} 没有返回 JWT`);
      const address = await validateJwtAddress(workerEnv, jwt);
      if (!address) throw new Error(`地址 #${id} JWT 无法解析邮箱`);
      const cutoff = mailVisibility === "new" ? await getLatestMailCutoff(workerEnv, jwt) : { sinceMailId: 0, sinceCreatedAt: null };
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
        addresses: addresses.map(({ id, address }) => ({ id, address })),
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
