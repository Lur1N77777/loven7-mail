import type { SafeSettings, WebmailSession } from "./types";

const SESSION_KEY = "loven7_mail_session_v1";
const LEGACY_SESSION_KEY = "cloudmail_webmail_session_v1";

function hashParams(hash: string): URLSearchParams {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
}

export function readJwtFromHref(href: string): string {
  const url = new URL(href, "https://mail.invalid/");
  const fragment = hashParams(url.hash);
  return fragment.get("JWT") || fragment.get("jwt") || url.searchParams.get("JWT") || url.searchParams.get("jwt") || "";
}

export function clearJwtFromHref(href: string): string {
  const url = new URL(href, "https://mail.invalid/");
  url.searchParams.delete("JWT");
  url.searchParams.delete("jwt");
  const fragment = hashParams(url.hash);
  fragment.delete("JWT");
  fragment.delete("jwt");
  const fragmentText = fragment.toString();
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${fragmentText ? `#${fragmentText}` : ""}` || "/";
}

export function readJwtFromUrl(): string {
  return readJwtFromHref(window.location.href);
}

export function clearJwtFromUrl() {
  window.history.replaceState(null, document.title, clearJwtFromHref(window.location.href));
}

export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function currentApiOrigin(): string {
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin.toLowerCase();
  return "same-origin";
}

export async function buildSessionCacheKey(apiOrigin: string, address: string, credential: string): Promise<string> {
  const origin = String(apiOrigin || "same-origin").trim().replace(/\/+$/, "").toLowerCase();
  const subject = String(address || "current").trim().toLowerCase();
  return hashToken(`v2\0${origin}\0${subject}\0${credential}`);
}

type StoredSession = {
  jwt: string;
  address: string;
  settings?: SafeSettings;
  apiOrigin?: string;
};

export function saveSession(session: WebmailSession) {
  const value: StoredSession = {
    jwt: session.jwt,
    address: session.address,
    settings: session.settings,
    apiOrigin: currentApiOrigin(),
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
    const apiOrigin = currentApiOrigin();
    if (parsed.apiOrigin && parsed.apiOrigin !== apiOrigin) return null;
    return {
      ...parsed,
      cacheKey: await buildSessionCacheKey(apiOrigin, parsed.address, parsed.jwt),
    };
  } catch {
    return null;
  }
}

export function clearStoredSession() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(LEGACY_SESSION_KEY);
}
