import { errorJson, extractJwt, fetchWorkerJson, json, mapUpstreamError, normalizeMailPage } from "../_lib/http";
import type { PagesHandler } from "../_lib/types";

function clampNumber(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  try {
    const jwt = extractJwt(request);
    if (!jwt) return errorJson(401, "请使用登录链接打开邮箱", "missing_jwt");
    const url = new URL(request.url);
    const search = new URLSearchParams();
    search.set("limit", String(clampNumber(url.searchParams.get("limit"), 50, 1, 100)));
    search.set("offset", String(clampNumber(url.searchParams.get("offset"), 0, 0, 1000000)));
    const raw = await fetchWorkerJson<unknown>(env, "/api/mails", { jwt, search });
    return json(normalizeMailPage(raw));
  } catch (error) {
    return mapUpstreamError(error);
  }
};
