/**
 * High-precision verification-code extraction.
 *
 * Design goals:
 * 1. Prefer real OTP codes (4-8 digits, or short alphanumerics with digits).
 * 2. Pure alphabetic codes (e.g. Notion "rxthEC") are allowed only with strong evidence.
 * 3. Never promote brand names / product words / address / version fragments.
 */

const CONTEXT_ALTERNATIVES = [
  '验证码', '校验码', '动态码', '安全码', '登录码', '认证码', '一次性密码',
  'code', 'otp', 'pin', 'passcode', 'one\\s*time', 'two\\s*factor', '2fa', 'mfa',
  'verify', 'verification', 'security', 'auth', 'confirm', 'token',
  'temp[_\\s-]*password', 'one[_\\s-]*time[_\\s-]*password',
  'c[oó]digo', 'codice', 'verifizierung', 'best[aä]tigung', 'sicherheitscode',
  'anmeldecode', 'cod\\s+de\\s+verificare', 'kod', 'kode', 'koodi', 'parol', 'hasło', 'haslo',
  'код', 'парол', 'підтвердж', 'однораз', 'верификац', 'провероч',
  'رمز', 'كود', 'تحقق', 'الأمان', 'تأكيد', 'קוד', 'אימות', 'אבטחה',
  'コード', '認証', '確認', 'ワンタイム', 'セキュリティ', '코드', '인증', '확인', '보안',
  'รหัส', 'ยืนยัน', 'ความปลอดภัย', 'mã', 'xac\\s*minh', 'xác\\s*minh',
  'bao\\s*mat', 'bảo\\s*mật', 'verificatie', 'bevestig', 'veiligheid', 'einmal',
  'zugangscode', 'verifica', 'sicurezza', 'acceso', 'seguridad', 'contraseña', 'senha',
  'potvr', 'overen', 'overovací', 'ověř', 'jelszó', 'megerős', 'biztons',
  'doğrulama', 'güvenlik', 'şifre', 'onay', 'कोड', 'सत्यापन', 'सुरक्षा', 'কোড', 'যাচাই',
].join('|');

// Soft subject/title cues used only for "next-line lone code" (Notion-style).
const SOFT_LOGIN_CONTEXT = /(?<![A-Za-z0-9])(?:登录|注册|login|sign\s*up|sign\s*in|signin|signup|magic)(?![A-Za-z0-9])/giu;

const CODE_CONTEXT_PATTERN = new RegExp(
  `(?<![A-Za-z0-9])(?:${CONTEXT_ALTERNATIVES})(?![A-Za-z0-9])`,
  'giu',
);

