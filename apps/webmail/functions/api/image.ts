import { errorJson, withSecurityHeaders } from "../_lib/http";
import type { PagesHandler } from "../_lib/types";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 12_000;
const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::", "::1"]);
const ALLOWED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/apng",
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

class ImageProxyError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function imageProxyError(status: number, message: string, code: string) {
  return new ImageProxyError(status, message, code);
}

function isPrivateIpv4(hostname: string) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  if (match.slice(1).some((part) => Number(part) > 255)) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function normalizeHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/g, "");
}

function isDomainHostname(hostname: string) {
  const host = normalizeHostname(hostname);
  if (!host || host.length > 253 || host.includes(":")) return false;
  if (isPrivateIpv4(host) || /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  const tld = labels.at(-1) || "";
  return /^[a-z][a-z0-9-]{1,62}$/.test(tld) || /^xn--[a-z0-9-]{2,59}$/.test(tld);
}

function isBlockedHostname(hostname: string) {
  const host = normalizeHostname(hostname);
  return BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || !isDomainHostname(host);
}

function normalizeImageUrl(value: string | null, base?: URL) {
  if (!value) return null;
  if (value.length > 4096) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    if (isBlockedHostname(url.hostname)) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function normalizeImageType(contentType: string) {
  const type = contentType.split(";")[0]?.trim().toLowerCase() || "";
  if (!ALLOWED_IMAGE_TYPES.has(type)) return "";
  return type === "image/jpg" ? "image/jpeg" : type;
}

function sniffImageType(bytes: Uint8Array, declared: string) {
  const declaredType = normalizeImageType(declared);
  if (declaredType) return declaredType;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = new TextDecoder().decode(bytes.slice(8, 16)).toLowerCase();
    if (brand.includes("avif") || brand.includes("avis")) return "image/avif";
  }
  return declaredType;
}

async function readBodyWithLimit(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw imageProxyError(413, "图片过大", "image_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchImageFollowingSafeRedirects(imageUrl: URL, signal: AbortSignal) {
  let current = imageUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(current.toString(), {
      redirect: "manual",
      signal,
      headers: {
        accept: "image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,*/*;q=0.4",
        "user-agent": "Loven7-Mail Image Proxy",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const next = normalizeImageUrl(location, current);
      if (!next) throw imageProxyError(400, "图片地址无效", "bad_image_url");
      current = next;
      continue;
    }

    return response;
  }
  throw imageProxyError(400, "图片重定向过多", "too_many_redirects");
}

export const onRequestGet: PagesHandler = async ({ request }) => {
  const requestUrl = new URL(request.url);
  const imageUrl = normalizeImageUrl(requestUrl.searchParams.get("url"));
  if (!imageUrl) return errorJson(400, "图片地址无效", "bad_image_url");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetchImageFollowingSafeRedirects(imageUrl, controller.signal);

    if (!upstream.ok || !upstream.body) return errorJson(502, "图片加载失败", "image_fetch_failed");

    const length = Number(upstream.headers.get("content-length") || "0");
    if (length > MAX_IMAGE_BYTES) return errorJson(413, "图片过大", "image_too_large");
    const bytes = await readBodyWithLimit(upstream.body, MAX_IMAGE_BYTES);
    const contentType = sniffImageType(bytes, upstream.headers.get("content-type") || "");
    if (!contentType || !ALLOWED_IMAGE_TYPES.has(contentType)) return errorJson(415, "不是有效图片", "not_image");

    const headers = new Headers({
      "content-type": contentType,
      "cache-control": "no-store, private, max-age=0",
      "pragma": "no-cache",
      "expires": "0",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    });

    return withSecurityHeaders(new Response(bytes, { status: 200, headers }));
  } catch (error) {
    if (error instanceof ImageProxyError) return errorJson(error.status, error.message, error.code);
    return errorJson(502, "图片加载失败", "image_fetch_failed");
  } finally {
    clearTimeout(timeout);
  }
};
