import { corsHeaders, errorJson, fetchWorkerJson, json, mapUpstreamError, UpstreamError, withCors } from "../../../../_lib/http";
import { resolveSharedMailbox, shareError, updateShareRecord } from "../../../../_lib/share";
import type { PagesHandler } from "../../../../_lib/types";

export const onRequestOptions: PagesHandler<{ token: string; id: string }> = ({ request, env }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request, env, "public") });
};

export const onRequestDelete: PagesHandler<{ token: string; id: string }> = async ({ request, env, params }) => {
  try {
    const url = new URL(request.url);
    const mailboxId = url.searchParams.get("mailbox") || "";
    const mailId = Number.parseInt(String(params.id || ""), 10);
    if (!Number.isFinite(mailId) || mailId <= 0) return withCors(errorJson(400, "邮件 ID 无效", "invalid_mail_id"), request, env, "public");
    const resolved = await resolveSharedMailbox(env, params.token, mailboxId);
    if (!resolved) return withCors(errorJson(404, "共享邮箱不存在或链接已失效", "share_mailbox_not_found"), request, env, "public");
    if (!resolved.share.permissions.hideMail) return withCors(errorJson(403, "此共享链接不允许删除邮件", "share_permission_denied"), request, env, "public");

    if ((resolved.mailbox.hiddenMailIds || []).includes(mailId)) {
      return withCors(json({ ok: true, unchanged: true }), request, env, "public");
    }

    // Hiding is share-local (the upstream message is never deleted), but the
    // id still has to belong to this mailbox. The Worker scopes this lookup by
    // the mailbox JWT, preventing arbitrary ids from polluting the share.
    const upstreamMail = await fetchWorkerJson<unknown>(env, `/api/mail/${mailId}`, { jwt: resolved.mailbox.jwt });
    const upstreamRecord = upstreamMail && typeof upstreamMail === "object" && !Array.isArray(upstreamMail)
      ? upstreamMail as Record<string, unknown>
      : null;
    if (!upstreamRecord || Number(upstreamRecord.id) !== mailId) {
      return withCors(errorJson(404, "共享邮箱中不存在这封邮件", "share_mail_not_found"), request, env, "public");
    }

    const share = await updateShareRecord(env, params.token, (payload) => {
      return {
        ...payload,
        addresses: payload.addresses.map((mailbox, index) => {
          const matched = mailbox.id === resolved.mailbox.id || (!mailboxId && index === 0);
          if (!matched) return mailbox;
          const hidden = new Set(mailbox.hiddenMailIds || []);
          const alreadyHidden = hidden.has(mailId);
          hidden.add(mailId);
          const mailCount = Number.isFinite(Number(mailbox.mailCount))
            ? Math.max(0, Math.floor(Number(mailbox.mailCount)) - (alreadyHidden ? 0 : 1))
            : undefined;
          return { ...mailbox, ...(mailCount !== undefined ? { mailCount } : {}), hiddenMailIds: Array.from(hidden).slice(-1000) };
        }),
        updatedAt: new Date().toISOString(),
      };
    });
    if (!share) return withCors(errorJson(404, "共享链接不存在", "share_not_found"), request, env, "public");
    return withCors(json({ ok: true }), request, env, "public");
  } catch (error) {
    if (error instanceof Error && error.message.includes("不允许")) return withCors(errorJson(403, error.message, "share_permission_denied"), request, env, "public");
    if (error instanceof UpstreamError) return withCors(mapUpstreamError(error), request, env, "public");
    return withCors(shareError(error), request, env, "public");
  }
};
