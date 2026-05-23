import PostalMime, { type Address, type Attachment, type Mailbox } from "postal-mime";
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

function isSafeNavigationUrl(value: string) {
  const trimmed = value.trim().toLowerCase();
  return Boolean(trimmed && !trimmed.startsWith("javascript:") && !trimmed.startsWith("data:text/html"));
}

function isEmbeddedImage(value: string) {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("data:") || trimmed.startsWith("blob:");
}

function sanitizeHtmlForFrame(html: string, allowExternalImages: boolean) {
  if (typeof DOMParser === "undefined") {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<base[\s\S]*?>/gi, "")
      .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, "")
      .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
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
    if (!allowExternalImages && src && !isEmbeddedImage(src)) {
      img.setAttribute("data-blocked-src", src);
      img.removeAttribute("src");
    }
    if (!allowExternalImages && srcset) {
      img.setAttribute("data-blocked-srcset", srcset);
      img.removeAttribute("srcset");
    }
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
  const imagePolicy = allowExternalImages ? "img-src data: blob: https: http: cid:;" : "img-src data: blob:;";
  const mailId = Number.isFinite(options.mailId) ? Number(options.mailId) : 0;
  const resizeScript = `<script>(function(){var mailId=${mailId};var lastHeight=0,lastWidth=0;var pending=false;var watched=new WeakSet();function n(v){return Math.ceil(Number(v)||0)}function visible(el){var s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='collapse';}function measure(){var doc=document.documentElement,body=document.body,root=document.getElementById('loven7-render-root');if(!body||!root)return 1;var bodyRect=body.getBoundingClientRect();var top=Math.min(bodyRect.top,root.getBoundingClientRect().top,0);var bottom=Math.max(body.scrollHeight,doc.scrollHeight,root.scrollHeight,root.offsetHeight,root.getBoundingClientRect().bottom-top);var width=Math.max(body.scrollWidth,doc.scrollWidth,root.scrollWidth,root.offsetWidth,doc.clientWidth||window.innerWidth||0);var nodes=root.querySelectorAll('*');for(var i=0;i<nodes.length;i++){var el=nodes[i];if(!visible(el))continue;var r=el.getBoundingClientRect();if(r.width||r.height){bottom=Math.max(bottom,r.bottom-top);width=Math.max(width,r.right-Math.min(bodyRect.left,0),el.scrollWidth,el.offsetWidth);}}return{height:Math.max(1,n(bottom)+2),width:n(width)};}function send(){pending=false;watchImages();var m=measure();if(Math.abs(m.height-lastHeight)<2&&Math.abs(m.width-lastWidth)<2)return;lastHeight=m.height;lastWidth=m.width;parent.postMessage({type:'loven7-mail-frame-size',mailId:mailId,height:m.height,width:m.width,scale:1},'*');}function schedule(){if(pending)return;pending=true;requestAnimationFrame(send);}function watchImages(){Array.prototype.forEach.call(document.images||[],function(img){if(watched.has(img))return;watched.add(img);img.addEventListener('load',schedule,{once:false});img.addEventListener('error',schedule,{once:false});if(img.decode)img.decode().then(schedule).catch(function(){});});}window.addEventListener('load',function(){schedule();setTimeout(schedule,50);setTimeout(schedule,150);setTimeout(schedule,400);setTimeout(schedule,900);setTimeout(schedule,1800);setTimeout(schedule,3500);setTimeout(schedule,6000);});window.addEventListener('resize',schedule);if(document.fonts&&document.fonts.ready)document.fonts.ready.then(schedule).catch(function(){});try{var ro=new ResizeObserver(schedule);ro.observe(document.documentElement);ro.observe(document.body);var root=document.getElementById('loven7-render-root');if(root)ro.observe(root);}catch(e){}try{new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});}catch(e){}schedule();})();</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${imagePolicy} script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data: https: http:; media-src data: blob: https: http:; form-action 'none'; base-uri 'none'"><base target="_blank"><style>html{margin:0;padding:0;width:100%;min-height:0;background:#fff;overflow:auto;}body{box-sizing:border-box;margin:0;width:100%;min-height:0;padding:18px;background:#fff;color:#172033;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.58;overflow:visible;overflow-wrap:anywhere;word-break:break-word;}*{box-sizing:border-box;}#loven7-scale-root{display:block;width:100%;min-height:0;overflow:visible;}#loven7-render-root{display:flow-root;width:100%;max-width:100%;min-height:0;overflow:visible;}a{color:#2563eb;text-decoration-thickness:.08em;text-underline-offset:2px;}img{max-width:100%!important;height:auto!important;border:0;vertical-align:middle;}svg,video,canvas{max-width:100%!important;height:auto!important;}table{max-width:100%;border-collapse:collapse;table-layout:auto;}td,th{max-width:100%;overflow-wrap:anywhere;}pre,code{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;}blockquote{margin-left:0;padding-left:14px;border-left:3px solid #dbe7ff;color:#42526b;}form[data-disabled-form='true']{opacity:.75;pointer-events:none;}@media(max-width:560px){body{padding:10px;font-size:14px;line-height:1.54;}p{margin-block:.72em;}table[width],td[width],th[width]{max-width:100%!important;}}</style></head><body><div id="loven7-scale-root"><div id="loven7-render-root" class="loven7-render-root">${safeHtml}</div></div><style id="loven7-final-fit">html,body{max-width:100%!important;}#loven7-render-root img,#loven7-render-root svg,#loven7-render-root video,#loven7-render-root canvas{max-width:100%!important;height:auto!important;}#loven7-render-root pre,#loven7-render-root code{white-space:pre-wrap!important;overflow-wrap:anywhere!important;}</style>${resizeScript}</body></html>`;
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