const TOKEN_PATTERN = /(?<![A-Za-z0-9])([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)(?![A-Za-z0-9])/g;
const ADDRESS_LINE_PATTERN = /(invoice|receipt|order|tracking|shipment|phone|mobile|tel|amount|price|total|date|time|zip|postal|address|street|road|avenue|account|iban|card|账单|订单|快递|物流|电话|手机|金额|价格|合计|日期|时间|邮编|地址|账户|银行卡)/iu;

const BRAND_OR_PRODUCT_WORDS = new Set([
  'CHATGPT', 'OPENAI', 'NOTION', 'GITHUB', 'GOOGLE', 'GMAIL', 'APPLE', 'ICLOUD', 'MICROSOFT',
  'OUTLOOK', 'WINDOWS', 'AMAZON', 'AWS', 'PAYPAL', 'STRIPE', 'DISCORD', 'SLACK', 'FIGMA',
  'VERCEL', 'CLOUDFLARE', 'ANTHROPIC', 'CLAUDE', 'TWITTER', 'FACEBOOK', 'INSTAGRAM',
  'LINKEDIN', 'YOUTUBE', 'NETFLIX', 'SHOPIFY', 'TELEGRAM', 'WHATSAPP', 'DROPBOX',
  'ANTARCTIC', 'CLICKING', 'CLICK', 'HERE', 'PLEASE', 'ENTER', 'CONTINUE', 'REQUEST',
  'IGNORE', 'MESSAGE', 'EMAIL', 'ACCOUNT', 'PASSWORD', 'PASSCODE', 'SECURITY', 'VERIFY',
  'VERIFICATION', 'LOGIN', 'SIGNUP', 'SIGNIN', 'WELCOME', 'SUPPORT', 'TEAM', 'THANKS',
  'THANK', 'HELLO', 'NEVER', 'SHARE', 'ANYONE', 'SUBJECT', 'HTTPS', 'HTTP', 'MAILTO',
  'CODEX', 'TERRA', 'DEV', 'NEWS', 'BUILT', 'DEADLINE', 'IDEA',
]);

const PRODUCT_VERSION_PREFIXES = new Set([
  'GPT', 'CLAUDE', 'CODEX', 'IOS', 'IPADOS', 'MACOS', 'ANDROID', 'WINDOWS', 'CHROME',
  'FIREFOX', 'SAFARI', 'NODE', 'NODEJS', 'PYTHON', 'REACT', 'VUE', 'ANGULAR', 'CUDA',
]);

const CONNECTOR_WORDS = /^(?:is|are|your|the|a|an|for|to|of|as|below|here|use|enter|please|can|be|found|in|this|message|email|code|verification|security|login|one|time|factor|auth|confirm|token|account|password|passcode|signup|sign|up|magic|link|为|是|的|请|输入|如下|这里|登录|注册)$/iu;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]{1,6});?|&#([0-9]{1,7});?/gi, (_full, hex, decimal) => {
      const point = Number.parseInt(hex || decimal, hex ? 16 : 10);
      if (!Number.isFinite(point) || point <= 0 || point > 0x10ffff) return ' ';
      try {
        const character = String.fromCodePoint(point);
        return /\s|[\u200b-\u200d\u2060\ufeff]/u.test(character) ? ' ' : character;
      } catch {
        return ' ';
      }
    })
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;?/gi, '&')
    .replace(/&lt;?/gi, '<')
    .replace(/&gt;?/gi, '>')
    .replace(/&quot;?/gi, '"')
    .replace(/&#39;?/gi, "'");
}

function normalizeDigits(value: string): string {
  const digitRanges = [
    [0x0660, 0x0669], [0x06f0, 0x06f9], [0x0966, 0x096f], [0x09e6, 0x09ef], [0x0a66, 0x0a6f], [0x0ae6, 0x0aef],
    [0x0b66, 0x0b6f], [0x0be6, 0x0bef], [0x0c66, 0x0c6f], [0x0ce6, 0x0cef], [0x0d66, 0x0d6f], [0x0e50, 0x0e59],
    [0x0ed0, 0x0ed9], [0x0f20, 0x0f29], [0x1040, 0x1049], [0x17e0, 0x17e9], [0x1810, 0x1819], [0xff10, 0xff19],
  ];
  return value.replace(/\p{Nd}/gu, (character) => {
    const point = character.codePointAt(0) || 0;
    const range = digitRanges.find(([start, end]) => point >= start && point <= end);
    return range ? String(point - range[0]) : character;
  });
}

function normalizeInput(value: string): string {
  const visibleText = String(value || '')
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6]|pre|code|kbd|table|section|article|header|footer)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return normalizeDigits(decodeHtmlEntities(visibleText.normalize('NFKC')))
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function hasMixedCaseLetters(value: string): boolean {
  return /[A-Z]/.test(value) && /[a-z]/.test(value);
}

function uniqueAlphaRatio(value: string): number {
  const letters = value.replace(/[^A-Za-z]/g, '');
  if (!letters) return 0;
  return new Set(letters.toUpperCase()).size / letters.length;
}

function isBrandOrDictionaryToken(upper: string): boolean {
  if (BRAND_OR_PRODUCT_WORDS.has(upper)) return true;
  // Reject obvious title-case product compounds without digits.
  if (/^(?:CHAT|OPEN|MICRO|FACE|LINK|YOU|NET|CLOUD|DROP)/.test(upper) && upper.length >= 6) {
    if (!/\d/.test(upper)) return true;
  }
  return false;
}

