import type { ParsedAttachment, ParsedMail, ParsedSendbox, RawMailRecord, SendboxRecord } from '../types/api';
import { PREVIEW_LEN } from './constants';
import { humanBytes, safeJsonParse } from './format';
import { mailImageAssetOrigin, proxyMailImageCss, proxyMailImageSrcset, proxyMailImageUrl } from './mailImageProxy';
import { sanitizeMailHtmlWithoutDom } from './mailSanitizerFallback';
import {
  extractVerificationCode as extractSharedVerificationCode,
  extractVerificationCodes as extractSharedVerificationCodes,
  sanitizeVerificationCode as sanitizeSharedVerificationCode,
} from '../../../shared/verificationCode';

const DANGEROUS_PROTOCOL = /^\s*(?:javascript|vbscript|data|file|blob|jar):/i;
const SCRIPTABLE_PROTOCOL = /^\s*(?:javascript|vbscript|file|jar):/i;
const SAFE_EMBEDDED_IMAGE_PROTOCOL = /^\s*(?:data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml|x-icon)|blob:)/i;
const SAFE_URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background', 'cite', 'longdesc', 'usemap', 'xlink:href']);
const STRIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'object', 'embed', 'applet', 'base', 'iframe', 'frame', 'frameset', 'meta', 'link', 'form', 'svg', 'math']);
const SAFE_ATTACHMENT_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/x-icon',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/webm',
  'video/mp4', 'video/webm', 'video/ogg',
  'text/plain', 'text/csv', 'application/pdf', 'application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed',
  'application/json', 'application/xml',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'message/rfc822',
]);

function safeAttachmentMimeType(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return 'application/octet-stream';
  const base = raw.split(';')[0].trim();
  if (SAFE_ATTACHMENT_TYPES.has(base)) return base;
  return 'application/octet-stream';
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6]|pre|table|section|article|header|footer)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectVerificationCodes(subject: string, text: string, html = ''): string[] {
  return extractVerificationCodes(`${subject}\n${text}`, [html]);
}

export function sanitizeMailHtml(html: string, options: { allowExternalImages?: boolean } = {}): string {
  if (!html) return '';
  if (typeof window === 'undefined' || !window.DOMParser) {
    return sanitizeMailHtmlWithoutDom(html);
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const allowExternalImages = options.allowExternalImages !== false;
  const assetOrigin = mailImageAssetOrigin();
  doc.querySelectorAll(Array.from(STRIP_TAGS).join(',')).forEach((node) => node.remove());
  doc.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      if (name.startsWith('on')) {
        node.removeAttribute(attr.name);
        return;
      }
      if (name === 'srcdoc') {
        node.removeAttribute(attr.name);
        return;
      }
      if (name === 'srcset' && node instanceof HTMLImageElement) {
        if (!allowExternalImages) {
          node.setAttribute('data-blocked-srcset', value);
          node.removeAttribute(attr.name);
          return;
        }
        const safeSrcset = proxyMailImageSrcset(value, assetOrigin);
        if (safeSrcset) node.setAttribute(attr.name, safeSrcset);
        else node.removeAttribute(attr.name);
        return;
      }
      if (SAFE_URL_ATTRIBUTES.has(name)) {
        const isEmbeddedImageAttribute = node instanceof HTMLImageElement && (name === 'src' || name === 'poster');
        if (SCRIPTABLE_PROTOCOL.test(value) || (DANGEROUS_PROTOCOL.test(value) && !(isEmbeddedImageAttribute && SAFE_EMBEDDED_IMAGE_PROTOCOL.test(value)))) {
          node.removeAttribute(attr.name);
          return;
        }
        if (!allowExternalImages && isEmbeddedImageAttribute && /^\s*(?:https?:)?\/\//i.test(value)) {
          node.setAttribute('data-blocked-src', value);
          node.removeAttribute(attr.name);
          return;
        }
      }
      if (name === 'style' && /(expression|javascript:|behaviou?r:|@import)/i.test(value)) {
        node.removeAttribute(attr.name);
      }
    });
  });
  doc.querySelectorAll('a[href]').forEach((node) => {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
  doc.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src) {
      const proxied = allowExternalImages ? proxyMailImageUrl(src, assetOrigin) : (SAFE_EMBEDDED_IMAGE_PROTOCOL.test(src) ? src : '');
      if (proxied) img.setAttribute('src', proxied);
      else img.removeAttribute('src');
    }
  });
  doc.querySelectorAll<HTMLElement>('[background],video[poster],input[type="image"][src]').forEach((element) => {
    for (const name of ['background', 'poster', 'src']) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const proxied = allowExternalImages ? proxyMailImageUrl(value, assetOrigin) : (SAFE_EMBEDDED_IMAGE_PROTOCOL.test(value) ? value : '');
      if (proxied) element.setAttribute(name, proxied);
      else element.removeAttribute(name);
    }
  });
  doc.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    const style = element.getAttribute('style') || '';
    element.setAttribute('style', allowExternalImages ? proxyMailImageCss(style, assetOrigin) : style.replace(/url\([^)]*\)/gi, 'none'));
  });
  return doc.body.innerHTML;
}

