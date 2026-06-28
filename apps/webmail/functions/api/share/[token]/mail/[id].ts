import { corsHeaders, errorJson, fetchWorkerText, json, mapUpstreamError, UpstreamError, withCors } from "../../../../_lib/http";
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

    let deletedUpstream = false;
    try {
      await fetchWorkerText(env, `/api/mail/${mailId}`, { method: "DELETE", jwt: resolved.mailbox.jwt });
      deletedUpstream = true;
    } catch (error) {
      const firstStatus = error instanceof UpstreamError ? error.status : 0;
      if (![400, 404, 405, 501].includes(firstStatus)) throw error;
      try {
        await fetchWorkerText(env, `/api/mails/${mailId}`, { method: "DELETE", jwt: resolved.mailbox.jwt });
        deletedUpstream = true;
      } catch (fallbackError) {
        const fallbackStatus = fallbackError instanceof UpstreamError ? fallbackError.status : 0;
        if (firstStatus === 404 && fallbackStatus === 404) deletedUpstream = true;
        else throw fallbackError;
      }
    }
    if (!deletedUpstream) return withCors(errorJson(502, "邮件服务未确认删除", "mail_delete_not_confirmed"), request, env, "public");

    const share = await updateShareRecord(env, params.token, (payload) => {
      return {
        ...payload,
        addresses: payload.addresses.map((mailbox, index) => {
          const matched = mailbox.id === resolved.mailbox.id || (!mailboxId && index === 0);
          if (!matched) return mailbox;
          const hidden = new Set(mailbox.hiddenMailIds || []);
          hidden.add(mailId);
          const mailCount = Number.isFinite(Number(mailbox.mailCount)) ? Math.max(0, Math.floor(Number(mailbox.mailCount)) - 1) : undefined;
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
