type PagesContext = { request: Request; env: Record<string, unknown> };
type IconCandidate = { url: URL; source: string };
type RateLimitBinding = { limit(input: { key: string }): Promise<{ success: boolean }> };

const MAX_ICON_BYTES = 768 * 1024;
const MAX_HTML_BYTES = 240 * 1024;
const MAX_REDIRECTS = 3;
const TOTAL_DEADLINE_MS = 8_000;
const CACHE_SECONDS = 7 * 24 * 60 * 60;
const NEGATIVE_CACHE_SECONDS = 30 * 60;
const LOCAL_BUCKET_CAPACITY = 60;
const LOCAL_BUCKET_REFILL_PER_SECOND = 1;
const LOCAL_BUCKET_MAX_ENTRIES = 512;
const localBuckets = new Map<string, { tokens: number; updatedAt: number }>();
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif",
  "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml",
]);

class UnsafeTargetError extends Error {}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": `public, max-age=${NEGATIVE_CACHE_SECONDS}, s-maxage=${NEGATIVE_CACHE_SECONDS}`,
      "x-content-type-options": "nosniff",
    },
  });
}

function normalizeHost(value: string) {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/g, "");
}

function parseIpv4(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}

function isPrivateIpv4(value: string) {
  const parts = parseIpv4(value);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0) || a >= 224;
}