export function buildMailHtmlDocument(html: string, _theme: 'light' | 'dark' = 'light', options: { allowExternalImages?: boolean } = {}): string {
  const allowExternalImages = options.allowExternalImages !== false;
  const safe = sanitizeMailHtml(html, { allowExternalImages });
  const imagePolicy = allowExternalImages ? `img-src data: blob: ${mailImageAssetOrigin()};` : 'img-src data: blob:;';
  const swipeBridge = `<script>
    (() => {
      let startX = 0, startY = 0, lastX = 0, lastY = 0, active = false;
      const reset = () => { active = false; startX = startY = lastX = lastY = 0; };
      const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
      const postProgress = (dx) => {
        window.parent?.postMessage({ type: 'loven7-mail-iframe-swipe-progress', dx: clamp(dx, -180, 180) }, '*');
      };
      document.addEventListener('touchstart', (event) => {
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        active = true;
        startX = lastX = touch.clientX;
        startY = lastY = touch.clientY;
      }, { passive: true });
      document.addEventListener('touchmove', (event) => {
        if (!active || event.touches.length !== 1) return;
        const touch = event.touches[0];
        lastX = touch.clientX;
        lastY = touch.clientY;
        const dx = lastX - startX;
        const dy = Math.abs(lastY - startY);
        if (Math.abs(dx) > 10 && Math.abs(dx) > dy * .82) {
          event.preventDefault();
          postProgress(dx);
        }
      }, { passive: false });
      document.addEventListener('touchend', () => {
        if (!active) return;
        const dx = lastX - startX;
        const dy = Math.abs(lastY - startY);
        reset();
        if (Math.abs(dx) < 46 || Math.abs(dx) < dy * .82 || dy > 150) {
          postProgress(0);
          return;
        }
        window.parent?.postMessage({ type: 'loven7-mail-iframe-swipe', direction: dx > 0 ? 'right' : 'left' }, '*');
      }, { passive: true });
      document.addEventListener('touchcancel', () => {
        reset();
        postProgress(0);
      }, { passive: true });
    })();
  <\/script>`;
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="referrer" content="no-referrer"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${imagePolicy} media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; object-src 'none'; form-action 'none'; base-uri 'none'"/><base target="_blank"/><style>
    :root { color-scheme: light; --mail-frame-surface: #fff; --mail-frame-text: #111317; --mail-frame-muted: #475569; --mail-frame-link: #2563eb; --mail-frame-quote-border: #e5e7eb; }
    html, body { margin: 0; padding: 0; width: 100%; min-width: 0; background: var(--mail-frame-surface) !important; color-scheme: light; overscroll-behavior-x: contain; touch-action: pan-y; scrollbar-width: none; -ms-overflow-style: none; }
    * { scrollbar-width: none; -ms-overflow-style: none; letter-spacing: 0; }
    *::-webkit-scrollbar, *::-webkit-scrollbar-track, *::-webkit-scrollbar-thumb, *::-webkit-scrollbar-corner { width: 0 !important; height: 0 !important; display: none !important; background: transparent !important; }
    body { box-sizing: border-box; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable", "Segoe UI", Roboto, "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif; background: var(--mail-frame-surface) !important; color: var(--mail-frame-text); font-size: 14px; line-height: 1.625; overflow-wrap: anywhere; word-break: break-word; font-weight: 400; letter-spacing: 0; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
    #loven7-mail-root { display: flow-root; width: 100%; max-width: 100%; min-height: 0; background: transparent; color: inherit; }
    *, *::before, *::after { box-sizing: border-box; max-width: 100%; }
    img, video, canvas, svg { max-width: 100% !important; height: auto !important; }
    table { width: auto !important; max-width: 100% !important; border-collapse: collapse; table-layout: auto; }
    pre, code { white-space: pre-wrap; overflow-wrap: anywhere; }
    a { color: var(--mail-frame-link); }
    blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid var(--mail-frame-quote-border); color: var(--mail-frame-muted); }
    @media (max-width: 640px) { body { padding: 8px 0 0; font-size: 14px; } table { display: block; overflow-x: auto; } }
  </style></head><body><div id="loven7-mail-root">${safe}</div>${swipeBridge}</body></html>`;
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const headerText = raw.split(/\r?\n\r?\n/)[0] || '';
  const lines = headerText.split(/\r?\n/);
  let current = '';
  for (const line of lines) {
    if (/^\s/.test(line) && current) {
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const index = line.indexOf(':');
    if (index <= 0) continue;
    current = line.slice(0, index).toLowerCase();
    headers[current] = line.slice(index + 1).trim();
  }
  return headers;
}

function splitHeaderBody(raw: string): { headerText: string; body: string } {
  const normalized = String(raw || '').replace(/\r\n/g, '\n');
  const match = normalized.match(/\n\s*\n/);
  if (!match || typeof match.index !== 'number') return { headerText: normalized, body: '' };
  return {
    headerText: normalized.slice(0, match.index),
    body: normalized.slice(match.index + match[0].length),
  };
}

function getContentTypeParam(contentType: string, paramName: string): string {
  const escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(contentType || '').match(new RegExp(`${escaped}\\s*=\\s*(?:"([^"]+)"|([^;\\s]+))`, 'i'));
  return (match?.[1] || match?.[2] || '').trim();
}

