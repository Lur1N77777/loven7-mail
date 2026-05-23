import { corsHeaders, errorJson, json, withCors } from "../../../../_lib/http";
import { shareError, updateShareRecord } from "../../../../_lib/share";
import type { PagesHandler } from "../../../../_lib/types";

export const onRequestOptions: PagesHandler<{ token: string; id: string }> = ({ request }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
};

export const onRequestDelete: PagesHandler<{ token: string; id: string }> = async ({ request, env, params }) => {
  try {
    const url = new URL(request.url);
    const mailboxId = url.searchParams.get("mailbox") || "";
    const mailId = Number.parseInt(String(params.id || ""), 10);
    if (!Number.isFinite(mailId) || mailId <= 0) return withCors(errorJson(400, "邮件 ID 无效", "invalid_mail_id"), request);
    const share = await updateShareRecord(env, params.token, (payload) => {
      if (!payload.permissions.hideMail) throw new Error("此共享链接不允许删除邮件显示");
      return {
        ...payload,
        addresses: payload.addresses.map((mailbox, index) => {
          const matched = mailboxId ? mailbox.id === mailboxId : index === 0;
          if (!matched) return mailbox;
          const hidden = new Set(mailbox.hiddenMailIds || []);
          hidden.add(mailId);
          return { ...mailbox, hiddenMailIds: Array.from(hidden).slice(-1000) };
        }),
        updatedAt: new Date().toISOString(),
      };
    });
    if (!share) return withCors(errorJson(404, "共享链接不存在", "share_not_found"), request);
    return withCors(json({ ok: true }), request);
  } catch (error) {
    if (error instanceof Error && error.message.includes("不允许")) return withCors(errorJson(403, error.message, "share_permission_denied"), request);
    return withCors(shareError(error), request);
  }
};
