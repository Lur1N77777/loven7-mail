import { errorJson, withSecurityHeaders } from "../_lib/http";
import type { PagesHandler } from "../_lib/types";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 12_000;
const CACHE_VERSION = "2";
const NEGATIVE_CACHE_SECONDS = 5 * 60;
const LOCAL_BUCKET_CAPACITY = 60;
const LOCAL_BUCKET_REFILL_PER_SECOND = 1;
const LOCAL_BUCKET_MAX_ENTRIES = 512;
const localBuckets = new Map<string, { tokens: number; updatedAt: number }>();
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

type RateLimitBinding = { limit(input: { key: string }): Promise<{ success: boolean }> };

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

function parseIpv6(value: string) {
  let input = normalizeHostname(value).split("%")[0];
  if (!input.includes(":")) return null;
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string) => {
    if (!side) return [] as number[];
    const result: number[] = [];
    for (const part of side.split(":")) {
      if (part.includes(".")) {
        const match = part.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (!match || match.slice(1).some((item) => Number(item) > 255)) return null;
        const bytes = match.slice(1).map(Number);
        result.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
        result.push(Number.parseInt(part, 16));
      }
    }
    return result;
  };
  const left = parseSide(halves[0]);
  const right = parseSide(halves[1] || "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

function isPrivateIpv6(value: string) {
  const words = parseIpv6(value);
  if (!words) return false;
  if (words.every((word) => word === 0) || (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)) return true;
  if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00) return true;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const mapped = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
    return isPrivateIpv4(mapped);
  }
  return words[0] === 0x2001 && words[1] === 0x0db8;
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

async function assertPublicDnsTarget(url: URL, signal: AbortSignal) {
  const hostname = normalizeHostname(url.hostname);
  const providers = ["https://1.1.1.1/dns-query", "https://1.0.0.1/dns-query"];
  const query = async (provider: string, type: "A" | "AAAA") => {
    const dnsUrl = new URL(provider);
    dnsUrl.searchParams.set("name", hostname);
    dnsUrl.searchParams.set("type", type);
    const response = await fetch(dnsUrl.toString(), {
      signal,
      redirect: "manual",
      headers: { accept: "application/dns-json" },
    });
    if (!response.ok) throw new Error("dns provider unavailable");
    const data = await response.json() as { Answer?: Array<{ type?: number; data?: string }> };
    return (Array.isArray(data.Answer) ? data.Answer : [])
      .filter((answer) => answer.type === 1 || answer.type === 28)
      .map((answer) => normalizeHostname(String(answer.data || "")))
      .filter(Boolean);
  };
  const answers = await Promise.allSettled(
    providers.flatMap((provider) => ["A", "AAAA"].map((type) => query(provider, type as "A" | "AAAA"))),
  );
  const addresses = answers.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (!addresses.length) {
    throw imageProxyError(502, "图片域名解析失败", "image_dns_failed");
  }
  if (addresses.some((address) => isPrivateIpv4(address) || isPrivateIpv6(address))) {
    throw imageProxyError(400, "图片地址无效", "bad_image_url");
  }
}

async function fetchImageFollowingSafeRedirects(imageUrl: URL, signal: AbortSignal) {
  let current = imageUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertPublicDnsTarget(current, signal);
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

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkRateLimit(request: Request, env: Record<string, unknown>) {
  const limiter = env.ASSET_PROXY_RATE_LIMITER as RateLimitBinding | undefined;
  const client = request.headers.get("cf-connecting-ip") || "anonymous";
  if (limiter?.limit) return (await limiter.limit({ key: `image-proxy:${client}` })).success;

  const now = Date.now();
  const current = localBuckets.get(client) || { tokens: LOCAL_BUCKET_CAPACITY, updatedAt: now };
  const elapsedSeconds = Math.max(0, now - current.updatedAt) / 1000;
  current.tokens = Math.min(LOCAL_BUCKET_CAPACITY, current.tokens + elapsedSeconds * LOCAL_BUCKET_REFILL_PER_SECOND);
  current.updatedAt = now;
  if (current.tokens < 1) {
    localBuckets.delete(client);
    localBuckets.set(client, current);
    return false;
  }
  current.tokens -= 1;
  localBuckets.delete(client);
  localBuckets.set(client, current);
  while (localBuckets.size > LOCAL_BUCKET_MAX_ENTRIES) {
    const oldest = localBuckets.keys().next().value as string | undefined;
    if (!oldest) break;
    localBuckets.delete(oldest);
  }
  return true;
}

async function putCache(cache: Cache | null, key: Request, response: Response, maxAgeSeconds: number) {
  if (!cache) return;
  const headers = new Headers(response.headers);
  headers.set("cache-control", `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}`);
  const stored = new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  await cache.put(key, stored).catch(() => undefined);
}

function requestDeadlineMs(env: Record<string, unknown>) {
  const configured = Number(env.ASSET_PROXY_DEADLINE_MS);
  if (!Number.isFinite(configured) || configured <= 0) return FETCH_TIMEOUT_MS;
  return Math.min(FETCH_TIMEOUT_MS, Math.max(50, Math.floor(configured)));
}

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  try {
    if (!await checkRateLimit(request, env as Record<string, unknown>)) return errorJson(429, "请求过于频繁", "rate_limited");
  } catch {
    return errorJson(503, "图片限流服务暂不可用", "rate_limiter_unavailable");
  }
  const requestUrl = new URL(request.url);
  const imageUrl = normalizeImageUrl(requestUrl.searchParams.get("url"));
  if (!imageUrl) return errorJson(400, "图片地址无效", "bad_image_url");

  const cache = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default || null : null;
  const cacheUrl = new URL("/api/image", request.url);
  cacheUrl.search = new URLSearchParams({
    v: CACHE_VERSION,
    key: await sha256Hex(imageUrl.toString()),
  }).toString();
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestDeadlineMs(env as Record<string, unknown>));

  try {
    const upstream = await fetchImageFollowingSafeRedirects(imageUrl, controller.signal);

    if (!upstream.ok || !upstream.body) return errorJson(502, "图片加载失败", "image_fetch_failed");

    const length = Number(upstream.headers.get("content-length") || "0");
    if (length > MAX_IMAGE_BYTES) {
      const response = errorJson(413, "图片过大", "image_too_large");
      await putCache(cache, cacheKey, response, NEGATIVE_CACHE_SECONDS);
      return response;
    }
    const bytes = await readBodyWithLimit(upstream.body, MAX_IMAGE_BYTES);
    const contentType = sniffImageType(bytes, upstream.headers.get("content-type") || "");
    if (!contentType || !ALLOWED_IMAGE_TYPES.has(contentType)) {
      const response = errorJson(415, "不是有效图片", "not_image");
      await putCache(cache, cacheKey, response, NEGATIVE_CACHE_SECONDS);
      return response;
    }

    const headers = new Headers({
      "content-type": contentType,
      "cache-control": "no-store, private, max-age=0",
      "pragma": "no-cache",
      "expires": "0",
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
    });

    const response = withSecurityHeaders(new Response(bytes, { status: 200, headers }));
    await putCache(cache, cacheKey, response, 60 * 60);
    return response;
  } catch (error) {
    if (error instanceof ImageProxyError) return errorJson(error.status, error.message, error.code);
    if (controller.signal.aborted) return errorJson(504, "图片加载超时", "image_fetch_timeout");
    return errorJson(502, "图片加载失败", "image_fetch_failed");
  } finally {
    clearTimeout(timeout);
  }
};