function splitMultipartBody(body: string, boundary: string): string[] {
  if (!body || !boundary) return [];
  const normalized = body.replace(/\r\n/g, '\n');
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const delimiter = new RegExp(`(?:^|\\n)--${escaped}(--)?[ \\t]*(?:\\n|$)`, 'g');
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  let partStart = -1;
  while ((match = delimiter.exec(normalized))) {
    if (partStart >= 0) {
      const chunk = normalized.slice(partStart, match.index).replace(/^\n+|\n+$/g, '');
      if (chunk.trim()) parts.push(chunk);
    }
    if (match[1] === '--') break;
    partStart = delimiter.lastIndex;
  }
  return parts;
}

type FallbackMimeEntity = {
  headers: Record<string, string>;
  html: string;
  text: string;
  contentType: string;
};

function parseMimeEntity(raw: string, depth = 0): FallbackMimeEntity {
  const headers = parseHeaders(raw);
  const { body } = splitHeaderBody(raw);
  const contentType = headers['content-type'] || '';
  const transferEncoding = headers['content-transfer-encoding'] || '';
  const disposition = headers['content-disposition'] || '';
  if (depth > 8) {
    const decoded = decodeBody(body || raw, transferEncoding, contentType);
    return { headers, html: /text\/html/i.test(contentType) ? decoded : '', text: /text\/html/i.test(contentType) ? stripHtml(decoded) : decoded, contentType };
  }
  if (/multipart\//i.test(contentType)) {
    const boundary = getContentTypeParam(contentType, 'boundary');
    const children = splitMultipartBody(body, boundary).map((part) => parseMimeEntity(part, depth + 1));
    const html = children.map((child) => child.html).filter(Boolean).join('\n');
    const text = children.map((child) => child.text).filter(Boolean).join('\n').trim();
    return { headers, html, text, contentType };
  }
  if (/attachment/i.test(disposition)) return { headers, html: '', text: '', contentType };
  const decoded = decodeBody(body || raw, transferEncoding, contentType);
  if (/text\/html/i.test(contentType)) return { headers, html: decoded, text: stripHtml(decoded), contentType };
  if (/text\/plain|text\/markdown|text\//i.test(contentType) || !contentType) return { headers, html: '', text: decoded, contentType };
  return { headers, html: '', text: '', contentType };
}

export function looksLikeMimeSource(value = ''): boolean {
  return /(?:^|\n)--[^\n]{3,80}\n|Content-Transfer-Encoding\s*:|Content-Type\s*:\s*(?:multipart|text\/html|text\/plain)/i.test(value);
}

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char] || char);
}

function parseAddress(value = ''): { name: string; address: string; full: string } {
  const match = value.match(/^(.*?)<([^>]+)>/);
  if (match) {
    const name = match[1].replace(/^"|"$/g, '').trim();
    const address = match[2].trim();
    return { name: name || address.split('@')[0], address, full: name ? `${name} <${address}>` : address };
  }
  const address = value.trim();
  return { name: address.split('@')[0] || address || 'Unknown', address, full: address || 'Unknown' };
}

function decodeMimeHeader(value = ''): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_match, charset: string, encoding: string, encoded: string) => {
      try {
        const bytes = encoding.toUpperCase() === 'B'
          ? Uint8Array.from(atob(encoded.replace(/\s+/g, '')), (char) => char.charCodeAt(0))
          : Uint8Array.from(encoded.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_hexMatch: string, hex: string) => String.fromCharCode(parseInt(hex, 16))).split('').map((char: string) => char.charCodeAt(0)));
        return new TextDecoder(charset || 'utf-8').decode(bytes);
      } catch {
        return encoded;
      }
    });
}

