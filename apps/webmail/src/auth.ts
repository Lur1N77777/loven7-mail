import type { SafeSettings, WebmailSession } from "./types";

const SESSION_KEY = "loven7_mail_session_v1";
const LEGACY_SESSION_KEY = "cloudmail_webmail_session_v1";

export function readJwtFromUrl(): string {
  const url = new URL(window.location.href);
  return url.searchParams.get("JWT") || url.searchParams.get("jwt") || "";
}

export function clearJwtFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("JWT");
  url.searchParams.delete("jwt");
  const search = url.searchParams.toString();
  const clean = `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
  window.history.replaceState(null, document.title, clean || "/");
}

export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type StoredSession = {
  jwt: string;
  address: string;
  settings?: SafeSettings;
};

export function saveSession(session: WebmailSession) {
  const value: StoredSession = {
    jwt: session.jwt,
    address: session.address,
    settings: session.settings,
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
  sessionStorage.removeItem(LEGACY_SESSION_KEY);
}

export async function loadStoredSession(): Promise<WebmailSession | null> {
  const raw = sessionStorage.getItem(SESSION_KEY) || sessionStorage.getItem(LEGACY_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed.jwt || !parsed.address) return null;
    return {
      ...parsed,
      cacheKey: await hashToken(`${parsed.address}:${parsed.jwt}`),
    };
  } catch {
    return null;
  }
}

export function clearStoredSession() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(LEGACY_SESSION_KEY);
}
