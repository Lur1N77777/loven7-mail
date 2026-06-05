import type { MailPage, SafeSettings, SessionResponse, ShareInfo } from "./types";

function currentLocale() {
  if (typeof document !== "undefined" && document.documentElement.dataset.locale === "en-US") return "en-US";
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("loven7.locale") === "en-US") return "en-US";
  } catch {
    // ignore storage access failures
  }
  return "zh-CN";
}

function friendlyErrorMessage(code: string, message: string) {
  const locale = currentLocale();
  const isEnglish = locale === "en-US";
  const raw = String(message || "");
  if (code === "mail_worker_not_configured" || /MAIL_WORKER_BASE_URL/i.test(raw)) {
    return isEnglish
      ? "The mailbox API is not configured. Set MAIL_WORKER_BASE_URL in Cloudflare Pages, then redeploy."
      : "邮箱 API 未配置。请在 Cloudflare Pages 环境变量中填写 MAIL_WORKER_BASE_URL 后重新部署。";
  }
  if (code === "share_kv_not_configured") {
    return isEnglish
      ? "Sharing is not configured. Bind SHARE_KV in Cloudflare Pages, then redeploy."
      : "共享功能未完成配置。请在 Cloudflare Pages 为 Webmail 绑定 SHARE_KV 后重新部署。";
  }
  if (code === "share_secret_not_configured") {
    return isEnglish
      ? "Sharing is not configured. Set SHARE_ENCRYPTION_SECRET in Cloudflare Pages, then redeploy."
      : "共享功能未完成配置。请在 Cloudflare Pages 设置 SHARE_ENCRYPTION_SECRET 后重新部署。";
  }
  if (code === "share_not_configured" || /SHARE_KV|SHARE_ENCRYPTION_SECRET/i.test(raw)) {
    return isEnglish
      ? "Sharing is not configured. Bind SHARE_KV and set SHARE_ENCRYPTION_SECRET in Cloudflare Pages, then redeploy."
      : "共享功能未配置。请在 Cloudflare Pages 绑定 SHARE_KV，并设置 SHARE_ENCRYPTION_SECRET 后重新部署。";
  }
  return raw || (isEnglish ? "Request failed" : "请求失败");
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text ? { message: text } : null;
  }
  if (!response.ok) {
    const code = String(data?.error?.code || "");
    const message = data?.error?.message || data?.message || "";
    throw new Error(friendlyErrorMessage(code, message));
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
export type RequestOptions = { signal?: AbortSignal };

export async function createSession(input: SessionLoginInput, options: RequestOptions = {}): Promise<SessionResponse> {
  const body = typeof input === "string" ? { JWT: input } : input;
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  return parseResponse<SessionResponse>(response);
}

export async function fetchSafeSettings(jwt: string, options: RequestOptions = {}): Promise<SafeSettings> {
  const response = await fetch("/api/settings", {
    headers: authHeaders(jwt),
    cache: "no-store",
    signal: options.signal,
  });
  return parseResponse<SafeSettings>(response);
}

export async function fetchMailPage(jwt: string, limit: number, offset: number, options: RequestOptions = {}): Promise<MailPage> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const response = await fetch(`/api/mails?${params.toString()}`, {
    headers: authHeaders(jwt),
    cache: "no-store",
    signal: options.signal,
  });
  return parseResponse<MailPage>(response);
}

export async function fetchShareInfo(token: string, options: RequestOptions = {}): Promise<ShareInfo> {
  const response = await fetch(`/api/share/${encodeURIComponent(token)}`, { cache: "no-store", signal: options.signal });
  return parseResponse<ShareInfo>(response);
}

export async function fetchShareSettings(token: string, mailboxId: string, options: RequestOptions = {}): Promise<SafeSettings> {
  const params = new URLSearchParams({ mailbox: mailboxId });
  const response = await fetch(`/api/share/${encodeURIComponent(token)}/settings?${params.toString()}`, { cache: "no-store", signal: options.signal });
  return parseResponse<SafeSettings>(response);
}

export async function fetchShareMailPage(token: string, mailboxId: string, limit: number, offset: number, options: RequestOptions = {}): Promise<MailPage> {
  const params = new URLSearchParams({ mailbox: mailboxId, limit: String(limit), offset: String(offset) });
  const response = await fetch(`/api/share/${encodeURIComponent(token)}/mails?${params.toString()}`, { cache: "no-store", signal: options.signal });
  return parseResponse<MailPage>(response);
}

export async function hideSharedMail(token: string, mailboxId: string, mailId: number, options: RequestOptions = {}): Promise<void> {
  const params = new URLSearchParams({ mailbox: mailboxId });
  const response = await fetch(`/api/share/${encodeURIComponent(token)}/mail/${mailId}?${params.toString()}`, { method: "DELETE", signal: options.signal });
  await parseResponse<{ ok: boolean }>(response);
}

export async function deleteMail(jwt: string, mailId: number, options: RequestOptions = {}): Promise<void> {
  const response = await fetch(`/api/mail/${mailId}`, {
    method: "DELETE",
    headers: authHeaders(jwt),
    signal: options.signal,
  });
  await parseResponse<{ ok: boolean }>(response);
}