function decodeBase64Text(value: string, charset = 'utf-8'): string {
  try {
    const binary = atob(value.replace(/\s+/g, ''));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return value;
  }
}

function decodeQuotedPrintable(value: string, charset = 'utf-8'): string {
  try {
    // collapse soft line breaks: "=\r\n", "=\n", and stray "=" at line ends (mid-byte split tolerated)
    const cleaned = value.replace(/=\r?\n/g, '').replace(/=\s*$/gm, '');
    const bytes: number[] = [];
    for (let i = 0; i < cleaned.length; i += 1) {
      const char = cleaned[i];
      if (char === '=' && i + 2 < cleaned.length && /[0-9A-Fa-f]/.test(cleaned[i + 1]) && /[0-9A-Fa-f]/.test(cleaned[i + 2])) {
        bytes.push(parseInt(cleaned.substr(i + 1, 2), 16));
        i += 2;
      } else {
        const code = char.charCodeAt(0);
        if (code < 0x80) bytes.push(code);
        else {
          // already-decoded multi-byte char snuck in: re-encode as UTF-8 bytes
          const enc = new TextEncoder().encode(char);
          enc.forEach((b) => bytes.push(b));
        }
      }
    }
    return new TextDecoder(charset, { fatal: false }).decode(Uint8Array.from(bytes));
  } catch {
    return value;
  }
}