/**
 * Structural validity of a candidate token.
 * Pure alpha is only accepted when allowAlphaOnly is true (caller must have strong evidence).
 */
function isLikelyCode(value: string, options: { allowAlphaOnly?: boolean } = {}): boolean {
  if (!value) return false;
  if (/^(\d)\1+$/.test(value) || /^([A-Z0-9])\1+$/i.test(value)) return false;
  if (/^20\d{2}$/.test(value) || /^(?:19|20)\d{6}$/.test(value)) return false;
  if (/^\d{9,}$/.test(value)) return false;
  if (/^(?:19|20)\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?$/.test(value)) return false;
  if (/^[A-Z]{2,}[A-Z0-9]*\d+(?:\.\d+)+(?:[A-Z][A-Z0-9]*)?$/i.test(value)) return false;
  if (/^[A-Z]{2,}\d+[A-Z]{4,}$/i.test(value)) return false;

  const upper = value.toUpperCase();
  if (isBrandOrDictionaryToken(upper)) return false;
  const productVersion = upper.match(/^([A-Z]{2,12})\d{1,4}$/);
  if (productVersion && PRODUCT_VERSION_PREFIXES.has(productVersion[1])) return false;

  // Pure numeric OTP: 4-8 digits.
  if (/^\d{4,8}$/.test(value)) return true;

  const hasDigit = /\d/.test(value);
  if (hasDigit) {
    // Mixed alphanumeric with at least one digit, short OTP shape.
    if (!/^[A-Za-z0-9]{4,10}$/.test(value)) return false;
    const letters = value.replace(/[^A-Za-z]/g, '');
    if (letters.length > 5) return false;
    if (/[A-Za-z]{5,}/.test(value) && (value.match(/\d/g) || []).length < 2) return false;
    return true;
  }

  // Pure alphabetic — extremely strict.
  if (!options.allowAlphaOnly) return false;
  if (!/^[A-Za-z]{5,8}$/.test(value)) return false;
  // Natural sentence words such as "Received" are title-cased, unlike mixed-case OTPs.
  if (/^[A-Z][a-z]+$/.test(value)) return false;
  // Require mixed case (Notion-style rxthEC). All-caps/all-lower product words fail.
  if (!hasMixedCaseLetters(value)) return false;
  if (uniqueAlphaRatio(value) < 0.7) return false;
  return true;
}

export function sanitizeVerificationCode(value: unknown, options: { allowAlphaOnly?: boolean } = {}): string | undefined {
  const original = String(value || '').normalize('NFKC').trim();
  if (!original) return undefined;
  const compact = normalizeDigits(original).replace(/[^A-Za-z0-9]/g, '');
  if (!compact) return undefined;

  // Keep original casing when it is the same alphanumeric sequence.
  const cased = original.replace(/[^A-Za-z0-9]/g, '');
  const candidate = cased && cased.toUpperCase() === compact.toUpperCase() ? cased : compact;
  if (!isLikelyCode(candidate, options)) return undefined;
  if (/^\d+$/.test(candidate)) return candidate;
  return candidate;
}

type Token = { raw: string; start: number; end: number };
type Candidate = {
  code: string;
  score: number;
  firstIndex: number;
  hasDigit: boolean;
  strong: boolean;
};

function lineBounds(text: string, index: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const lineBreak = text.indexOf('\n', index);
  return { start, end: lineBreak === -1 ? text.length : lineBreak };
}

function tokenize(line: string, offset: number): Token[] {
  return [...line.matchAll(TOKEN_PATTERN)].map((match) => {
    const raw = match[1] || '';
    const start = offset + (match.index || 0);
    return { raw, start, end: start + raw.length };
  });
}

function isCodeConnector(value: string): boolean {
  const words = value.match(/[A-Za-z\u4e00-\u9fff]+/gu) || [];
  return words.every((word) => CONNECTOR_WORDS.test(word)) && value.length <= 48;
}

