import {
  buildAddressWorkerHeaders,
  buildBindAddressWorkerHeaders,
  buildUserWorkerHeaders,
  errorJson,
  extractUserToken,
  fetchWorkerJson,
  fetchWorkerJsonWithHeaders,
  json,
  mapUpstreamError,
  sanitizeSettings,
} from "./http";
import type { CloudmailEnv } from "./types";

export type UserProfile = {
  userEmail: string;
  userId?: number;
  isAdmin: boolean;
  userRole?: unknown;
  accessToken?: string;
  newUserToken?: string;
};

export type BoundAddress = {
  id: number;
  name: string;
  mail_count?: number;
  send_count?: number;
  created_at?: string;
  updated_at?: string;
};

type UpstreamUserSettings = {
  user_email?: string;
  user_id?: number;
  is_admin?: boolean;
  user_role?: unknown;
  access_token?: string | null;
  new_user_token?: string | null;
};

type AddressJwtResponse = {
  jwt?: string;
};

export async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function getUserToken(request: Request) {
  return extractUserToken(request);
}

export function missingUserToken() {
  return errorJson(401, "请先登录账号", "missing_user_token");
}

export function normalizeProfile(raw: UpstreamUserSettings): UserProfile {
  return {
    userEmail: String(raw.user_email || ""),
    userId: typeof raw.user_id === "number" ? raw.user_id : undefined,
    isAdmin: Boolean(raw.is_admin),
    userRole: raw.user_role,
    accessToken: raw.access_token ? String(raw.access_token) : undefined,
    newUserToken: raw.new_user_token ? String(raw.new_user_token) : undefined,
  };
}

export async function fetchUserProfile(env: CloudmailEnv, userToken: string) {
  const raw = await fetchWorkerJsonWithHeaders<UpstreamUserSettings>(
    env,
    "/user_api/settings",
    buildUserWorkerHeaders(env, userToken)
  );
  return normalizeProfile(raw || {});
}

export async function fetchAddressJwt(env: CloudmailEnv, userToken: string, addressId: string | number) {
  const raw = await fetchWorkerJsonWithHeaders<AddressJwtResponse>(
    env,
    `/user_api/bind_address_jwt/${encodeURIComponent(String(addressId))}`,
    buildUserWorkerHeaders(env, userToken)
  );
  const jwt = String(raw?.jwt || "").trim();
  if (!jwt) throw new Error("Address JWT missing");
  return jwt;
}

export async function createAddressSession(env: CloudmailEnv, userToken: string, addressId: string | number) {
  const profile = await fetchUserProfile(env, userToken);
  const addressJwt = await fetchAddressJwt(env, userToken, addressId);
  const settingsRaw = await fetchWorkerJsonWithHeaders<unknown>(
    env,
    "/api/settings",
    buildAddressWorkerHeaders(env, addressJwt, profile.accessToken)
  );
  const settings = sanitizeSettings(settingsRaw);
  return {
    ok: true,
    jwt: addressJwt,
    address: settings.address || "",
    addressId: Number(addressId),
    settings,
    user: profile,
  };
}

export async function bindCreatedAddress(env: CloudmailEnv, userToken: string, addressJwt: string) {
  await fetchWorkerJsonWithHeaders<unknown>(
    env,
    "/user_api/bind_address",
    buildBindAddressWorkerHeaders(env, userToken, addressJwt, true),
    { method: "POST", body: {} }
  );
}

export async function userEndpoint(handler: () => Promise<Response>) {
  try {
    return await handler();
  } catch (error) {
    return mapUpstreamError(error);
  }
}

export { fetchWorkerJson, fetchWorkerJsonWithHeaders, buildUserWorkerHeaders, buildAddressWorkerHeaders, json };
