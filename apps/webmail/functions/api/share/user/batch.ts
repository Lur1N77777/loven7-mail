import { corsHeaders, errorJson, json, withCors } from "../../../_lib/http";
import { adminShare, getLatestMailCutoff, normalizeSharePermissions, parseShareTtl, readShareRecord, revokeShare, shareError, updateShareRecord, type ShareMailVisibility } from "../../../_lib/share";
import { getAllowedShareAddresses, shareBelongsToUser } from "../../../_lib/shareUser";
import type { PagesHandler } from "../../../_lib/types";
import { getUserToken, missingUserToken } from "../../../_lib/user";

type BatchBody = {
  tokens?: unknown;
  action?: unknown;
  expiresIn?: unknown;
  mailVisibility?: unknown;
  permissions?: unknown;
};

function parseTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter((item) => /^[A-Za-z0-9_-]{12,96}$/.test(item)))].slice(0, 100);
}

export const onRequestOptions: PagesHandler = ({ request, env }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request, env, "admin") });
};

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  try {
    const userToken = getUserToken(request);
    if (!userToken) return withCors(missingUserToken(), request, env, "admin");
    const allowed = await getAllowedShareAddresses(env, userToken);
    const body = (await request.json().catch(() => null)) as BatchBody | null;
    const tokens = parseTokens(body?.tokens);
    if (!tokens.length) return withCors(errorJson(400, "请选择至少一个共享链接", "missing_tokens"), request, env, "admin");
    const action = String(body?.action || "").trim();
    const allowedActions = new Set(["revoke", "restore", "update", "refresh-index"]);
    if (!allowedActions.has(action)) return withCors(errorJson(400, "批量操作无效", "bad_batch_action"), request, env, "admin");

    const ttl = parseShareTtl(body?.expiresIn);
    const requestedVisibility: ShareMailVisibility | undefined = body?.mailVisibility === "new" || body?.mailVisibility === "all" ? body.mailVisibility : undefined;
    const results = [];
    const failures = [];

    for (const token of tokens) {
      try {
        const current = await readShareRecord(env, token);
        if (!current) throw new Error("共享链接不存在");
        if (!shareBelongsToUser(current, allowed)) throw new Error("无权管理该共享链接");
        let share = null;
        if (action === "revoke") {
          share = await revokeShare(env, token);
        } else if (action === "refresh-index") {
          share = await updateShareRecord(env, token, (payload) => ({ ...payload, updatedAt: new Date().toISOString() }));
        } else {
          const cutoffById = new Map<string, { sinceMailId: number; sinceCreatedAt: string | null; mailCount?: number }>();
          if (requestedVisibility === "new") {
            for (const mailbox of current.addresses) {
              cutoffById.set(mailbox.id, await getLatestMailCutoff(env, mailbox.jwt));
            }
          }
          share = await updateShareRecord(env, token, (payload) => ({
            ...payload,
            expiresAt: action === "restore" || body?.expiresIn ? ttl.expiresAt : payload.expiresAt,
            revokedAt: action === "restore" ? null : payload.revokedAt || null,
            mailVisibility: requestedVisibility || payload.mailVisibility,
            permissions: body?.permissions ? normalizeSharePermissions(body.permissions, payload.permissions) : payload.permissions,
            addresses: payload.addresses.map((mailbox) => {
              const cutoff = cutoffById.get(mailbox.id);
              return cutoff ? { ...mailbox, ...cutoff } : mailbox;
            }),
            updatedAt: new Date().toISOString(),
          }));
        }
        if (!share) throw new Error("共享链接不存在");
        results.push(adminShare(request, token, share));
      } catch (error) {
        failures.push({ token, message: error instanceof Error ? error.message : "操作失败" });
      }
    }

    return withCors(json({ ok: failures.length === 0, results, failures }), request, env, "admin");
  } catch (error) {
    return withCors(shareError(error), request, env, "admin");
  }
};