function scoreCode(code: string, distance: number, strong: boolean, highlighted = false): number {
  const hasDigit = /\d/.test(code);
  let score = strong ? 100 : 40;
  if (highlighted) score += 50;
  if (hasDigit) score += 40;
  else score -= 15; // pure alpha is weaker unless highlighted
  if (/^\d{6}$/.test(code)) score += 20;
  else if (/^\d{4,8}$/.test(code)) score += 12;
  else if (hasDigit) score += 6;
  score -= Math.min(40, distance);
  return score;
}

function candidatesNearContext(
  text: string,
  start: number,
  end: number,
  contextIndex: number,
  contextEnd: number,
  options: { enforceBridge?: boolean; allowAlphaOnly?: boolean; strong?: boolean } = {},
): Candidate[] {
  const enforceBridge = options.enforceBridge !== false;
  const allowAlphaOnly = Boolean(options.allowAlphaOnly);
  const strong = options.strong !== false;
  const line = text.slice(start, end);
  if (ADDRESS_LINE_PATTERN.test(line) || /\b(?:[A-Z]{2}\s+(?:\d{5}(?:-\d{4})?|\d{6})|(?:\d{5}(?:-\d{4})?|\d{6})\s+[A-Z]{2})\b/.test(line)) {
    // Still allow pure digit OTP on address-looking lines only if bridge is tight.
    if (!enforceBridge) return [];
  }

  const tokens = tokenize(line, start);
  const out: Candidate[] = [];
  const push = (raw: string, candidateStart: number, candidateEnd: number, alphaOk: boolean, penalty = 0) => {
    const code = sanitizeVerificationCode(raw, { allowAlphaOnly: alphaOk && allowAlphaOnly });
    if (!code) return;
    if (enforceBridge) {
      const bridge = candidateStart >= contextEnd
        ? line.slice(Math.max(0, contextEnd - start), Math.max(0, candidateStart - start))
        : line.slice(Math.max(0, candidateEnd - start), Math.max(0, contextIndex - start));
      if (!isCodeConnector(bridge.trim())) return;
    }
    const trailing = line.slice(Math.max(0, candidateEnd - start));
    if (/^\s*(?:\d{1,4}(?:st|nd|rd|th)\b|street\b|road\b|avenue\b|drive\b)/iu.test(trailing) && /^\d+$/.test(code)) return;
    const distance = Math.abs(candidateStart - contextIndex);
    if (distance > 96) return;
    out.push({
      code,
      score: scoreCode(code, distance, strong) - penalty,
      firstIndex: candidateStart,
      hasDigit: /\d/.test(code),
      strong,
    });
  };

  for (const token of tokens) {
    // Prefer digit-bearing tokens; alpha-only only when explicitly allowed.
    push(token.raw, token.start, token.end, true);
  }

  // Join spaced digit groups: "123 456"
  for (let index = 0; index < tokens.length; index += 1) {
    const first = tokens[index];
    if (!/^\d+$/.test(first.raw)) continue;
    let compact = first.raw;
    let last = first;
    for (let nextIndex = index + 1; nextIndex < Math.min(tokens.length, index + 3); nextIndex += 1) {
      const next = tokens[nextIndex];
      const gap = text.slice(last.end, next.start);
      if (!/^\s+$/.test(gap) || !/^\d+$/.test(next.raw)) break;
      compact += next.raw;
      last = next;
      if (compact.length >= 4 && compact.length <= 8) {
        const suffixPenalty = first.raw.length >= 6 && compact.length > first.raw.length ? 24 : 0;
        push(compact, first.start, last.end, false, suffixPenalty);
      }
      if (compact.length >= 8) break;
    }
  }

  // Letter+digit pairs: "AB 7281"
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const first = tokens[index];
    const next = tokens[index + 1];
    if (!/^[A-Za-z]{1,4}$/.test(first.raw) || CONNECTOR_WORDS.test(first.raw) || !/^\d{2,8}$/.test(next.raw)) continue;
    if (!/^\s+$/.test(text.slice(first.end, next.start))) continue;
    push(`${first.raw}${next.raw}`, first.start, next.end, false, 2);
  }

  return out;
}

