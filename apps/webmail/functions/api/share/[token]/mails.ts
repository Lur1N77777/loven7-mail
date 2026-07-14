import { corsHeaders, errorJson, fetchWorkerJson, json, mapUpstreamError, normalizeMailPage, withCors } from "../../../_lib/http";
import { filterSharedMailPage, resolveSharedMailbox, shareError } from "../../../_lib/share";
import type { PagesHandler } from "../../../_lib/types";

function clampNumber(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const UPSTREAM_PAGE_SIZE = 100;
const MAX_UPSTREAM_SCAN_PAGES = 48;

export const onRequestOptions: PagesHandler<{ token: string }> = ({ request, env }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request, env, "public") });
};

export const onRequestGet: PagesHandler<{ token: string }> = async ({ request, env, params }) => {
  try {
    const url = new URL(request.url);
    const resolved = await resolveSharedMailbox(env, params.token, url.searchParams.get("mailbox") || "");
    if (!resolved) return withCors(errorJson(404, "共享邮箱不存在或链接已失效", "share_mailbox_not_found"), request, env, "public");

    const limit = clampNumber(url.searchParams.get("limit"), 50, 1, 100);
    const visibleOffset = clampNumber(url.searchParams.get("offset"), 0, 0, 1000000);
    const visibleNeeded = visibleOffset + limit + 1;
    const visible: unknown[] = [];
    let rawOffset = 0;
    let exhausted = false;

    for (let pageIndex = 0; pageIndex < MAX_UPSTREAM_SCAN_PAGES && visible.length < visibleNeeded; pageIndex += 1) {
      const search = new URLSearchParams({ limit: String(UPSTREAM_PAGE_SIZE), offset: String(rawOffset) });
      const raw = await fetchWorkerJson<unknown>(env, "/api/mails", { jwt: resolved.mailbox.jwt, search });
      const upstream = normalizeMailPage(raw);
      const filtered = filterSharedMailPage(upstream, resolved.mailbox, resolved.share);
      visible.push(...filtered.results);
      rawOffset += upstream.results.length;
      if (upstream.results.length < UPSTREAM_PAGE_SIZE) {
        exhausted = true;
        break;
      }
    }

    if (!exhausted && visible.length < visibleNeeded) {
      return withCors(errorJson(503, "共享邮箱邮件过多，请缩小分页范围后重试", "share_mail_scan_limit"), request, env, "public");
    }

    const results = visible.slice(visibleOffset, visibleOffset + limit);
    const hasMore = visible.length > visibleOffset + results.length || !exhausted;
    const count = exhausted
      ? visible.length
      : visibleOffset + results.length + (hasMore ? 1 : 0);
    return withCors(json({ results, count, hasMore }), request, env, "public");
  } catch (error) {
    const response = shareError(error);
    if (response.status !== 500) return withCors(response, request, env, "public");
    return withCors(mapUpstreamError(error), request, env, "public");
  }
};
