import { errorJson } from "../../_lib/http";
import type { PagesHandler } from "../../_lib/types";
import { fetchWorkerJson, json, userEndpoint } from "../../_lib/user";

type VerifyBody = {
  email?: unknown;
  cf_token?: unknown;
};

export const onRequestPost: PagesHandler = async ({ request, env }) =>
  userEndpoint(async () => {
    const body = (await request.json().catch(() => null)) as VerifyBody | null;
    const email = String(body?.email || "").trim();
    const cfToken = typeof body?.cf_token === "string" ? body.cf_token : "";
    if (!email) return errorJson(400, "请输入邮箱", "missing_email");
    const result = await fetchWorkerJson<unknown>(env, "/user_api/verify_code", {
      method: "POST",
      body: { email, cf_token: cfToken },
    });
    return json({ ok: true, result });
  });
