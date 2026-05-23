import { corsHeaders, errorJson, json, withCors } from "../../../_lib/http";
import { assertShareAdmin, listShareRecords, shareError } from "../../../_lib/share";
import type { PagesHandler } from "../../../_lib/types";

function clampNumber(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const onRequestOptions: PagesHandler = ({ request }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
};

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  try {
    await assertShareAdmin(request, env);
    const url = new URL(request.url);
    const result = await listShareRecords(env, {
      request,
      limit: clampNumber(url.searchParams.get("limit"), 20, 1, 100),
      cursor: url.searchParams.get("cursor") || undefined,
      status: url.searchParams.get("status") || undefined,
      query: url.searchParams.get("query") || undefined,
    });
    return withCors(json({ ok: true, ...result }), request);
  } catch (error) {
    if (error instanceof Error && error.message === "缺少管理员凭证") {
      return withCors(errorJson(401, "缺少管理员凭证", "missing_admin_auth"), request);
    }
    return withCors(shareError(error), request);
  }
};
