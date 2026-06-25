import { errorJson } from "../../../_lib/http";
import type { PagesHandler } from "../../../_lib/types";
import { fetchUserProfile, fetchWorkerJson, json, userEndpoint } from "../../../_lib/user";

type CallbackBody = {
  code?: unknown;
  clientID?: unknown;
};

type CallbackResponse = {
  jwt?: string;
};

export const onRequestPost: PagesHandler = async ({ request, env }) =>
  userEndpoint(async () => {
    const body = (await request.json().catch(() => null)) as CallbackBody | null;
    const code = String(body?.code || "").trim();
    const clientID = String(body?.clientID || "").trim();
    if (!code || !clientID) return errorJson(400, "OAuth 回调参数不完整", "missing_oauth_callback_params");

    const result = await fetchWorkerJson<CallbackResponse>(env, "/user_api/oauth2/callback", {
      method: "POST",
      body: { code, clientID },
    });
    const userToken = String(result?.jwt || "").trim();
    if (!userToken) return errorJson(401, "OAuth 登录失败", "invalid_oauth_login");

    const user = await fetchUserProfile(env, userToken);
    return json({ ok: true, userToken, user });
  });
