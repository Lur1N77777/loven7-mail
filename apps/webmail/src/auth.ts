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
  savedAt?: number;
};

// A mailbox session outlives the tab that opened it. sessionStorage alone meant
// closing the tab — or the OS reclaiming an installed PWA — silently discarded
// the login, so it is now the per-tab view over a durable localStorage record.
// Only an explicit sign-out or the idle window clears the durable copy.
const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function safeStorage(getStorage: () => Storage): Storage | null {
  try {
    return getStorage();
  } catch {
    // Hardened privacy modes can throw on the accessor itself.
    return null;
  }
}

function writeSessionRecord(storage: Storage | null, value: StoredSession) {
  if (!storage) return;
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(value));
    storage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    // Quota or privacy failures must never break signing in.
  }
}

function readSessionRecord(storage: Storage | null): StoredSession | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SESSION_KEY) || storage.getItem(LEGACY_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export function saveSession(session: WebmailSession) {
  const value: StoredSession = {
    jwt: session.jwt,
    address: session.address,
    settings: session.settings,
    apiOrigin: currentApiOrigin(),
    savedAt: Date.now(),
  };
  writeSessionRecord(safeStorage(() => sessionStorage), value);
  writeSessionRecord(safeStorage(() => localStorage), value);
}

export async function loadStoredSession(): Promise<WebmailSession | null> {
  // The tab's own session wins so a deliberately different login in this tab is
  // never overwritten by the durable one.
  const parsed = readSessionRecord(safeStorage(() => sessionStorage)) ?? readSessionRecord(safeStorage(() => localStorage));
  if (!parsed || !parsed.jwt || !parsed.address) return null;
  const apiOrigin = currentApiOrigin();
  if (parsed.apiOrigin && parsed.apiOrigin !== apiOrigin) return null;
  // Records predating savedAt have no stamp; treat them as fresh rather than
  // signing the user out on upgrade.
  if (parsed.savedAt && Date.now() - parsed.savedAt > SESSION_IDLE_TTL_MS) {
    clearStoredSession();
    return null;
  }
  return {
    ...parsed,
    cacheKey: await buildSessionCacheKey(apiOrigin, parsed.address, parsed.jwt),
  };
}

/** Slide the idle window; a session in daily use must never age out. */
export function touchStoredSession() {
  const parsed = readSessionRecord(safeStorage(() => sessionStorage)) ?? readSessionRecord(safeStorage(() => localStorage));
  if (!parsed?.jwt) return;
  const value: StoredSession = { ...parsed, savedAt: Date.now() };
  writeSessionRecord(safeStorage(() => sessionStorage), value);
  writeSessionRecord(safeStorage(() => localStorage), value);
}

export function clearStoredSession() {
  [safeStorage(() => sessionStorage), safeStorage(() => localStorage)].forEach((storage) => {
    if (!storage) return;
    try {
      storage.removeItem(SESSION_KEY);
      storage.removeItem(LEGACY_SESSION_KEY);
    } catch {
      // ignore storage failures in privacy mode
    }
  });
}
