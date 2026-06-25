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
  const raw = await fetchWorkerJsonWithHeaders<{ results?: UserBoundAddress[] } | UserBoundAddress[]>(
    env,
    "/user_api/bind_address",
    buildUserWorkerHeaders(env, userToken)
  );
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : [];
  const allowed = new Map<string, string>();
  for (const row of rows) {
    const id = String(row.id || "").trim();
    const address = normalizeAddress(row.name || row.address);
    if (id && address) allowed.set(id, address);
  }
  return allowed;
}

export function shareBelongsToUser(share: Pick<SharePayload | ShareAdminSummary, "addresses">, allowed: Map<string, string>) {
  if (!share.addresses.length) return false;
  return share.addresses.every((mailbox) => {
    const allowedAddress = allowed.get(String(mailbox.id));
    return Boolean(allowedAddress && sameAddress(allowedAddress, mailbox.address));
  });
}
