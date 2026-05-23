import {
  decodeJwtAddress,
  errorJson,
  fetchWorkerJson,
  fetchWorkerText,
  json,
  mapUpstreamError,
  sanitizeSettings,
  UpstreamError,
} from "../_lib/http";
import type { PagesHandler } from "../_lib/types";

type SessionRequestBody = {
  JWT?: unknown;
  jwt?: unknown;
  credential?: unknown;
  email?: unknown;
  password?: unknown;
};

type AddressLoginResponse = {
  jwt?: string;
  address?: string;
};

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sameAddress(a?: string, b?: string) {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

async function validateCredential(env: Parameters<PagesHandler>[0]["env"], jwt: string) {
  try {
    await fetchWorkerText(env, "/open_api/credential_login", {
      method: "POST",
      body: { credential: jwt },
    });
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 0;
    if (![404, 405, 501].includes(status)) throw error;
  }

  const fallbackAddress = decodeJwtAddress(jwt);
  const settingsRaw = await fetchWorkerJson<unknown>(env, "/api/settings", { jwt });
  const settings = sanitizeSettings(settingsRaw, fallbackAddress);
  return json({ ok: true, jwt, address: settings.address || fallbackAddress, settings });
}

async function loginAddressPassword(env: Parameters<PagesHandler>[0]["env"], email: string, password: string) {
  const hashedPassword = await sha256Hex(password);
  const loginBody = await fetchWorkerJson<AddressLoginResponse>(env, "/api/address_login", {
    method: "POST",
    body: { email, password: hashedPassword },
  });

  const jwt = String(loginBody?.jwt || "").trim();
  if (!jwt) return errorJson(401, "邮箱或密码错误", "invalid_login");

  const fallbackAddress = loginBody.address || email;
  const settingsRaw = await fetchWorkerJson<unknown>(env, "/api/settings", { jwt });
  const settings = sanitizeSettings(settingsRaw, fallbackAddress);
  const resolvedAddress = settings.address || fallbackAddress;

  if (resolvedAddress && !sameAddress(resolvedAddress, email)) {
    return errorJson(403, "登录邮箱与凭证不匹配", "address_mismatch");
  }

  return json({ ok: true, jwt, address: resolvedAddress, settings });
}

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  const body = (await request.json().catch(() => null)) as SessionRequestBody | null;
  const jwt = String(body?.JWT || body?.jwt || body?.credential || "").trim();
  const email = String(body?.email || "").trim();
  const password = typeof body?.password === "string" ? body.password : "";

  try {
    if (jwt) return await validateCredential(env, jwt);
    if (!email || !password) return errorJson(400, "请输入邮箱和密码", "missing_login_fields");
    return await loginAddressPassword(env, email, password);
  } catch (error) {
    if (email && error instanceof UpstreamError && [400, 401, 404].includes(error.status)) {
      return errorJson(401, "邮箱或密码错误", "invalid_login");
    }
    return mapUpstreamError(error);
  }
};
