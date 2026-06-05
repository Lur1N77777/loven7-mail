import { corsHeaders, errorJson, fetchWorkerJson, json, mapUpstreamError, sanitizeSettings, withCors } from "../../../_lib/http";
import { resolveSharedMailbox, shareError } from "../../../_lib/share";
import type { PagesHandler } from "../../../_lib/types";

export const onRequestOptions: PagesHandler<{ token: string }> = ({ request, env }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request, env, "public") });
};

export const onRequestGet: PagesHandler<{ token: string }> = async ({ request, env, params }) => {
  try {
    const url = new URL(request.url);
    const resolved = await resolveSharedMailbox(env, params.token, url.searchParams.get("mailbox") || "");
    if (!resolved) return withCors(errorJson(404, "共享邮箱不存在或链接已失效", "share_mailbox_not_found"), request, env, "public");
    const raw = await fetchWorkerJson<unknown>(env, "/api/settings", { jwt: resolved.mailbox.jwt });
    return withCors(json(sanitizeSettings(raw, resolved.mailbox.address)), request, env, "public");
  } catch (error) {
    const response = shareError(error);
    if (response.status !== 500) return withCors(response, request, env, "public");
    return withCors(mapUpstreamError(error), request, env, "public");
  }
};