function collectHighlightedCodes(source: string): Candidate[] {
  const rawSource = String(source || '');
  if (!rawSource) return [];
  const visibleSource = normalizeInput(rawSource);
  CODE_CONTEXT_PATTERN.lastIndex = 0;
  const hasExplicitContext = CODE_CONTEXT_PATTERN.test(visibleSource);
  CODE_CONTEXT_PATTERN.lastIndex = 0;
  SOFT_LOGIN_CONTEXT.lastIndex = 0;
  const hasSoftLoginContext = SOFT_LOGIN_CONTEXT.test(visibleSource);
  SOFT_LOGIN_CONTEXT.lastIndex = 0;
  const hasVerificationContext = hasExplicitContext || hasSoftLoginContext;
  const candidates: Candidate[] = [];
  const patternGroups: Array<{ source: string; patterns: Array<{ re: RegExp; allowAlpha: boolean; bonus: number }> }> = [
    {
      source: hasVerificationContext ? rawSource : '',
      patterns: [
        // Structural emphasis is safe to read from markup because the candidate is element text, not an attribute.
        { re: /<(?:pre|code|kbd)[^>]*>\s*([A-Za-z0-9][A-Za-z0-9._-]{3,15})\s*<\/(?:pre|code|kbd)>/gi, allowAlpha: true, bonus: 60 },
      ],
    },
    {
      source: visibleSource,
      patterns: [
        // Never inspect href/query attributes here; normalizeInput has already removed markup attributes.
        { re: /(?<![A-Za-z0-9_?&/.-])(?:验证码|校验码|动态码|安全码|登录码|认证码|code|otp|passcode|password|token)[^\S\r\n]*[:：=][^\S\r\n]*([A-Za-z0-9][A-Za-z0-9._-]{3,15})/gi, allowAlpha: true, bonus: 50 },
        { re: /(?<![A-Za-z0-9_?&/.-])(?:verification code|security code|login code|one(?:-|[^\S\r\n])?time code|your code)[^\S\r\n]*(?:is|:)?[^\S\r\n]*([A-Za-z0-9]{4,10})/gi, allowAlpha: true, bonus: 48 },
      ],
    },
  ];

  for (const group of patternGroups) {
    for (const { re, allowAlpha, bonus } of group.patterns) {
      re.lastIndex = 0;
      for (const match of group.source.matchAll(re)) {
        const raw = match[1] || '';
        const code = sanitizeVerificationCode(raw, { allowAlphaOnly: allowAlpha });
        if (!code) continue;
        if (!/\d/.test(code) && !hasMixedCaseLetters(code)) continue;
        const index = match.index || 0;
        candidates.push({
          code,
          score: scoreCode(code, 0, true, true) + bonus,
          firstIndex: index,
          hasDigit: /\d/.test(code),
          strong: true,
        });
      }
    }
  }
  return candidates;
}

function dedupe(items: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const item of items) {
    const key = item.code.toUpperCase();
    const existing = best.get(key);
    if (!existing || item.score > existing.score) best.set(key, item);
  }
  // Drop pure-alpha when a digit code exists with comparable/higher confidence.
  let values = [...best.values()];
  const hasStrongDigit = values.some((item) => item.hasDigit && item.score >= 100);
  values = values.filter((item) => {
    if (item.hasDigit) return true;
    if (hasStrongDigit && item.score < 160) return false;
    return item.strong && item.score >= 120;
  });
  // Drop longer numeric supersets that only exist because a shorter OTP was glued to a trailing number
  // e.g. "683744 96" while "Your code is 683744" already provided the real OTP.
  values = values.filter((item) => {
    if (!/^\d+$/.test(item.code) || item.code.length < 7) return true;
    return !values.some((other) => (
      other !== item
      && /^\d+$/.test(other.code)
      && other.code.length >= 4
      && other.code.length < item.code.length
      && item.code.startsWith(other.code)
      && other.score + 8 >= item.score
    ));
  });
  return values;
}

