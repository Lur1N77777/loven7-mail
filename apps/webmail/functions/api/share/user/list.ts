import { corsHeaders, errorJson, json, withCors } from "../../../_lib/http";
import { listShareRecords, listShareRecordsForAddressIds, shareError } from "../../../_lib/share";
import { getAllowedShareAddresses, shareBelongsToUser } from "../../../_lib/shareUser";
import type { PagesHandler } from "../../../_lib/types";
import { getUserToken, missingUserToken } from "../../../_lib/user";

function clampNumber(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function compareShareOrder(left: { createdAt: string; token: string }, right: { createdAt: string; token: string }) {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
  const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
  if (safeLeft !== safeRight) return safeRight - safeLeft;
  return left.token.localeCompare(right.token);
}

export const onRequestOptions: PagesHandler = ({ request, env }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request, env, "admin") });
};

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  try {
    const userToken = getUserToken(request);
    if (!userToken) return withCors(missingUserToken(), request, env, "admin");
    const allowed = await getAllowedShareAddresses(env, userToken);
    if (allowed.size === 0) return withCors(json({ ok: true, results: [], cursor: null, hasMore: false }), request, env, "admin");
    const url = new URL(request.url);
    const limit = clampNumber(url.searchParams.get("limit"), 20, 1, 100);
    const options = {
      request,
      limit,
      cursor: url.searchParams.get("cursor") || undefined,
      status: url.searchParams.get("status") || undefined,
      query: url.searchParams.get("query") || undefined,
    };
    const indexed = await listShareRecordsForAddressIds(env, Array.from(allowed.keys()), options);
    const results = indexed.results.filter((share) => shareBelongsToUser(share, allowed));
    let cursor: string | null = indexed.cursor;
    let hasMore = indexed.hasMore;

    if (results.length < limit && !String(options.cursor || "").startsWith("addr:")) {
      const fallback = await listShareRecords(env, { ...options, limit: Math.max(100, limit), cursor: options.cursor });
      for (const share of fallback.results) {
        if (results.length >= limit) break;
        if (results.some((item) => item.token === share.token)) continue;
        if (shareBelongsToUser(share, allowed)) results.push(share);
      }
    }

    return withCors(json({ ok: true, results: results.sort(compareShareOrder).slice(0, limit), cursor, hasMore }), request, env, "admin");
  } catch (error) {
    if (error instanceof Error && error.message === "请先登录账号") {
      return withCors(errorJson(401, "请先登录账号", "missing_user_token"), request, env, "admin");
    }
    return withCors(shareError(error), request, env, "admin");
  }
};
