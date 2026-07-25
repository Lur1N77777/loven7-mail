import PostalMime, { type Address, type Attachment, type Mailbox } from "postal-mime";
import { mailImageAssetOrigin, proxyMailImageCss, proxyMailImageSrcset, proxyMailImageUrl } from "./mailImageProxy.ts";
import type { ParsedAttachmentSummary, ParsedMail, RawMail } from "./types";

const CODE_PATTERNS = [
  /(?:verification code|security code|one[- ]?time code|login code|passcode|otp)(?:\s+is|\s*[:：-])\s*([A-Z0-9]{4,8})/i,
  /(?:验证码|校验码|动态码|安全码|登录码)(?:为|是|[:：\s-])*([A-Z0-9]{4,8})/i,
  /\b([0-9]{6})\b/,
  /\b([A-Z0-9]{4,8})\b/,
];

function normalizeAddress(address?: Address): Mailbox | undefined {
  if (!address) return undefined;
  if ("address" in address) return { name: address.name, address: address.address || "" };
  return address.group?.[0] ? { name: address.group[0].name, address: address.group[0].address } : undefined;
}

function stripHtml(html = "") {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtmlText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(text = "", length = 180) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length)}…` : clean;
}

function extractVerificationCode(text: string) {
  for (const pattern of CODE_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function fallbackSubject(raw: string, explicit?: string) {
  if (explicit) return explicit;
  const match = raw.match(/^Subject:\s*(.+)$/im);
  return match?.[1]?.trim() || "(无主题)";
}

function fallbackDate(raw: string, createdAt?: string) {
  const match = raw.match(/^Date:\s*(.+)$/im);
  return match?.[1]?.trim() || createdAt || new Date().toISOString();
}

function tryDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeCid(value?: string) {
  if (!value) return "";
  let normalized = tryDecodeURIComponent(value.trim()).trim();
  normalized = normalized.replace(/^<+/, "").replace(/>+$/, "").trim();
  normalized = tryDecodeURIComponent(normalized).trim();
  normalized = normalized.replace(/^<+/, "").replace(/>+$/, "").trim();
  return normalized.toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bytesToBase64(content: ArrayBuffer | Uint8Array | string, encoding?: string) {
  if (typeof content === "string") {
    if (encoding === "base64") return content.replace(/\s+/g, "");
    return bytesToBase64(new TextEncoder().encode(content));
  }

  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function attachmentToDataUrl(attachment: Attachment) {
  if (!attachment.contentId) return null;
  const mimeType = attachment.mimeType || "application/octet-stream";
  return `data:${mimeType};base64,${bytesToBase64(attachment.content, attachment.encoding)}`;
}

function cidReplacementKeys(contentId: string) {
  const decoded = tryDecodeURIComponent(contentId.trim()).trim();
  const normalized = normalizeCid(decoded);
  const withoutAngles = decoded.replace(/^<+/, "").replace(/>+$/, "").trim();
  const keys = new Set<string>();

  for (const value of [contentId.trim(), decoded, withoutAngles, normalized, `<${withoutAngles}>`, `<${normalized}>`]) {
    if (!value) continue;
    keys.add(value);
    keys.add(encodeURIComponent(value));
  }
  if (normalized) {
    keys.add(`&lt;${normalized}&gt;`);
    keys.add(encodeURIComponent(`<${normalized}>`));
  }

  return Array.from(keys).filter(Boolean);
}

function inlineEmbeddedImages(html: string | undefined, attachments: Attachment[] = []) {
  if (!html || !attachments.length) return html;

  let nextHtml = html;
  for (const attachment of attachments) {
    if (!attachment.contentId) continue;
    const dataUrl = attachmentToDataUrl(attachment);
    if (!dataUrl) continue;

    for (const key of cidReplacementKeys(attachment.contentId)) {
      nextHtml = nextHtml.replace(new RegExp(`cid:${escapeRegExp(key)}`, "gi"), dataUrl);
    }
  }

  return nextHtml;
}

export function isSafeNavigationUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|x-icon);base64,/i.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed, "https://mail.invalid/");
    return new Set(["http:", "https:", "mailto:", "tel:", "cid:", "blob:"]).has(parsed.protocol);
  } catch {
    return false;
  }
}

function isEmbeddedImage(value: string) {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("data:") || trimmed.startsWith("blob:");
}

function sanitizeHtmlForFrame(html: string, allowExternalImages: boolean) {
  if (typeof DOMParser === "undefined") {
    return escapeHtmlText(stripHtml(html));
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const assetOrigin = mailImageAssetOrigin();
  doc.querySelectorAll("script, base, object, embed, iframe, frame, meta[http-equiv='refresh']").forEach((node) => node.remove());

  doc.querySelectorAll<HTMLElement>("*").forEach((element) => {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value || "";
      if (name.startsWith("on")) element.removeAttribute(attr.name);
      if ((name === "href" || name === "src" || name === "xlink:href") && !isSafeNavigationUrl(value)) {
        element.removeAttribute(attr.name);
      }
    }
  });

  doc.querySelectorAll<HTMLAnchorElement>("a").forEach((anchor) => {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.referrerPolicy = "no-referrer";
  });

  doc.querySelectorAll<HTMLFormElement>("form").forEach((form) => {
    form.removeAttribute("action");
    form.setAttribute("data-disabled-form", "true");
  });

  doc.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    const srcset = img.getAttribute("srcset") || "";
    img.loading = "eager";
    img.decoding = "async";
    img.style.maxWidth = "100%";
    if (!img.getAttribute("height")) img.style.height = "auto";
    if (src) {
      const proxiedSrc = allowExternalImages ? proxyMailImageUrl(src, assetOrigin) : (isEmbeddedImage(src) ? src : "");
      if (proxiedSrc) img.setAttribute("src", proxiedSrc);
      else {
        img.setAttribute("data-blocked-src", src);
        img.removeAttribute("src");
      }
    }
    if (srcset) {
      const proxiedSrcset = allowExternalImages ? proxyMailImageSrcset(srcset, assetOrigin) : "";
      if (proxiedSrcset) img.setAttribute("srcset", proxiedSrcset);
      else {
        img.setAttribute("data-blocked-srcset", srcset);
        img.removeAttribute("srcset");
      }
    }
  });

  doc.querySelectorAll<HTMLElement>("[background],video[poster],input[type='image'][src]").forEach((element) => {
    for (const name of ["background", "poster", "src"]) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const proxied = allowExternalImages ? proxyMailImageUrl(value, assetOrigin) : (isEmbeddedImage(value) ? value : "");
      if (proxied) element.setAttribute(name, proxied);
      else element.removeAttribute(name);
    }
  });

  doc.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const style = element.getAttribute("style") || "";
    element.setAttribute("style", allowExternalImages ? proxyMailImageCss(style, assetOrigin) : style.replace(/url\([^)]*\)/gi, "none"));
  });
  doc.querySelectorAll("style").forEach((style) => {
    const css = style.textContent || "";
    style.textContent = allowExternalImages ? proxyMailImageCss(css, assetOrigin) : css.replace(/url\([^)]*\)/gi, "none");
  });

  doc.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    table.style.maxWidth = table.style.maxWidth || "none";
  });

  const headStyles = Array.from(doc.head.querySelectorAll("style"))
    .map((style) => style.outerHTML)
    .join("");
  return `${headStyles}${doc.body.innerHTML}`;
}

export function sanitizeMailHtml(html: string, options: { allowExternalImages?: boolean } = {}) {
  return sanitizeHtmlForFrame(html, options.allowExternalImages !== false);
}

export function buildMailFrameSrcDoc(
  html: string,
  options: { allowExternalImages?: boolean; mailId?: number } = {}
) {
  const allowExternalImages = options.allowExternalImages !== false;
  const safeHtml = sanitizeHtmlForFrame(html, allowExternalImages);
  const imagePolicy = allowExternalImages ? `img-src data: blob: ${mailImageAssetOrigin()};` : "img-src data: blob:;";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${imagePolicy} script-src 'none'; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; object-src 'none'; form-action 'none'; base-uri 'none'"><base target="_blank"><style>html{margin:0;padding:0;width:100%;min-height:0;background:#fff;overflow:auto;}body{box-sizing:border-box;margin:0;width:100%;min-height:0;padding:18px;background:#fff;color:#172033;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.58;overflow:visible;overflow-wrap:anywhere;word-break:break-word;}*{box-sizing:border-box;}#loven7-scale-root{display:block;width:100%;min-height:0;overflow:visible;}#loven7-render-root{display:flow-root;width:100%;max-width:100%;min-height:0;overflow:visible;}a{color:#2563eb;text-decoration-thickness:.08em;text-underline-offset:2px;}img{max-width:100%!important;height:auto!important;border:0;vertical-align:middle;}svg,video,canvas{max-width:100%!important;height:auto!important;}table{max-width:100%;border-collapse:collapse;table-layout:auto;}td,th{max-width:100%;overflow-wrap:anywhere;}pre,code{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;}blockquote{margin-left:0;padding-left:14px;border-left:3px solid #dbe7ff;color:#42526b;}form[data-disabled-form='true']{opacity:.75;pointer-events:none;}@media(max-width:560px){body{padding:10px;font-size:14px;line-height:1.54;}p{margin-block:.72em;}table[width],td[width],th[width]{max-width:100%!important;}}</style></head><body><div id="loven7-scale-root"><div id="loven7-render-root" class="loven7-render-root">${safeHtml}</div></div><style id="loven7-final-fit">html,body{max-width:100%!important;}#loven7-render-root img,#loven7-render-root svg,#loven7-render-root video,#loven7-render-root canvas{max-width:100%!important;height:auto!important;}#loven7-render-root pre,#loven7-render-root code{white-space:pre-wrap!important;overflow-wrap:anywhere!important;}</style></body></html>`;
}

