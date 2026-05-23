import { decodeJwtAddress, errorJson, extractJwt, fetchWorkerJson, json, mapUpstreamError, sanitizeSettings } from "../_lib/http";
import type { PagesHandler } from "../_lib/types";

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  try {
    const jwt = extractJwt(request);
    if (!jwt) return errorJson(401, "请使用登录链接打开邮箱", "missing_jwt");
    const raw = await fetchWorkerJson<unknown>(env, "/api/settings", { jwt });
    return json(sanitizeSettings(raw, decodeJwtAddress(jwt)));
  } catch (error) {
    return mapUpstreamError(error);
  }
};
