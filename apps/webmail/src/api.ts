import type { MailPage, SafeSettings, SessionResponse, ShareInfo } from "./types";

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text ? { message: text } : null;
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || "请求失败";
    throw new Error(message);
  }
  return data as T;
}

function authHeaders(jwt: string) {
  return {
    Authorization: `Bearer ${jwt}`,
    "x-user-token": jwt,
  };
}

export type SessionLoginInput = string | { email: string; password: string };

export async function createSession(input: SessionLoginInput): Promise<SessionResponse> {
  const body = typeof input === "string" ? { JWT: input } : input;
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseResponse<SessionResponse>(response);
}

export async function fetchSafeSettings(jwt: string): Promise<SafeSettings> {
  const response = await fetch("/api/settings", {
    headers: authHeaders(jwt),
    cache: "no-store",
  });
  return parseResponse<SafeSettings>(response);
}

export async function fetchMailPage(jwt: string, limit: number, offset: number): Promise<MailPage> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const response = await fetch(`/api/mails?${params.toString()}`, {
    headers: authHeaders(jwt),
    cache: "no-store",
  });
  return parseResponse<MailPage>(response);
}

export async function fetchShareInfo(token: string): Promise<ShareInfo> {
  const response = await fetch(`/api/share/${encodeURIComponent(token)}`, { cache: "no-store" });
  return parseResponse<ShareInfo>(response);
}

export async function fetchShareSettings(token: string, mailboxId: string): Promise<SafeSettings> {
  const params = new URLSearchParams({ mailbox: mailboxId });
  const response = await fetch(`/api/share/${encodeURIComponent(token)}/settings?${params.toString()}`, { cache: "no-store" });
  return parseResponse<SafeSettings>(response);
}

export async function fetchShareMailPage(token: string, mailboxId: string, limit: number, offset: number): Promise<MailPage> {
  const params = new URLSearchParams({ mailbox: mailboxId, limit: String(limit), offset: String(offset) });
  const response = await fetch(`/api/share/${encodeURIComponent(token)}/mails?${params.toString()}`, { cache: "no-store" });
  return parseResponse<MailPage>(response);
}

export async function hideSharedMail(token: string, mailboxId: string, mailId: number): Promise<void> {
  const params = new URLSearchParams({ mailbox: mailboxId });
  const response = await fetch(`/api/share/${encodeURIComponent(token)}/mail/${mailId}?${params.toString()}`, { method: "DELETE" });
  await parseResponse<{ ok: boolean }>(response);
}

export async function deleteMail(jwt: string, mailId: number): Promise<void> {
  const response = await fetch(`/api/mail/${mailId}`, {
    method: "DELETE",
    headers: authHeaders(jwt),
  });
  await parseResponse<{ ok: boolean }>(response);
}