function getCharsetFromContentType(contentType: string): string {
  const match = String(contentType || '').match(/charset\s*=\s*["']?([\w\-]+)["']?/i);
  if (!match) return 'utf-8';
  const charset = match[1].toLowerCase();
  // normalize common aliases TextDecoder accepts
  if (charset === 'gb2312') return 'gb18030';
  return charset;
}

function decodeBody(body: string, transferEncoding: string, contentType: string): string {
  const charset = getCharsetFromContentType(contentType);
  const enc = String(transferEncoding || '').toLowerCase();
  if (/base64/i.test(enc)) return decodeBase64Text(body, charset);
  if (/quoted-printable/i.test(enc)) return decodeQuotedPrintable(body, charset);
  // 7bit/8bit/binary - still need charset reinterpretation when non-utf8
  if (charset !== 'utf-8' && charset !== 'us-ascii') {
    try {
      const bytes = Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      return body;
    }
  }
  return body;
}

export function sanitizeVerificationCode(value: unknown, options?: { allowAlphaOnly?: boolean }): string | undefined {
  return sanitizeSharedVerificationCode(value, options);
}

export function extractVerificationCodes(text = '', extraSources: string[] = []): string[] {
  return extractSharedVerificationCodes(text, extraSources);
}

export function extractVerificationCode(text = '', extraSources: string[] = []): string | undefined {
  return extractSharedVerificationCode(text, extraSources);
}

function simpleParse(raw = '') {
  const entity = parseMimeEntity(raw);
  const headers = entity.headers;
  const text = entity.text || stripHtml(entity.html || '');
  return {
    from: parseAddress(decodeMimeHeader(headers.from || '')),
    to: decodeMimeHeader(headers.to || ''),
    subject: decodeMimeHeader(headers.subject || '') || 'No Subject',
    html: entity.html,
    text,
    attachments: [] as ParsedAttachment[],
  };
}

export function parseRawMailListItem(item: RawMailRecord): ParsedMail {
  const raw = String(item.raw || item.source || '');
  const entity = parseMimeEntity(raw);
  const headers = entity.headers;
  const fromValue = parseAddress(decodeMimeHeader(headers.from || String(item.source || '')));
  const subject = decodeMimeHeader(headers.subject || '') || 'No Subject';
  const html = entity.html || '';
  const text = (entity.text || stripHtml(html) || (looksLikeMimeSource(raw) ? '' : raw))
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim();
  const preview = (text || subject).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LEN);
  const verificationCodes = collectVerificationCodes(subject, text, html);
  return {
    ...item,
    sender: fromValue.full || String(item.source || 'Unknown'),
    senderName: fromValue.name || fromValue.address || 'Unknown',
    senderAddress: fromValue.address || String(item.source || ''),
    to: decodeMimeHeader(headers.to || '') || String(item.address || ''),
    subject,
    message: html,
    text,
    preview,
    attachments: [],
    verificationCode: verificationCodes[0],
    verificationCodes,
    parsedAt: Date.now(),
  };
}

async function parseWithPostalMime(raw: string): Promise<any | null> {
  try {
    const mod = await import('postal-mime');
    const PostalMime = mod.default;
    return await PostalMime.parse(raw || '');
  } catch (error) {
    console.warn('postal-mime unavailable, using simple parser', error);
    return null;
  }
}

function attachmentFromPostal(item: any, index: number): ParsedAttachment {
  const content = item?.content instanceof Uint8Array ? item.content : new Uint8Array(item?.content || []);
  const mimeType = safeAttachmentMimeType(item?.mimeType || item?.contentType);
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const cidRaw = typeof (item?.contentId || item?.contentID || item?.cid) === 'string' ? String(item?.contentId || item?.contentID || item?.cid) : '';
  const cid = cidRaw.replace(/^<|>$/g, '').trim();
  return {
    id: cid || `${Date.now()}-${index}`,
    filename: String(item?.filename || cid || `attachment-${index + 1}`),
    size: humanBytes(content.byteLength || blob.size),
    bytes: content.byteLength || blob.size,
    mimeType,
    url,
    blob,
  };
}

function inlineAttachmentCids(html: string, attachments: ParsedAttachment[]): string {
  if (!html || !attachments.length) return html;
  let next = html;
  for (const attachment of attachments) {
    const cid = attachment.id;
    if (!cid || /[^A-Za-z0-9._+\-@]/.test(cid)) continue;
    const escaped = cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    next = next
      .replace(new RegExp(`cid:<${escaped}>`, 'gi'), attachment.url)
      .replace(new RegExp(`cid:${escaped}`, 'gi'), attachment.url);
  }
  return next;
}

export async function parseRawMail(item: RawMailRecord): Promise<ParsedMail> {
  const raw = String(item.raw || '');
  const postal = raw ? await parseWithPostalMime(raw) : null;
  const fallback = postal ? null : simpleParse(raw || String(item.source || ''));
  const fromValue = postal?.from
    ? { name: postal.from.name || '', address: postal.from.address || '', full: postal.from.name ? `${postal.from.name} <${postal.from.address}>` : postal.from.address }
    : fallback?.from || parseAddress(String(item.source || ''));
  const attachments = (postal?.attachments || []).map((attachment: any, index: number) => attachmentFromPostal(attachment, index));
  const inlinedHtml = inlineAttachmentCids(postal?.html || fallback?.html || '', attachments);
  let safeMessage = sanitizeMailHtml(inlinedHtml);
  const text = postal?.text || fallback?.text || stripHtml(safeMessage || (looksLikeMimeSource(raw) ? '' : raw));
  if (!safeMessage) {
    safeMessage = escapeHtmlText(text || '邮件正文仍在解析，请稍后刷新。').replace(/\n/g, '<br/>');
  }
  const subject = postal?.subject || fallback?.subject || 'No Subject';
  const preview = (text || stripHtml(safeMessage) || subject).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LEN);
  const verificationCodes = collectVerificationCodes(subject, text || stripHtml(safeMessage), inlinedHtml || safeMessage);
  const verificationCode = verificationCodes[0];
  return {
    ...item,
    sender: fromValue.full || String(item.source || 'Unknown'),
    senderName: fromValue.name || fromValue.address || 'Unknown',
    senderAddress: fromValue.address || String(item.source || ''),
    to: postal?.to?.map?.((addr: any) => addr.address || addr.name || '').filter(Boolean).join(', ') || fallback?.to || String(item.address || ''),
    subject,
    message: safeMessage,
    text,
    preview,
    attachments,
    verificationCode,
    verificationCodes,
    parsedAt: Date.now(),
  };
}

export function parseSendbox(item: SendboxRecord): ParsedSendbox {
  const rawBody = safeJsonParse<Record<string, any>>(item.raw, {});
  const subject = rawBody.subject || 'No Subject';
  const content = rawBody.content || item.raw || '';
  const text = rawBody.is_html ? stripHtml(content) : content;
  const verificationCodes = collectVerificationCodes(subject, String(text || ''), String(content || ''));
  const verificationCode = verificationCodes[0];
  return {
    ...item,
    from_name: rawBody.from_name || '',
    from_mail: rawBody.from_mail || item.address,
    to_name: rawBody.to_name || '',
    to_mail: rawBody.to_mail || '',
    subject,
    content,
    is_html: Boolean(rawBody.is_html),
    preview: String(text).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LEN),
    verificationCode,
    verificationCodes,
  };
}

export function getDownloadEmlUrl(raw?: string): string {
  return URL.createObjectURL(new Blob([raw || ''], { type: 'message/rfc822' }));
}