export function extractVerificationCodes(text = '', extraSources: string[] = []): string[] {
  const sourceBundle = [text, ...extraSources].filter(Boolean).join('\n');
  const normalized = normalizeInput(sourceBundle);
  const pool: Candidate[] = [];

  pool.push(...collectHighlightedCodes(sourceBundle));

  CODE_CONTEXT_PATTERN.lastIndex = 0;
  for (const context of normalized.matchAll(CODE_CONTEXT_PATTERN)) {
    const contextIndex = context.index || 0;
    const contextEnd = contextIndex + context[0].length;
    const bounds = lineBounds(normalized, contextIndex);
    let lineCandidates = candidatesNearContext(normalized, bounds.start, bounds.end, contextIndex, contextEnd, {
      enforceBridge: true,
      allowAlphaOnly: true,
      strong: true,
    });

    // Next 1-2 lines: lone OTP after "Your code is" / "验证码" / Notion title.
    if (!lineCandidates.length) {
      let cursor = bounds.end + 1;
      for (let hop = 0; hop < 2 && cursor < normalized.length; hop += 1) {
        const nextBounds = lineBounds(normalized, cursor);
        const nextLine = normalized.slice(nextBounds.start, nextBounds.end).trim();
        if (!nextLine) {
          cursor = nextBounds.end + 1;
          continue;
        }
        const tokens = tokenize(nextLine, nextBounds.start);
        const lone = tokens.length === 1 ? tokens[0] : null;
        const firstToken = tokens[0];
        const digitFirst = firstToken && (/^\d{4,8}$/.test(firstToken.raw.replace(/[^\d]/g, '')) || /\d/.test(firstToken.raw))
          ? firstToken
          : null;
        if (lone) {
          lineCandidates = candidatesNearContext(normalized, nextBounds.start, nextBounds.end, contextIndex, contextEnd, {
            enforceBridge: false,
            allowAlphaOnly: true,
            strong: true,
          });
        } else if (digitFirst) {
          lineCandidates = candidatesNearContext(normalized, nextBounds.start, nextBounds.end, contextIndex, contextEnd, {
            enforceBridge: false,
            allowAlphaOnly: false,
            strong: true,
          });
        }
        if (lineCandidates.length) break;
        // Stop if the next line looks like prose rather than a code.
        if (tokens.length > 3) break;
        cursor = nextBounds.end + 1;
      }
    }
    pool.push(...lineCandidates);
  }

  // Soft login title + lone mixed-case alpha line (Notion without explicit "code" word).
  if (!pool.some((item) => item.score >= 140)) {
    SOFT_LOGIN_CONTEXT.lastIndex = 0;
    for (const soft of normalized.matchAll(SOFT_LOGIN_CONTEXT)) {
      const contextIndex = soft.index || 0;
      const bounds = lineBounds(normalized, contextIndex);
      let cursor = bounds.end + 1;
      for (let hop = 0; hop < 2 && cursor < normalized.length; hop += 1) {
        const nextBounds = lineBounds(normalized, cursor);
        const nextLine = normalized.slice(nextBounds.start, nextBounds.end).trim();
        if (!nextLine) {
          cursor = nextBounds.end + 1;
          continue;
        }
        const tokens = tokenize(nextLine, nextBounds.start);
        if (tokens.length === 1) {
          const code = sanitizeVerificationCode(tokens[0].raw, { allowAlphaOnly: true });
          if (code && !/\d/.test(code) && hasMixedCaseLetters(code)) {
            pool.push({
              code,
              score: scoreCode(code, 8, true, true) + 20,
              firstIndex: tokens[0].start,
              hasDigit: false,
              strong: true,
            });
            break;
          }
          if (code && /\d/.test(code)) {
            pool.push({
              code,
              score: scoreCode(code, 8, true, true) + 20,
              firstIndex: tokens[0].start,
              hasDigit: true,
              strong: true,
            });
            break;
          }
        }
        if (tokens.length > 2) break;
        cursor = nextBounds.end + 1;
      }
    }
  }

  const ranked = dedupe(pool).sort((a, b) => b.score - a.score || a.firstIndex - b.firstIndex);
  // Hard floor: only return confident hits.
  return ranked.filter((item) => item.score >= 100).slice(0, 3).map((item) => item.code);
}

export function extractVerificationCode(text = '', extraSources: string[] = []): string | undefined {
  return extractVerificationCodes(text, extraSources)[0];
}
