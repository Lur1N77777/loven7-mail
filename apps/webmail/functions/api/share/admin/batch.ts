import { corsHeaders, errorJson, json, withCors } from "../../../_lib/http";
import { adminShare, assertShareAdmin, getLatestMailCutoff, normalizeSharePermissions, parseShareTtl, readShareRecord, revokeShare, shareError, updateShareRecord, type ShareMailVisibility } from "../../../_lib/share";
import type { PagesHandler } from "../../../_lib/types";

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

export const onRequestOptions: PagesHandler = ({ request }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
};

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  try {
    const { workerEnv } = await assertShareAdmin(request, env);
    const body = (await request.json().catch(() => null)) as BatchBody | null;
    const tokens = parseTokens(body?.tokens);
    if (!tokens.length) return withCors(errorJson(400, "请选择至少一个共享链接", "missing_tokens"), request);
    const action = String(body?.action || "").trim();
    const allowedActions = new Set(["revoke", "restore", "update", "refresh-index"]);
    if (!allowedActions.has(action)) return withCors(errorJson(400, "批量操作无效", "bad_batch_action"), request);

    const ttl = parseShareTtl(body?.expiresIn);
    const requestedVisibility: ShareMailVisibility | undefined = body?.mailVisibility === "new" || body?.mailVisibility === "all" ? body.mailVisibility : undefined;
    const results = [];
    const failures = [];

    for (const token of tokens) {
      try {
        let share = null;
        if (action === "revoke") {
          share = await revokeShare(env, token);
        } else if (action === "refresh-index") {
          share = await readShareRecord(env, token);
          if (share) await updateShareRecord(env, token, (payload) => ({ ...payload, updatedAt: new Date().toISOString() }));
        } else {
          const current = await readShareRecord(env, token);
          const cutoffById = new Map<string, { sinceMailId: number; sinceCreatedAt: string | null }>();
          if (current && requestedVisibility === "new") {
            for (const mailbox of current.addresses) {
              cutoffById.set(mailbox.id, await getLatestMailCutoff(workerEnv, mailbox.jwt));
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

    return withCors(json({ ok: failures.length === 0, results, failures }), request);
  } catch (error) {
    return withCors(shareError(error), request);
  }
};
