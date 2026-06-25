import {
  buildUserWorkerHeaders,
  bindCreatedAddress,
  fetchUserProfile,
  fetchWorkerJson,
  fetchWorkerJsonWithHeaders,
  getUserToken,
  json,
  missingUserToken,
  userEndpoint,
} from "../../../_lib/user";
import { errorJson } from "../../../_lib/http";
import type { PagesHandler } from "../../../_lib/types";

type CreateAddressBody = {
  name?: unknown;
  domain?: unknown;
  cf_token?: unknown;
  enableRandomSubdomain?: unknown;
};

type NewAddressResponse = {
  jwt?: string;
  address?: string;
  password?: string | null;
  address_id?: number;
};

function roleDomains(userRole: unknown) {
  if (!userRole || typeof userRole !== "object") return [];
  const domains = (userRole as { domains?: unknown }).domains;
  if (!Array.isArray(domains)) return [];
  return domains.map((domain) => String(domain || "").trim()).filter(Boolean);
}

export const onRequestGet: PagesHandler = ({ request, env }) =>
  userEndpoint(async () => {
    const userToken = getUserToken(request);
    if (!userToken) return missingUserToken();
    const result = await fetchWorkerJsonWithHeaders<unknown>(
      env,
      "/user_api/bind_address",
      buildUserWorkerHeaders(env, userToken)
    );
    return json({ ok: true, ...(result && typeof result === "object" ? result : { results: [] }) });
  });

export const onRequestPost: PagesHandler = async ({ request, env }) =>
  userEndpoint(async () => {
    const userToken = getUserToken(request);
    if (!userToken) return missingUserToken();
    const body = (await request.json().catch(() => null)) as CreateAddressBody | null;
    const name = String(body?.name || "").trim();
    let domain = String(body?.domain || "").trim();
    const cfToken = typeof body?.cf_token === "string" ? body.cf_token : "";
    const enableRandomSubdomain = Boolean(body?.enableRandomSubdomain);
    if (name.length > 64) return errorJson(400, "邮箱名称过长", "address_name_too_long");

    const profile = await fetchUserProfile(env, userToken);
    if (!profile.isAdmin) {
      const allowedDomains = roleDomains(profile.userRole);
      if (allowedDomains.length) {
        if (domain && !allowedDomains.includes(domain)) return errorJson(403, "当前账号无权使用该域名", "domain_not_allowed");
        domain = domain || allowedDomains[0];
      } else {
        domain = "";
      }
    }

    const created = await fetchWorkerJson<NewAddressResponse>(env, "/api/new_address", {
      method: "POST",
      jwt: userToken,
      body: { name, domain, cf_token: cfToken, enableRandomSubdomain },
    });
    const addressJwt = String(created?.jwt || "").trim();
    if (!addressJwt) return errorJson(500, "邮箱创建成功但缺少登录凭证", "address_jwt_missing");
    await bindCreatedAddress(env, userToken, addressJwt);
    return json({ ok: true, address: created?.address || "", addressId: created?.address_id, password: created?.password || null });
  });
