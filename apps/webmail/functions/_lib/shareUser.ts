import { buildUserWorkerHeaders, fetchWorkerJsonWithHeaders } from "./http";
import type { ShareAdminSummary, SharePayload } from "./share";
import type { CloudmailEnv } from "./types";

type UserBoundAddress = {
  id?: unknown;
  name?: unknown;
  address?: unknown;
};

function normalizeAddress(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : "";
}

function sameAddress(left: unknown, right: unknown) {
  const normalizedLeft = normalizeAddress(left);
  const normalizedRight = normalizeAddress(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export async function getAllowedShareAddresses(env: CloudmailEnv, userToken: string) {
  return (await getShareUserContext(env, userToken)).allowed;
}

export async function getShareUserContext(env: CloudmailEnv, userToken: string) {
  const headers = buildUserWorkerHeaders(env, userToken);
  const [raw, profileRaw] = await Promise.all([
    fetchWorkerJsonWithHeaders<{ results?: UserBoundAddress[] } | UserBoundAddress[]>(
      env,
      "/user_api/bind_address",
      headers
    ),
    fetchWorkerJsonWithHeaders<Record<string, unknown>>(env, "/user_api/settings", headers),
  ]);
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : [];
  const allowed = new Map<string, string>();
  for (const row of rows) {
    const id = String(row.id || "").trim();
    const address = normalizeAddress(row.name || row.address);
    if (id && address) allowed.set(id, address);
  }
  const userId = String(profileRaw?.user_id || profileRaw?.userId || "").trim();
  return { allowed, userId };
}

export function shareBelongsToUser(
  share: Pick<SharePayload | ShareAdminSummary, "addresses" | "creatorUserId">,
  allowed: Map<string, string>,
  requesterUserId = "",
) {
  if (share.creatorUserId) return Boolean(requesterUserId && share.creatorUserId === requesterUserId);
  if (!share.addresses.length) return false;
  return share.addresses.every((mailbox) => {
    const allowedAddress = allowed.get(String(mailbox.id));
    return Boolean(allowedAddress && sameAddress(allowedAddress, mailbox.address));
  });
}
