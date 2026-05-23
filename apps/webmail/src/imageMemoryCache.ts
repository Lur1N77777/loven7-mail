const MAX_CACHE_BYTES = 18 * 1024 * 1024;
const MAX_CACHE_ITEMS = 140;
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES_PER_MAIL = 80;
const CONCURRENCY = 5;

type CachedImage = {
  dataUrl?: string;
  proxyUrl: string;
  bytes: number;
  usedAt: number;
  promise?: Promise<string>;
};

const imageCache = new Map<string, CachedImage>();
let totalBytes = 0;

function isRemoteImageUrl(value: string) {
  try {
    const url = new URL(value, window.location.href);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function normalizeRemoteUrl(value: string) {
  const url = new URL(value, window.location.href);
  url.hash = "";
  return url.toString();
}

function proxyImageUrl(url: string) {
  return `${window.location.origin}/api/image?url=${encodeURIComponent(url)}`;
}

function evictIfNeeded() {
  if (imageCache.size <= MAX_CACHE_ITEMS && totalBytes <= MAX_CACHE_BYTES) return;
  const entries = Array.from(imageCache.entries()).sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [url, entry] of entries) {
    if (imageCache.size <= MAX_CACHE_ITEMS && totalBytes <= MAX_CACHE_BYTES) break;
    imageCache.delete(url);
    totalBytes -= entry.bytes || 0;
  }
}

async function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(blob);
  });
}

async function loadImageDataUrl(url: string) {
  const normalized = normalizeRemoteUrl(url);
  const existing = imageCache.get(normalized);
  if (existing?.dataUrl) {
    existing.usedAt = Date.now();
    return existing.dataUrl;
  }
  if (existing?.promise) return existing.promise;

  const proxyUrl = proxyImageUrl(normalized);
  const entry: CachedImage = { proxyUrl, bytes: 0, usedAt: Date.now() };
  entry.promise = (async () => {
    const response = await fetch(proxyUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("image_fetch_failed");
    const blob = await response.blob();
    if (blob.size > MAX_INLINE_IMAGE_BYTES) {
      entry.bytes = 0;
      entry.dataUrl = proxyUrl;
      entry.usedAt = Date.now();
      return proxyUrl;
    }
    const dataUrl = await blobToDataUrl(blob);
    entry.bytes = dataUrl.length;
    entry.dataUrl = dataUrl;
    entry.usedAt = Date.now();
    totalBytes += entry.bytes;
    evictIfNeeded();
    return dataUrl;
  })().catch(() => {
    imageCache.delete(normalized);
    return normalized;
  }).finally(() => {
    const current = imageCache.get(normalized);
    if (current) current.promise = undefined;
  });

  imageCache.set(normalized, entry);
  return entry.promise;
}

function parseSrcset(value: string) {
  return value
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      const [url, ...descriptor] = trimmed.split(/\s+/);
      return { url, descriptor: descriptor.join(" ") };
    })
    .filter((item) => item.url);
}

async function mapWithConcurrency<T>(items: T[], run: (item: T) => Promise<void>) {
  let index = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await run(item);
    }
  });
  await Promise.all(workers);
}

function collectStyleUrls(style: string) {
  const urls: string[] = [];
  style.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, url) => {
    if (url && isRemoteImageUrl(url)) urls.push(url);
    return "";
  });
  return urls;
}

export async function resolveMailImageAssets(html: string) {
  if (typeof DOMParser === "undefined" || !html) return html;

  const doc = new DOMParser().parseFromString(html, "text/html");
  const urls = new Set<string>();

  doc.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (src && isRemoteImageUrl(src)) urls.add(normalizeRemoteUrl(src));
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      for (const item of parseSrcset(srcset)) {
        if (isRemoteImageUrl(item.url)) urls.add(normalizeRemoteUrl(item.url));
      }
    }
  });

  doc.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    for (const url of collectStyleUrls(element.getAttribute("style") || "")) urls.add(normalizeRemoteUrl(url));
  });

  doc.querySelectorAll("style").forEach((style) => {
    for (const url of collectStyleUrls(style.textContent || "")) urls.add(normalizeRemoteUrl(url));
  });

  const urlList = Array.from(urls).slice(0, MAX_IMAGES_PER_MAIL);
  const replacements = new Map<string, string>();
  await mapWithConcurrency(urlList, async (url) => {
    replacements.set(url, await loadImageDataUrl(url));
  });

  const replaceUrl = (value: string) => {
    if (!isRemoteImageUrl(value)) return value;
    return replacements.get(normalizeRemoteUrl(value)) || value;
  };

  doc.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (src) img.setAttribute("src", replaceUrl(src));
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const firstRemoteCandidate = parseSrcset(srcset).find((item) => isRemoteImageUrl(item.url));
      if (!src && firstRemoteCandidate) img.setAttribute("src", replaceUrl(firstRemoteCandidate.url));
      img.removeAttribute("srcset");
    }
  });

  const rewriteStyle = (style: string) =>
    style.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, url) => {
      if (!url || !isRemoteImageUrl(url)) return match;
      return `url(${quote || ""}${replaceUrl(url)}${quote || ""})`;
    });

  doc.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    element.setAttribute("style", rewriteStyle(element.getAttribute("style") || ""));
  });

  doc.querySelectorAll("style").forEach((style) => {
    style.textContent = rewriteStyle(style.textContent || "");
  });

  const headStyles = Array.from(doc.head.querySelectorAll("style"))
    .map((style) => style.outerHTML)
    .join("");
  return `${headStyles}${doc.body.innerHTML}`;
}

export function clearImageMemoryCache() {
  imageCache.clear();
  totalBytes = 0;
}
