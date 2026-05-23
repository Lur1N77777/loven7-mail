import type { ParsedAttachment, ParsedMail, ParsedSendbox, RawMailRecord, SendboxRecord } from '../types/api';
import { PREVIEW_LEN } from './constants';
import { humanBytes, safeJsonParse } from './format';

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
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeMailHtml(html: string): string {
  if (!html) return '';
  if (typeof window === 'undefined' || !window.DOMParser) {
    return html.replace(/<script[\s\S]*?<\/script>/gi, '');
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
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
        const safeSrcset = value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => {
            const url = part.split(/\s+/)[0] || '';
            return url && !SCRIPTABLE_PROTOCOL.test(url) && (!DANGEROUS_PROTOCOL.test(url) || SAFE_EMBEDDED_IMAGE_PROTOCOL.test(url));
          })
          .join(', ');
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
  return doc.body.innerHTML;
}

export function buildMailHtmlDocument(html: string): string {
  const safe = sanitizeMailHtml(html);
  const swipeBridge = `<script>
    (() => {
      let startX = 0, startY = 0, lastX = 0, lastY = 0, active = false;
      const reset = () => { active = false; startX = startY = lastX = lastY = 0; };
      const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
      const postProgress = (dx) => {
        window.parent?.postMessage({ type: 'loven7-mail-iframe-swipe-progress', dx: clamp(dx, -96, 140) }, '*');
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
        if (Math.abs(dx) > 18 && Math.abs(dx) > dy * 1.15) {
          event.preventDefault();
          postProgress(dx);
        }
      }, { passive: false });
      document.addEventListener('touchend', () => {
        if (!active) return;
        const dx = lastX - startX;
        const dy = Math.abs(lastY - startY);
        reset();
        if (Math.abs(dx) < 72 || Math.abs(dx) < dy * 1.25 || dy > 92) {
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
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="referrer" content="no-referrer"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https: http: cid:; media-src data: blob: https: http:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data: https: http:; form-action 'none'; base-uri 'none'"/><base target="_blank"/><style>
    :root { color-scheme: light; }
    html, body { margin: 0; padding: 0; width: 100%; min-width: 0; background: #fff; overscroll-behavior-x: contain; touch-action: pan-y; }
    body { box-sizing: border-box; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Arial, sans-serif; color: #1e293b; line-height: 1.65; overflow-wrap: anywhere; word-break: break-word; }
    *, *::before, *::after { box-sizing: border-box; max-width: 100%; }
    img, video, canvas, svg { max-width: 100% !important; height: auto !important; }
    table { width: auto !important; max-width: 100% !important; border-collapse: collapse; table-layout: auto; }
    pre, code { white-space: pre-wrap; overflow-wrap: anywhere; }
    a { color: #4b5563; }
    blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid #e5e7eb; color: #475569; }
    @media (max-width: 640px) { body { padding: 12px; font-size: 14px; } table { display: block; overflow-x: auto; } }
  </style></head><body>${safe}${swipeBridge}</body></html>`;
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

function normalizeCodeText(value: string): string {
  const digitRanges = [
    [0x0660, 0x0669], [0x06f0, 0x06f9], [0x0966, 0x096f], [0x09e6, 0x09ef], [0x0a66, 0x0a6f], [0x0ae6, 0x0aef],
    [0x0b66, 0x0b6f], [0x0be6, 0x0bef], [0x0c66, 0x0c6f], [0x0ce6, 0x0cef], [0x0d66, 0x0d6f], [0x0e50, 0x0e59],
    [0x0ed0, 0x0ed9], [0x0f20, 0x0f29], [0x1040, 0x1049], [0x17e0, 0x17e9], [0x1810, 0x1819], [0xff10, 0xff19],
  ];
  return value
    .normalize('NFKC')
    .replace(/\p{Nd}/gu, (char) => {
      const point = char.codePointAt(0) || 0;
      const range = digitRanges.find(([start, end]) => point >= start && point <= end);
      return range ? String(point - range[0]) : char;
    });
}

const codeContextSource = [
  '验证码', '校验码', '动态码', '安全码', '登录码', '认证码', '一次性密码',
  'code', 'otp', 'pin', 'passcode', 'one\\s*time', 'two\\s*factor', '2fa', 'mfa', 'verify', 'verification', 'security', 'auth', 'login', 'confirm', 'token',
  'c[oó]digo', 'codice', 'c[oó]digo\\s+de\\s+verifica', 'c[oó]digo\\s+de\\s+seguran', 'c[oó]digo\\s+de\\s+acesso',
  'verifizierung', 'best[aä]tigung', 'sicherheitscode', 'anmeldecode',
  'cod\\s+de\\s+verificare', 'kod', 'kode', 'koodi', 'kodėl', 'parol', 'hasło', 'haslo',
  'код', 'парол', 'підтвердж', 'однораз', 'верификац', 'провероч',
  'رمز', 'كود', 'تحقق', 'الأمان', 'تأكيد',
  'קוד', 'אימות', 'אבטחה',
  'コード', '認証', '確認', 'ワンタイム', 'セキュリティ', '確認\\s*コード', '認証\\s*コード', '認証\\s*番号', '確認\\s*番号', 'セキュリティ\\s*コード', 'ワンタイム\\s*パスワード', 'ログイン\\s*コード', '本人\\s*確認',
  '코드', '인증', '확인', '보안',
  'รหัส', 'ยืนยัน', 'ความปลอดภัย',
  'mã', 'xac\\s*minh', 'xác\\s*minh', 'bao\\s*mat', 'bảo\\s*mật',
  'verificatie', 'bevestig', 'veiligheid', 'einmal', 'zugangscode',
  'verifica', 'sicurezza', 'acceso', 'seguridad', 'contraseña', 'senha',
  'potvr', 'overen', 'overovací', 'ověř', 'jelszó', 'megerős', 'biztons',
  'doğrulama', 'güvenlik', 'şifre', 'onay',
  'कोड', 'सत्यापन', 'सुरक्षा',
  'কোড', 'যাচাই',
].join('|');
const codeContextPattern = new RegExp(codeContextSource, 'iu');

const negativeContextPattern = /(invoice|receipt|order|tracking|shipment|phone|mobile|tel|amount|price|total|date|time|zip|postal|address|account|iban|card|账单|订单|快递|物流|电话|手机|金额|价格|合计|日期|时间|邮编|地址|账户|银行卡)/iu;
const codeSeparatorSource = ' \\t._\\-\\u2010-\\u2015\\u2212';
const candidateTokenPattern = new RegExp(`[A-Za-z0-9](?:[A-Za-z0-9]|[${codeSeparatorSource}](?=[A-Za-z0-9])){3,17}`, 'g');
const directContextCandidatePattern = new RegExp(`(?:${codeContextSource})[\\s\\S]{0,48}?([A-Za-z0-9](?:[A-Za-z0-9]|[${codeSeparatorSource}](?=[A-Za-z0-9])){3,17})`, 'giu');
const directNumericContextCandidatePattern = new RegExp(`(?:${codeContextSource})[\\s\\S]{0,72}?([0-9](?:[0-9]|[${codeSeparatorSource}](?=[0-9])){3,13})`, 'giu');

function isAsciiBoundary(value: string, index: number): boolean {
  const char = value[index] || '';
  return !char || !/[A-Za-z0-9]/.test(char);
}

function normalizeCandidate(value: string): string {
  const parts = value.trim().split(new RegExp(`[${codeSeparatorSource}]+`, 'u')).filter(Boolean);
  if (parts.length > 1 && /^(?:is|are|be|ist|est|es|e|to|为|是)$/iu.test(parts[0])) parts.shift();
  while (parts.length > 1 && isTrailingNaturalWord(parts[parts.length - 1])) parts.pop();
  if (parts.length > 1 && /^\d{4,8}$/.test(parts[0]) && parts.slice(1).every((part) => /^[A-Za-z]{2,}$/.test(part))) return parts[0];
  return parts.join('').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function isTrailingNaturalWord(value: string): boolean {
  const word = value.normalize('NFKC').replace(/[^A-Za-z]/g, '').toLowerCase();
  if (!word) return false;
  if (/^(didn|didnt|did|doesn|doesnt|don|dont|enter|continue|request|requested|ignore|expires?|valid|temporary|verification|verify|code|security|login|your|this|the|team|best|thanks|thank|hello|hi)$/.test(word)) return true;
  return word.length >= 5 && /^(?:enter|conti|verif|secur|tempo|reque|ignor|thank|expir|valid)/.test(word);
}

function isLikelyCode(value: string): boolean {
  const hasDigit = /\d/.test(value);
  const hasLetter = /[A-Z]/.test(value);
  if (!hasDigit) return false;
  if (/^(\d)\1+$/.test(value) || /^([A-Z0-9])\1+$/.test(value)) return false;
  if (/^20\d{2}$/.test(value)) return false;
  if (/^(19|20)\d{6}$/.test(value)) return false;
  if (/^\d{9,}$/.test(value)) return false;
  return /^\d{4,8}$/.test(value) || (hasLetter && /^[A-Z0-9]{5,10}$/.test(value));
}

export function sanitizeVerificationCode(value: unknown): string | undefined {
  const compact = normalizeCodeText(String(value || '')).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!compact) return undefined;
  const naturalSuffix = compact.match(/^(\d{4,8})([A-Z]{2,12})$/);
  if (naturalSuffix && isTrailingNaturalWord(naturalSuffix[2])) return naturalSuffix[1];
  return isLikelyCode(compact) ? compact : undefined;
}

function scoreCandidate(text: string, raw: string, start: number, code: string): number {
  const before = text.slice(Math.max(0, start - 180), start);
  const after = text.slice(start, Math.min(text.length, start + 180));
  const windowText = `${before} ${after}`;
  const nearText = text.slice(Math.max(0, start - 48), Math.min(text.length, start + raw.length + 48));
  const positive = codeContextPattern.test(windowText);
  const closePositive = codeContextPattern.test(nearText);
  const negative = negativeContextPattern.test(windowText);
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const nextLineBreak = text.indexOf('\n', start);
  const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;
  const line = text.slice(lineStart, lineEnd).trim();
  const compactLine = normalizeCandidate(line);
  const digitOnly = /^\d+$/.test(code);
  let score = 0;
  if (positive) score += 4.5;
  if (closePositive) score += 2.5;
  if (/[:：#]\s*$/.test(before.slice(-8)) || /^\s*[:：#]/.test(after.slice(raw.length, raw.length + 8))) score += 1.3;
  if (line.length <= 42 && compactLine.includes(code)) score += compactLine === code ? 3.2 : 1.4;
  if (start < 220) score += 1.1;
  if (digitOnly && code.length === 6) score += 1.8;
  else if (digitOnly && (code.length === 5 || code.length === 7)) score += 1.25;
  else if (digitOnly && code.length === 4) score += positive ? .75 : -1.2;
  else score += 1.5;
  if (negative && !positive) score -= 4.8;
  if (/[¥$€£]\s*$/.test(before.slice(-4)) || /\d{1,2}[:：]\d{2}/.test(windowText) || /\b(?:19|20)\d{2}[-/.]\d{1,2}/.test(windowText)) score -= 2.4;
  return score;
}

export function extractVerificationCodes(text = ''): string[] {
  const normalized = normalizeCodeText(text).replace(/\r/g, '\n');
  const candidates = new Map<string, { code: string; score: number; firstIndex: number; count: number }>();
  const addCandidate = (raw: string, index: number, bonus = 0, requireBoundary = true) => {
    if (requireBoundary && (!isAsciiBoundary(normalized, index - 1) || !isAsciiBoundary(normalized, index + raw.length))) return;
    const code = sanitizeVerificationCode(normalizeCandidate(raw));
    if (!code) return;
    const score = scoreCandidate(normalized, raw, index, code) + bonus;
    const existing = candidates.get(code);
    if (existing) {
      existing.count += 1;
      existing.score = Math.max(existing.score, score) + Math.min(existing.count, 3) * .45;
      existing.firstIndex = Math.min(existing.firstIndex, index);
    } else {
      candidates.set(code, { code, score, firstIndex: index, count: 1 });
    }
  };
  for (const match of normalized.matchAll(directNumericContextCandidatePattern)) {
    const raw = match[1];
    if (!raw) continue;
    const index = (match.index || 0) + match[0].lastIndexOf(raw);
    addCandidate(raw, index, 4.8, false);
  }
  for (const match of normalized.matchAll(directContextCandidatePattern)) {
    const raw = match[1];
    if (!raw) continue;
    const index = (match.index || 0) + match[0].lastIndexOf(raw);
    addCandidate(raw, index, 3.2, false);
  }
  for (const match of normalized.matchAll(candidateTokenPattern)) {
    const raw = match[0];
    const index = match.index || 0;
    addCandidate(raw, index);
  }
  for (const item of [...candidates.values()]) {
    if (!/^\d+$/.test(item.code)) continue;
    const embeddedInAlphaNumeric = [...candidates.values()].some((other) => (
      other.code !== item.code
      && /[A-Z]/.test(other.code)
      && other.code.includes(item.code)
      && Math.abs(other.firstIndex - item.firstIndex) <= 4
    ));
    if (embeddedInAlphaNumeric) candidates.delete(item.code);
  }
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score || a.firstIndex - b.firstIndex);
  if (!ranked.length) return [];
  const strong = ranked.filter((item) => item.score >= 5.4);
  if (strong.length) return strong.slice(0, 5).map((item) => item.code);
  const hasCodeContext = codeContextPattern.test(normalized);
  return (hasCodeContext ? ranked.filter((item) => item.score >= 3.2) : ranked.filter((item) => item.score >= 4.2))
    .slice(0, 6)
    .map((item) => item.code);
}

export function extractVerificationCode(text = ''): string | undefined {
  return extractVerificationCodes(text)[0];
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
  const text = (entity.text || stripHtml(entity.html || '') || (looksLikeMimeSource(raw) ? '' : raw))
    .replace(/\s+/g, ' ')
    .trim();
  const preview = (text || subject).slice(0, PREVIEW_LEN);
  const verificationCodes = extractVerificationCodes(`${subject} ${text}`);
  return {
    ...item,
    sender: fromValue.full || String(item.source || 'Unknown'),
    senderName: fromValue.name || fromValue.address || 'Unknown',
    senderAddress: fromValue.address || String(item.source || ''),
    to: decodeMimeHeader(headers.to || '') || String(item.address || ''),
    subject,
    message: entity.html || '',
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
  const verificationCodes = extractVerificationCodes(`${subject} ${text || stripHtml(safeMessage)}`);
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
  const verificationCodes = extractVerificationCodes(`${subject} ${text}`);
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