export async function parseRawMail(rawMail: RawMail): Promise<ParsedMail> {
  const raw = rawMail.raw || rawMail.source || "";
  try {
    const parsed = raw ? await new PostalMime({ attachmentEncoding: "arraybuffer" }).parse(raw) : null;
    const text = parsed?.text || stripHtml(parsed?.html || "") || raw;
    const html = inlineEmbeddedImages(parsed?.html || undefined, parsed?.attachments || []);
    const preview = truncate(text || stripHtml(html || "") || rawMail.subject || raw);
    const attachments: ParsedAttachmentSummary[] | undefined = parsed?.attachments?.length
      ? parsed.attachments.map((attachment) => ({
          filename: attachment.filename || undefined,
          mimeType: attachment.mimeType,
          contentId: normalizeCid(attachment.contentId) || undefined,
          related: attachment.related || attachment.disposition === "inline" || undefined,
          size:
            typeof attachment.content === "string"
              ? attachment.content.length
              : "byteLength" in attachment.content
                ? attachment.content.byteLength
                : undefined,
        }))
      : undefined;

    return {
      id: rawMail.id,
      messageId: parsed?.messageId || rawMail.message_id,
      from: normalizeAddress(parsed?.from),
      to: parsed?.to?.flatMap((item) => {
        const normalized = normalizeAddress(item);
        return normalized ? [normalized] : [];
      }),
      subject: parsed?.subject || fallbackSubject(raw, rawMail.subject),
      preview,
      text,
      html,
      raw,
      date: parsed?.date || fallbackDate(raw, rawMail.created_at),
      createdAt: rawMail.created_at || parsed?.date || new Date().toISOString(),
      attachments,
      verificationCode: extractVerificationCode(`${parsed?.subject || ""}\n${text}\n${stripHtml(html || "")}`),
    };
  } catch {
    const text = raw || rawMail.subject || "";
    return {
      id: rawMail.id,
      subject: fallbackSubject(raw, rawMail.subject),
      preview: truncate(stripHtml(text) || "(无内容)"),
      text,
      raw,
      date: fallbackDate(raw, rawMail.created_at),
      createdAt: rawMail.created_at || new Date().toISOString(),
      verificationCode: extractVerificationCode(text),
    };
  }
}

export async function parseMailBatch(rawMails: RawMail[]) {
  return Promise.all(rawMails.map(parseRawMail));
}

export function mergeMails(existing: ParsedMail[], incoming: ParsedMail[]) {
  const byId = new Map<number, ParsedMail>();
  for (const mail of existing) byId.set(mail.id, mail);
  for (const mail of incoming) byId.set(mail.id, { ...byId.get(mail.id), ...mail });
  return Array.from(byId.values()).sort((a, b) => {
    if (a.id !== b.id) return b.id - a.id;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export function getMailBodyText(mail: ParsedMail) {
  return mail.text || stripHtml(mail.html || "") || mail.raw || "";
}
