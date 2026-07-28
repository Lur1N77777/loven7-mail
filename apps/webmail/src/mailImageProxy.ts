const SAFE_EMBEDDED_IMAGE = /^(?:data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml|x-icon);|blob:|cid:)/i;
const LOCAL_IMAGE_FALLBACKS = new Map([
  ["/images/claude_logo_full.png", "/mail-assets/claude-logo-full.svg"],
  ["/images/ant_logo_full_faded.png", "/mail-assets/anthropic-logo-faded.svg"],
]);

function normalizeOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch {
    return "";
  }
}

export function mailImageAssetOrigin(explicitOrigin?: string) {
  const requested = normalizeOrigin(String(explicitOrigin || ""));
  if (requested) return requested;
  if (typeof window !== "undefined") return normalizeOrigin(window.location.origin);
  return "https://mail.invalid";
}

export function proxyMailImageUrl(value: string, explicitOrigin?: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (SAFE_EMBEDDED_IMAGE.test(raw)) return raw;
  try {
    const target = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if ((target.protocol !== "https:" && target.protocol !== "http:") || target.username || target.password) return "";
    target.hash = "";
    const origin = mailImageAssetOrigin(explicitOrigin);
    if (target.hostname.toLowerCase() === "claude.ai") {
      const fallbackPath = LOCAL_IMAGE_FALLBACKS.get(target.pathname.toLowerCase());
      if (fallbackPath) return `${origin}${fallbackPath}`;
    }
    if (target.origin === origin && target.pathname === "/api/image") return target.toString();
    return `${origin}/api/image?url=${encodeURIComponent(target.toString())}`;
  } catch {
    return "";
  }
}

export function proxyMailImageSrcset(value: string, explicitOrigin?: string) {
  const input = String(value || "");
  const candidates: Array<{ url: string; descriptor: string }> = [];
  let position = 0;

  while (position < input.length) {
    while (position < input.length && /[\s,]/.test(input[position])) position += 1;
    if (position >= input.length) break;

    const urlStart = position;
    while (position < input.length && !/\s/.test(input[position])) position += 1;
    let url = input.slice(urlStart, position);
    const trailingCommas = url.match(/,+$/)?.[0].length || 0;
    if (trailingCommas) {
      url = url.slice(0, -trailingCommas);
      if (url) candidates.push({ url, descriptor: "" });
      continue;
    }

    while (position < input.length && /\s/.test(input[position])) position += 1;
    const descriptorStart = position;
    let parentheses = 0;
    while (position < input.length) {
      const char = input[position];
      if (char === "(") parentheses += 1;
      else if (char === ")" && parentheses > 0) parentheses -= 1;
      else if (char === "," && parentheses === 0) break;
      position += 1;
    }
    candidates.push({ url, descriptor: input.slice(descriptorStart, position).trim() });
    if (input[position] === ",") position += 1;
  }

  return candidates
    .map(({ url, descriptor }) => {
      const proxied = proxyMailImageUrl(url, explicitOrigin);
      return proxied ? [proxied, descriptor].filter(Boolean).join(" ") : "";
    })
    .filter(Boolean)
    .join(", ");
}

export function proxyMailImageCss(value: string, explicitOrigin?: string) {
  return String(value || "").replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, quote, url) => {
    const proxied = proxyMailImageUrl(url, explicitOrigin);
    return proxied ? `url(${quote || ""}${proxied}${quote || ""})` : "none";
  });
}
