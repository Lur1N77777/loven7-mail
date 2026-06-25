import { errorJson } from "../../../_lib/http";
import type { PagesHandler } from "../../../_lib/types";
import { fetchWorkerJson, json, userEndpoint } from "../../../_lib/user";

type LoginUrlResponse = {
  url?: string;
};

export const onRequestGet: PagesHandler = async ({ request, env }) =>
  userEndpoint(async () => {
    const url = new URL(request.url);
    const clientID = url.searchParams.get("clientID")?.trim() || "";
    const state = url.searchParams.get("state")?.trim() || "";
    if (!clientID || !state) return errorJson(400, "OAuth 参数不完整", "missing_oauth_params");

    const search = new URLSearchParams({ clientID, state });
    const result = await fetchWorkerJson<LoginUrlResponse>(env, "/user_api/oauth2/login_url", { search });
    const loginUrl = String(result?.url || "").trim();
    if (!loginUrl) return errorJson(502, "OAuth 登录地址为空", "missing_oauth_url");

    return json({ ok: true, url: loginUrl });
  });
