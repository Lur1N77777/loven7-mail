import { corsHeaders, errorJson, fetchWorkerJson, json, mapUpstreamError, withCors } from "../../../_lib/http";
import { filterSharedMailPage, resolveSharedMailbox, shareError } from "../../../_lib/share";
import type { PagesHandler } from "../../../_lib/types";

function clampNumber(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const onRequestOptions: PagesHandler<{ token: string }> = ({ request }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
};

export const onRequestGet: PagesHandler<{ token: string }> = async ({ request, env, params }) => {
  try {
    const url = new URL(request.url);
    const resolved = await resolveSharedMailbox(env, params.token, url.searchParams.get("mailbox") || "");
    if (!resolved) return withCors(errorJson(404, "共享邮箱不存在或链接已失效", "share_mailbox_not_found"), request);

    const search = new URLSearchParams();
    search.set("limit", String(clampNumber(url.searchParams.get("limit"), 50, 1, 100)));
    search.set("offset", String(clampNumber(url.searchParams.get("offset"), 0, 0, 1000000)));
    const raw = await fetchWorkerJson<unknown>(env, "/api/mails", { jwt: resolved.mailbox.jwt, search });
    return withCors(json(filterSharedMailPage(raw, resolved.mailbox, resolved.share)), request);
  } catch (error) {
    const response = shareError(error);
    if (response.status !== 500) return withCors(response, request);
    return withCors(mapUpstreamError(error), request);
  }
};
