import { corsHeaders, errorJson, json, withCors } from "../../../_lib/http";
import { adminShare, assertShareAdmin, getLatestMailCutoff, normalizeSharePermissions, parseShareTtl, readShareRecord, revokeShare, shareError, updateShareRecord, type ShareMailVisibility } from "../../../_lib/share";
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

export const onRequestOptions: PagesHandler<{ token: string }> = ({ request }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
};

export const onRequestGet: PagesHandler<{ token: string }> = async ({ request, env, params }) => {
  try {
    await assertShareAdmin(request, env);
    const share = await readShareRecord(env, params.token);
    if (!share) return withCors(errorJson(404, "共享链接不存在", "share_not_found"), request);
    return withCors(json({ ok: true, share: adminShare(request, params.token, share) }), request);
  } catch (error) {
    return withCors(shareError(error), request);
  }
};

export const onRequestPatch: PagesHandler<{ token: string }> = async ({ request, env, params }) => {
  try {
    const { workerEnv } = await assertShareAdmin(request, env);
    const body = (await request.json().catch(() => null)) as UpdateShareBody | null;
    const explicitExpiresAt = normalizeExplicitExpiresAt(body?.expiresAt);
    const ttl = explicitExpiresAt === undefined ? parseShareTtl(body?.expiresIn) : { expiresAt: explicitExpiresAt };
    const restore = Boolean(body?.restore);
    const requestedVisibility: ShareMailVisibility | undefined = body?.mailVisibility === "new" || body?.mailVisibility === "all" ? body.mailVisibility : undefined;
    const current = await readShareRecord(env, params.token);
    const shouldResetSince = Boolean(body?.resetSince) || requestedVisibility === "new";
    const cutoffById = new Map<string, { sinceMailId: number; sinceCreatedAt: string | null }>();
    if (current && shouldResetSince) {
      for (const mailbox of current.addresses) {
        cutoffById.set(mailbox.id, await getLatestMailCutoff(workerEnv, mailbox.jwt));
      }
    }
    const share = await updateShareRecord(env, params.token, (payload) => ({
      ...payload,
      expiresAt: ttl.expiresAt,
      revokedAt: restore ? null : payload.revokedAt || null,
      mailVisibility: requestedVisibility || payload.mailVisibility,
      permissions: body?.permissions ? normalizeSharePermissions(body.permissions, payload.permissions) : payload.permissions,
      addresses: payload.addresses.map((mailbox) => {
        const cutoff = cutoffById.get(mailbox.id);
        return cutoff ? { ...mailbox, ...cutoff } : mailbox;
      }),
      updatedAt: new Date().toISOString(),
    }));
    if (!share) return withCors(errorJson(404, "共享链接不存在", "share_not_found"), request);
    return withCors(json({ ok: true, share: adminShare(request, params.token, share) }), request);
  } catch (error) {
    return withCors(shareError(error), request);
  }
};

export const onRequestDelete: PagesHandler<{ token: string }> = async ({ request, env, params }) => {
  try {
    await assertShareAdmin(request, env);
    const share = await revokeShare(env, params.token);
    if (!share) return withCors(errorJson(404, "共享链接不存在", "share_not_found"), request);
    return withCors(json({ ok: true, share: adminShare(request, params.token, share) }), request);
  } catch (error) {
    return withCors(shareError(error), request);
  }
};
