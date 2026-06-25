import { errorJson } from "../../_lib/http";
import type { PagesHandler } from "../../_lib/types";
import { fetchUserProfile, fetchWorkerJson, json, sha256Hex, userEndpoint } from "../../_lib/user";

type RegisterBody = {
  email?: unknown;
  password?: unknown;
  code?: unknown;
  cf_token?: unknown;
};

type LoginResponse = {
  jwt?: string;
};

export const onRequestPost: PagesHandler = async ({ request, env }) =>
  userEndpoint(async () => {
    const body = (await request.json().catch(() => null)) as RegisterBody | null;
    const email = String(body?.email || "").trim();
    const password = typeof body?.password === "string" ? body.password : "";
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const cfToken = typeof body?.cf_token === "string" ? body.cf_token : "";
    if (!email || !password) return errorJson(400, "请输入邮箱和密码", "missing_register_fields");

    const hashedPassword = await sha256Hex(password);
    await fetchWorkerJson<unknown>(env, "/user_api/register", {
      method: "POST",
      body: { email, password: hashedPassword, code, cf_token: cfToken },
    });
    const login = await fetchWorkerJson<LoginResponse>(env, "/user_api/login", {
      method: "POST",
      body: { email, password: hashedPassword, cf_token: cfToken },
    });
    const userToken = String(login?.jwt || "").trim();
    if (!userToken) return json({ ok: true, registered: true });
    const user = await fetchUserProfile(env, userToken);
    return json({ ok: true, registered: true, userToken, user });
  });