function parseIpv6(value: string) {
  let input = normalizeHost(value).split("%")[0];
  if (!input.includes(":")) return null;
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string) => {
    if (!side) return [] as number[];
    const result: number[] = [];
    for (const part of side.split(":")) {
      if (part.includes(".")) {
        const ipv4 = parseIpv4(part);
        if (!ipv4) return null;
        result.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
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

function isIpLiteral(value: string) {
  return Boolean(parseIpv4(value) || parseIpv6(value));
}

function isBlockedHost(value: string) {
  const host = normalizeHost(value);
  return !host || host === "localhost" || host.endsWith(".localhost") || isPrivateIpv4(host) || isPrivateIpv6(host);
}

function normalizeDomain(value: string | null) {
  const raw = normalizeHost(String(value || ""));
  if (!raw || raw.length > 253 || isBlockedHost(raw) || isIpLiteral(raw)) return "";
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(raw)) return "";
  return raw;
}

function normalizeExternalUrl(value: string, base?: URL) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.port || isBlockedHost(url.hostname)) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

async function assertPublicDns(url: URL, signal: AbortSignal) {
  const host = normalizeHost(url.hostname);
  if (isBlockedHost(host)) throw new UnsafeTargetError("blocked host");
  if (isIpLiteral(host)) return;
  const query = async (type: "A" | "AAAA") => {
    const dnsUrl = new URL("https://cloudflare-dns.com/dns-query");
    dnsUrl.searchParams.set("name", host);
    dnsUrl.searchParams.set("type", type);
    const response = await fetch(dnsUrl, { signal, redirect: "error", headers: { accept: "application/dns-json" } });
    if (!response.ok) throw new UnsafeTargetError("DNS lookup failed");
    const data = await response.json() as { Answer?: Array<{ type?: number; data?: string }> };
    return (Array.isArray(data.Answer) ? data.Answer : [])
      .filter((answer) => answer.type === 1 || answer.type === 28)
      .map((answer) => normalizeHost(String(answer.data || "")))
      .filter(Boolean);
  };
  const addresses = (await Promise.all([query("A"), query("AAAA")])).flat();
  if (!addresses.length) throw new UnsafeTargetError("no public DNS answer");
  if (addresses.some((address) => isPrivateIpv4(address) || isPrivateIpv6(address))) {
    throw new UnsafeTargetError("private DNS answer");
  }
}

async function fetchSafe(url: URL, init: RequestInit, signal: AbortSignal) {
  let current = url;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicDns(current, signal);
    const response = await fetch(current, { ...init, signal, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const next = normalizeExternalUrl(response.headers.get("location") || "", current);
    if (!next) throw new UnsafeTargetError("unsafe redirect");
    current = next;
  }
  throw new UnsafeTargetError("too many redirects");
}

async function readStream(body: ReadableStream<Uint8Array>, maxBytes: number, truncate: boolean) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (truncate && remaining > 0) chunks.push(value.slice(0, remaining));
        total += Math.max(0, remaining);
        await reader.cancel().catch(() => undefined);
        if (!truncate) throw new Error("body_too_large");
        break;
      }
      chunks.push(value);
      total += value.byteLength;
      if (truncate && total === maxBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
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

function unquoteDnsTxt(value: string) {
  return value.replace(/^"|"$/g, "").replace(/"\s+"/g, "").replace(/\\"/g, '"');
}

async function findBimiCandidate(domain: string, signal: AbortSignal): Promise<IconCandidate | null> {
  try {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", `default._bimi.${domain}`);
    url.searchParams.set("type", "TXT");
    const response = await fetch(url, { signal, redirect: "error", headers: { accept: "application/dns-json" } });
    if (!response.ok) return null;
    const data = await response.json() as { Answer?: Array<{ data?: string }> };
    for (const answer of Array.isArray(data.Answer) ? data.Answer : []) {
      const txt = unquoteDnsTxt(String(answer.data || ""));
      if (!/\bv\s*=\s*BIMI1\b/i.test(txt)) continue;
      const logo = txt.match(/(?:^|;)\s*l\s*=\s*([^;\s]+)/i)?.[1];
      const iconUrl = logo ? normalizeExternalUrl(logo) : null;
      if (iconUrl) return { url: iconUrl, source: "bimi" };
    }
  } catch {}
  return null;
}

async function findHtmlIconCandidates(domain: string, signal: AbortSignal) {
  const home = normalizeExternalUrl(`https://${domain}/`);
  if (!home) return [] as IconCandidate[];
  try {
    const response = await fetchSafe(home, {
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Loven7-Mail Brand Icon Resolver" },
    }, signal);
    if (!response.ok || !response.body || !(response.headers.get("content-type") || "").toLowerCase().includes("html")) return [];
    const text = new TextDecoder().decode(await readStream(response.body, MAX_HTML_BYTES, true));
    const candidates: IconCandidate[] = [];
    for (const tag of text.match(/<link\b[^>]*>/gi) || []) {
      const rel = tag.match(/\brel\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() || "";
      const href = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (!rel.includes("icon") || !href) continue;
      const responseUrl = normalizeExternalUrl(response.url || home.toString()) || home;
      const iconUrl = normalizeExternalUrl(href, responseUrl);
      if (iconUrl) candidates.push({ url: iconUrl, source: rel.includes("apple") ? "apple-touch-icon" : "html-icon" });
    }
    return candidates.slice(0, 5);
  } catch {
    return [];
  }
}

function baseCandidates(domain: string): IconCandidate[] {
  return [
    `https://${domain}/apple-touch-icon.png`,
    `https://${domain}/apple-touch-icon-precomposed.png`,
    `https://${domain}/favicon.ico`,
    `https://www.${domain}/apple-touch-icon.png`,
    `https://www.${domain}/favicon.ico`,
  ].map((value) => normalizeExternalUrl(value)).filter((url): url is URL => Boolean(url))
    .map((url) => ({ url, source: url.pathname.includes("apple") ? "apple-touch-icon" : "favicon" }));
}

function sniffImageType(bytes: Uint8Array, declared: string) {
  const type = declared.split(";")[0]?.trim().toLowerCase() || "";
  if (ALLOWED_IMAGE_TYPES.has(type)) return type === "image/jpg" ? "image/jpeg" : type;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return "image/x-icon";
  const prefix = new TextDecoder().decode(bytes.slice(0, 256)).trimStart().toLowerCase();
  return prefix.startsWith("<svg") || prefix.includes("<svg") ? "image/svg+xml" : "";
}

function sanitizeSvg(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  const lowered = text.toLowerCase();
  if (lowered.includes("<script") || lowered.includes("<foreignobject") || /\son[a-z]+\s*=/.test(lowered)
    || lowered.includes("javascript:") || /(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/)/i.test(text)) return "";
  return text;
}

async function fetchIcon(candidate: IconCandidate, signal: AbortSignal) {
  try {
    const response = await fetchSafe(candidate.url, {
      headers: { accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", "user-agent": "Loven7-Mail Brand Icon Resolver" },
    }, signal);
    if (!response.ok || !response.body) return null;
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_ICON_BYTES) return null;
    const bytes = await readStream(response.body, MAX_ICON_BYTES, false);
    if (!bytes.byteLength) return null;
    const type = sniffImageType(bytes, response.headers.get("content-type") || "");
    if (!type || !ALLOWED_IMAGE_TYPES.has(type)) return null;
    const body: BodyInit = type === "image/svg+xml" ? sanitizeSvg(bytes) : bytes;
    if (!body) return null;
    return new Response(body, { headers: {
      "content-type": type,
      "cache-control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, immutable`,
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "x-loven7-brand-source": candidate.source,
    } });
  } catch {
    return null;
  }
}

async function resolveIcon(domain: string, signal: AbortSignal) {
  const [bimi, html] = await Promise.all([findBimiCandidate(domain, signal), findHtmlIconCandidates(domain, signal)]);
  const candidates = [...(bimi ? [bimi] : []), ...html, ...baseCandidates(domain)];
  const tried = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.url.toString();
    if (tried.has(key)) continue;
    tried.add(key);
    const icon = await fetchIcon(candidate, signal);
    if (icon) return icon;
  }
  return null;
}

async function checkRateLimit(request: Request, env: Record<string, unknown>) {
  const limiter = env.ASSET_PROXY_RATE_LIMITER as RateLimitBinding | undefined;
  const client = request.headers.get("cf-connecting-ip") || "anonymous";
  if (limiter?.limit) return (await limiter.limit({ key: `brand-icon:${client}` })).success;
  const now = Date.now();
  const bucket = localBuckets.get(client) || { tokens: LOCAL_BUCKET_CAPACITY, updatedAt: now };
  bucket.tokens = Math.min(
    LOCAL_BUCKET_CAPACITY,
    bucket.tokens + Math.max(0, now - bucket.updatedAt) / 1000 * LOCAL_BUCKET_REFILL_PER_SECOND,
  );
  bucket.updatedAt = now;
  if (bucket.tokens < 1) {
    localBuckets.delete(client);
    localBuckets.set(client, bucket);
    return false;
  }
  bucket.tokens -= 1;
  localBuckets.delete(client);
  localBuckets.set(client, bucket);
  while (localBuckets.size > LOCAL_BUCKET_MAX_ENTRIES) {
    const oldest = localBuckets.keys().next().value as string | undefined;
    if (!oldest) break;
    localBuckets.delete(oldest);
  }
  return true;
}

function requestDeadlineMs(env: Record<string, unknown>) {
  const configured = Number(env.ASSET_PROXY_DEADLINE_MS);
  if (!Number.isFinite(configured) || configured <= 0) return TOTAL_DEADLINE_MS;
  return Math.min(TOTAL_DEADLINE_MS, Math.max(50, Math.floor(configured)));
}

export const onRequestGet = async ({ request, env }: PagesContext) => {
  try {
    if (!await checkRateLimit(request, env as Record<string, unknown>)) return jsonError(429, "请求过于频繁");
  } catch {
    return jsonError(503, "图标限流服务暂不可用");
  }
  const domain = normalizeDomain(new URL(request.url).searchParams.get("domain"));
  if (!domain) return jsonError(400, "domain 参数无效");

  const cache = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default || null : null;
  const cacheUrl = new URL("/api/brand-icon", request.url);
  cacheUrl.search = new URLSearchParams({ v: "3", domain }).toString();
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestDeadlineMs(env as Record<string, unknown>));
  try {
    const icon = await resolveIcon(domain, controller.signal);
    const response = icon || jsonError(404, "未找到可用品牌图标");
    await cache?.put(cacheKey, response.clone()).catch(() => undefined);
    return response;
  } catch {
    return jsonError(controller.signal.aborted ? 504 : 404, controller.signal.aborted ? "品牌图标请求超时" : "未找到可用品牌图标");
  } finally {
    clearTimeout(timeout);
  }
};
