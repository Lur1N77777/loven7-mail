import { corsHeaders, errorJson, json, withCors } from "../../_lib/http";
import { publicShare, readShareRecord, shareError, shareInactiveError, shareStatus } from "../../_lib/share";
import type { PagesHandler } from "../../_lib/types";

export const onRequestOptions: PagesHandler<{ token: string }> = ({ request, env }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request, env, "public") });
};

export const onRequestGet: PagesHandler<{ token: string }> = async ({ request, env, params }) => {
  try {
    const share = await readShareRecord(env, params.token);
    if (!share) return withCors(errorJson(404, "共享链接不存在", "share_not_found"), request, env, "public");
    const status = shareStatus(share);
    if (status !== "active") return withCors(shareInactiveError(status), request, env, "public");
    return withCors(json(publicShare(params.token, share)), request, env, "public");
  } catch (error) {
    return withCors(shareError(error), request, env, "public");
  }
};
