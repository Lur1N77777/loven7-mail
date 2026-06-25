import { UpstreamError, errorJson } from "../../_lib/http";
import type { PagesHandler } from "../../_lib/types";
import { fetchUserProfile, fetchWorkerJson, json, sha256Hex, userEndpoint } from "../../_lib/user";

type LoginBody = {
  email?: unknown;
  password?: unknown;
  cf_token?: unknown;
};

type LoginResponse = {
  jwt?: string;
};

export const onRequestPost: PagesHandler = async ({ request, env }) =>
  userEndpoint(async () => {
    const body = (await request.json().catch(() => null)) as LoginBody | null;
    const email = String(body?.email || "").trim();
    const password = typeof body?.password === "string" ? body.password : "";
    const cfToken = typeof body?.cf_token === "string" ? body.cf_token : "";
    if (!email || !password) return errorJson(400, "请输入邮箱和密码", "missing_login_fields");

    const hashedPassword = await sha256Hex(password);
    const attempts = Array.from(new Set([hashedPassword, password]));
    let lastError: unknown = null;

    for (const attempt of attempts) {
      try {
        const result = await fetchWorkerJson<LoginResponse>(env, "/user_api/login", {
          method: "POST",
          body: { email, password: attempt, cf_token: cfToken },
        });
        const userToken = String(result?.jwt || "").trim();
        if (!userToken) return errorJson(401, "邮箱或密码错误", "invalid_login");
        const user = await fetchUserProfile(env, userToken);
        return json({ ok: true, userToken, user });
      } catch (error) {
        lastError = error;
        if (!(error instanceof UpstreamError) || ![400, 401, 403, 404].includes(error.status)) throw error;
      }
    }

    if (lastError instanceof UpstreamError) return errorJson(401, "邮箱或密码错误", "invalid_login");
    throw lastError;
  });
