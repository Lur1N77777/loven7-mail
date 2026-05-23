import { errorJson, extractJwt, fetchWorkerText, json, mapUpstreamError, UpstreamError } from "../../_lib/http";
import type { PagesHandler } from "../../_lib/types";

export const onRequestDelete: PagesHandler<{ id: string }> = async ({ request, env, params }) => {
  try {
    const jwt = extractJwt(request);
    if (!jwt) return errorJson(401, "请使用登录链接打开邮箱", "missing_jwt");
    const id = String(params.id || "").trim();
    if (!/^\d+$/.test(id)) return errorJson(400, "邮件 ID 无效", "invalid_mail_id");

    try {
      await fetchWorkerText(env, `/api/mail/${id}`, { method: "DELETE", jwt });
    } catch (error) {
      const status = error instanceof UpstreamError ? error.status : 0;
      if (![400, 404, 405, 501].includes(status)) throw error;
      await fetchWorkerText(env, `/api/mails/${id}`, { method: "DELETE", jwt });
    }
    return json({ ok: true });
  } catch (error) {
    return mapUpstreamError(error);
  }
};
