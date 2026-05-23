import { errorJson, withSecurityHeaders } from "../_lib/http";
import type { PagesHandler } from "../_lib/types";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function isPrivateIpv4(hostname: string) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  if (match.slice(1).some((part) => Number(part) > 255)) return true;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function normalizeImageUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(host) || isPrivateIpv4(host)) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function isProbablyImage(contentType: string) {
  const type = contentType.toLowerCase();
  return type.startsWith("image/") || type.includes("svg+xml") || type === "application/octet-stream";
}

export const onRequestGet: PagesHandler = async ({ request }) => {
  const requestUrl = new URL(request.url);
  const imageUrl = normalizeImageUrl(requestUrl.searchParams.get("url"));
  if (!imageUrl) return errorJson(400, "图片地址无效", "bad_image_url");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const upstream = await fetch(imageUrl.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "user-agent": "Loven7-Mail Image Proxy",
      },
    });

    if (!upstream.ok || !upstream.body) return errorJson(502, "图片加载失败", "image_fetch_failed");

    const contentType = upstream.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    if (!isProbablyImage(contentType)) return errorJson(415, "不是有效图片", "not_image");

    const length = Number(upstream.headers.get("content-length") || "0");
    if (length > MAX_IMAGE_BYTES) return errorJson(413, "图片过大", "image_too_large");

    const headers = new Headers({
      "content-type": contentType,
      "cache-control": "no-store, max-age=0",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    });

    return withSecurityHeaders(new Response(upstream.body, { status: 200, headers }));
  } catch {
    return errorJson(502, "图片加载失败", "image_fetch_failed");
  } finally {
    clearTimeout(timeout);
  }
};
