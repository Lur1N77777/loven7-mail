import { corsHeaders, errorJson, json, withCors } from "../../../_lib/http";
import { adminShare, assertShareAdmin, getLatestMailCutoff, isValidShareTtl, normalizeSharePermissions, parseShareTtl, readShareRecord, revokeShare, shareError, updateShareRecord, type ShareMailVisibility } from "../../../_lib/share";
import type { PagesHandler } from "../../../_lib/types";

type UpdateShareBody = {
  expiresIn?: unknown;
  expiresAt?: unknown;
  restore?: unknown;
  mailVisibility?: unknown;
  permissions?: unknown;
  resetSince?: unknown;
};

function normalizeExplicitExpiresAt(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

export const onRequestOptions: PagesHandler<{ token: string }> = ({ request, env }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request, env, "admin") });
};

export const onRequestGet: PagesHandler<{ token: string }> = async ({ request, env, params }) => {
  try {
    await assertShareAdmin(request, env);
    const share = await readShareRecord(env, params.token);
    if (!share) return withCors(errorJson(404, "共享链接不存在", "share_not_found"), request, env, "admin");
    return withCors(json({ ok: true, share: adminShare(request, params.token, share) }), request, env, "admin");
  } catch (error) {
    return withCors(shareError(error), request, env, "admin");
  }
};

export const onRequestPatch: PagesHandler<{ token: string }> = async ({ request, env, params }) => {
  try {
    const { workerEnv } = await assertShareAdmin(request, env);
    const body = (await request.json().catch(() => null)) as UpdateShareBody | null;
    const hasExpiresAt = Boolean(body && Object.prototype.hasOwnProperty.call(body, "expiresAt"));
    const hasExpiresIn = Boolean(body && Object.prototype.hasOwnProperty.call(body, "expiresIn"));
    const explicitExpiresAt = hasExpiresAt ? normalizeExplicitExpiresAt(body?.expiresAt) : undefined;
    if (hasExpiresAt && explicitExpiresAt === undefined) {
      return withCors(errorJson(400, "共享链接到期时间无效", "invalid_share_expiry"), request, env, "admin");
    }
    if (hasExpiresIn && !isValidShareTtl(body?.expiresIn)) {
      return withCors(errorJson(400, "共享链接有效期选项无效", "invalid_share_expiry"), request, env, "admin");
    }
    const requestedExpiresAt = hasExpiresAt
      ? explicitExpiresAt
      : hasExpiresIn
        ? parseShareTtl(body?.expiresIn).expiresAt
        : undefined;
    const restore = Boolean(body?.restore);
    const requestedVisibility: ShareMailVisibility | undefined = body?.mailVisibility === "new" || body?.mailVisibility === "all" ? body.mailVisibility : undefined;
    const current = await readShareRecord(env, params.token);
    if (restore && current?.revokedAt) {
      return withCors(errorJson(409, "已撤销的共享链接不可恢复，请创建新链接", "share_revocation_irreversible"), request, env, "admin");
    }
    const shouldResetSince = Boolean(body?.resetSince) || requestedVisibility === "new";
    const cutoffById = new Map<string, { sinceMailId: number; sinceCreatedAt: string | null }>();
    if (current && shouldResetSince) {
      for (const mailbox of current.addresses) {
        cutoffById.set(mailbox.id, await getLatestMailCutoff(workerEnv, mailbox.jwt));
      }
    }
    const share = await updateShareRecord(env, params.token, (payload) => ({
      ...payload,
      expiresAt: requestedExpiresAt === undefined ? payload.expiresAt : requestedExpiresAt,
      revokedAt: restore ? null : payload.revokedAt || null,
      mailVisibility: requestedVisibility || payload.mailVisibility,
      permissions: body?.permissions ? normalizeSharePermissions(body.permissions, payload.permissions) : payload.permissions,
      addresses: payload.addresses.map((mailbox) => {
        const cutoff = cutoffById.get(mailbox.id);
        return cutoff ? { ...mailbox, ...cutoff } : mailbox;
      }),
      updatedAt: new Date().toISOString(),
    }));
    if (!share) return withCors(errorJson(404, "共享链接不存在", "share_not_found"), request, env, "admin");
    return withCors(json({ ok: true, share: adminShare(request, params.token, share) }), request, env, "admin");
  } catch (error) {
    return withCors(shareError(error), request, env, "admin");
  }
};

export const onRequestDelete: PagesHandler<{ token: string }> = async ({ request, env, params }) => {
  try {
    await assertShareAdmin(request, env);
    const share = await revokeShare(env, params.token);
    if (!share) return withCors(errorJson(404, "共享链接不存在", "share_not_found"), request, env, "admin");
    return withCors(json({ ok: true, share: adminShare(request, params.token, share) }), request, env, "admin");
  } catch (error) {
    return withCors(shareError(error), request, env, "admin");
  }
};
