import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildSessionCacheKey, clearJwtFromHref, readJwtFromHref } from "../src/auth.ts";
import { subscribeAuthenticationFailures } from "../src/authFailure.ts";
import { ApiError, fetchSafeSettings } from "../src/api.ts";
import { MAILBOX_CACHE_VERSION, prepareMailboxCachePayload } from "../src/cache.ts";
import { copyText } from "../src/clipboard.ts";
import { isChunkLoadError } from "../src/appRecovery.ts";
import { reconcileServerMailRange } from "../src/mailSync.ts";
import { buildMailFrameSrcDoc, isSafeNavigationUrl, parseRawMail, sanitizeMailHtml } from "../src/mailParser.ts";
import { proxyMailImageSrcset, proxyMailImageUrl } from "../src/mailImageProxy.ts";
import { extractVerificationCode, extractVerificationCodes } from "../../shared/verificationCode.ts";
import { getFallbackAvatarColor } from "../../shared/avatarColor.ts";

function readWebmailSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function extractCssBlock(source: string, marker: string) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing CSS block: ${marker}`);
  const openBraceIndex = source.indexOf("{", markerIndex);
  assert.notEqual(openBraceIndex, -1, `missing opening brace for CSS block: ${marker}`);

  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(openBraceIndex + 1, index);
  }

  assert.fail(`missing closing brace for CSS block: ${marker}`);
}

function readCssVariable(block: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`--${escapedName}\\s*:\\s*([^;]+);`));
  assert.ok(match, `missing CSS variable --${name}`);
  return match[1].trim().replace(/\s+/g, " ");
}

test("webmail sanitizer fails closed when DOMParser is unavailable", () => {
  const sanitized = sanitizeMailHtml(
    '<p>Hello</p><a href="javascript:alert(1)">Open</a><img src=x onerror=alert(1)><script>alert(1)</script>'
  );
  assert.match(sanitized, /Hello/);
  assert.doesNotMatch(sanitized, /<(?:a|img|script)\b|javascript:|onerror/i);
});

test("webmail navigation URL policy uses an explicit scheme allowlist", () => {
  assert.equal(isSafeNavigationUrl("https://example.com/path"), true);
  assert.equal(isSafeNavigationUrl("/relative/path"), true);
  assert.equal(isSafeNavigationUrl("mailto:user@example.com"), true);
  assert.equal(isSafeNavigationUrl("data:image/png;base64,AA=="), true);
  assert.equal(isSafeNavigationUrl("javascript:alert(1)"), false);
  assert.equal(isSafeNavigationUrl("java\nscript:alert(1)"), false);
  assert.equal(isSafeNavigationUrl("vbscript:msgbox(1)"), false);
  assert.equal(isSafeNavigationUrl("file:///etc/passwd"), false);
  assert.equal(isSafeNavigationUrl("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isSafeNavigationUrl("data:image/svg+xml,<svg onload=alert(1)>"), false);
});

test("webmail routes remote mail images through its same-origin proxy", () => {
  assert.equal(
    proxyMailImageUrl("https://assets.example.com/notion-logo.png", "https://mail.example.test"),
    "https://mail.example.test/api/image?url=https%3A%2F%2Fassets.example.com%2Fnotion-logo.png",
  );
  assert.equal(proxyMailImageUrl("data:image/png;base64,AA==", "https://mail.example.test"), "data:image/png;base64,AA==");
  assert.equal(proxyMailImageUrl("javascript:alert(1)", "https://mail.example.test"), "");
  assert.equal(
    proxyMailImageSrcset(
      "data:image/png;base64,AA== 1x, https://assets.example.com/notion-logo.png 2x",
      "https://mail.example.test",
    ),
    "data:image/png;base64,AA== 1x, https://mail.example.test/api/image?url=https%3A%2F%2Fassets.example.com%2Fnotion-logo.png 2x",
  );
});

test("webmail verification extraction uses the same high-confidence filtering", () => {
  const newsletter = "OpenAI Dev News: OpenAI Built Codex\n&#8199; &#8205; GPT-5.6-Terra\nOpenAI\n1455 3rd Street\nSan Francisco, CA 94158";
  assert.deepEqual(extractVerificationCodes(newsletter), []);
  assert.equal(extractVerificationCode(newsletter), undefined);
  assert.equal(extractVerificationCode("Your login code is 956125"), "956125");
  assert.equal(extractVerificationCode("登录 Notion\nrxthEC\nNever share this code with anyone."), "rxthEC");
  assert.equal(
    extractVerificationCode("登录 Notion", ['<pre style="text-align:center">rxthEC</pre><a href="https://notion.example.test/?password=rxthEC">login</a>']),
    "rxthEC",
  );
  assert.deepEqual(extractVerificationCodes("ChatGPT\nYour verification code is 847291"), ["847291"]);
  assert.deepEqual(extractVerificationCodes("Your ChatGPT code is 123456"), ["123456"]);
  assert.deepEqual(extractVerificationCodes("antarctic clicking something code"), []);
  assert.deepEqual(
    extractVerificationCodes("Your verification code is 604181", ['<a href="https://example.test/click?token=54382401&code=ABCD1234">continue</a>']),
    ["604181"],
  );
  assert.deepEqual(extractVerificationCodes("Developer newsletter", ["<code>ABCD1234</code>"]), []);
  assert.deepEqual(extractVerificationCodes("Your code is GPT-6"), []);
  assert.deepEqual(extractVerificationCodes("Security notice\nCA 994158"), []);
});

test("webmail mail parsing applies the shared high-confidence verification filter", async () => {
  const parsed = await parseRawMail({
    id: 1,
    raw: "From: OpenAI <news@example.com>\r\nSubject: OpenAI Built Codex\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOpenAI\r\n1455 3rd Street\r\nSan Francisco, CA 94158\r\nGPT-5.6-Terra",
  });
  assert.equal(parsed.verificationCode, undefined);

  const parsedHtmlOtp = await parseRawMail({
    id: 2,
    raw: [
      "From: ChatGPT <noreply@example.com>",
      "Subject: =?UTF-8?B?5L2g55qE5Li05pe2IENoYXRHUFQg55m75b2V5Luj56CB?=",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><head><style>.code{font-family:monospace}</style></head><body>",
      "<p>输入此临时验证码以继续：</p>",
      "",
      "<p class=\"code\"><!--[if mso]><span><![endif]-->956125<!--[if mso]></span><![endif]--></p>",
      "<p>未请求验证码？你可以忽略此邮件。</p>",
      "</body></html>",
    ].join("\r\n"),
  });
  assert.deepEqual(parsedHtmlOtp.verificationCodes, ["956125"]);
});

test("webmail clipboard falls back to a temporary textarea and copies only trimmed code text", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  let copiedCommand = "";
  let appendedValue = "";
  let removed = false;
  const textarea = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: () => undefined,
    focus: () => undefined,
    select: () => undefined,
    setSelectionRange: () => undefined,
    remove: () => { removed = true; },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => { throw new Error("blocked"); } } },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      activeElement: null,
      body: { appendChild: (node: typeof textarea) => { appendedValue = node.value; } },
      createElement: () => textarea,
      execCommand: (command: string) => { copiedCommand = command; return true; },
    },
  });
  try {
    await copyText("  604181  ");
    assert.equal(appendedValue, "604181");
    assert.equal(copiedCommand, "copy");
    assert.equal(removed, true);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete (globalThis as { document?: unknown }).document;
  }
});

test("webmail exposes every high-confidence code as an individually copyable list action", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const workspace = readWebmailSource("../src/mailWorkspace.css");
  assert.match(source, /verificationCodes\.map\(\(code\)\s*=>/);
  assert.doesNotMatch(source, /mail-detail-code-strip|selectedVerificationCodes/);
  assert.match(source, /function VerificationCodeButton/);
  assert.match(source, /className="verification-code-value"/);
  assert.match(source, /className="mail-subject-line"[\s\S]*className="mail-subject"[\s\S]*className="code-row"[\s\S]*className="mail-row-footer"/);
  assert.doesNotMatch(source, /className="verification-code-action"/);
  assert.match(workspace, /\.verification-code-button\s*\{[^}]*display:\s*inline-grid;[^}]*place-items:\s*center;[^}]*line-height:\s*1;/s);
  assert.match(workspace, /\.mail-subject-line\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
  assert.match(workspace, /\.mail-list-item \.code-row\s*\{[^}]*flex:\s*0 0 auto;[^}]*margin:\s*0;/s);
  assert.match(workspace, /\.verification-code-button\.copied\s*\{[^}]*color:\s*var\(--lm-success\);/s);
});

test("webmail uses white only for real brand icons and deterministic color for initials", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.brand-avatar img\s*\{[^}]*width:\s*85%\s*!important;[^}]*height:\s*85%\s*!important;[^}]*object-fit:\s*contain\s*!important;[^}]*clip-path:\s*none\s*!important;/s);
  assert.match(styles, /\.brand-avatar-with-icon\s*\{[^}]*background:\s*#fff\s*!important;/s);
  assert.match(styles, /\.brand-avatar-fallback\s*\{[^}]*background:\s*var\(--brand-avatar-fallback-bg\)\s*!important;[^}]*color:\s*#fff\s*!important;[^}]*font-size:\s*calc\(var\(--brand-avatar-size\) \* \.456\);[^}]*font-weight:\s*560/s);
  assert.equal(getFallbackAvatarColor('letter@example.test'), getFallbackAvatarColor('letter@example.test'));
  assert.equal(getFallbackAvatarColor('letter@example.test', 'First label'), getFallbackAvatarColor('letter@example.test', 'Renamed label'));
  assert.notEqual(getFallbackAvatarColor('letter@example.test'), getFallbackAvatarColor('other@example.test'));
});

test("webmail loads theme tokens and the signed-in workspace layer after legacy styles", () => {
  const app = readWebmailSource("../src/App.tsx");
  const cssImports = [...app.matchAll(/import\s+["']([^"']+\.css)["'];/g)].map((match) => match[1]);
  assert.deepEqual(cssImports.slice(-3), ["./styles.css", "./theme.css", "./mailWorkspace.css"]);
  assert.ok(cssImports.indexOf("./theme.css") < cssImports.indexOf("./mailWorkspace.css"));

  const html = readWebmailSource("../index.html");
  assert.match(html, /<meta name="theme-color" content="#efeee9"\s*\/>/);
  assert.match(html, /localStorage\.getItem\("loven7\.uiTheme"\)/);
});

test("webmail exposes an instant persistent light and dark theme toggle", () => {
  const app = readWebmailSource("../src/App.tsx");
  const appearance = readWebmailSource("../src/appearance.ts");
  const styles = readWebmailSource("../src/styles.css");
  const theme = readWebmailSource("../src/theme.css");

  assert.match(app, /const \[theme, setTheme\] = useState<AppTheme>\(\(\) => readInitialTheme\(\)\)/);
  assert.match(app, /<WebmailThemeToggle theme=\{theme\} setTheme=\{setTheme\}/);
  assert.match(app, /useLayoutEffect\(\(\) => \{\s*writeTheme\(theme\);\s*applyRuntimeTheme\(theme\);/s);
  assert.match(appearance, /const STORAGE_KEY = "loven7\.uiTheme"/);
  assert.match(appearance, /document\.documentElement\.dataset\.theme = theme/);
  assert.match(theme, /:root\[data-theme="dark"\]\s*\{[^}]*--lm-bg:\s*#141413;/s);
  assert.equal((styles.match(/@media \(prefers-color-scheme: dark\)/g) || []).length, 0, "manual theme must own component dark styles");
  assert.equal((theme.match(/@media \(prefers-color-scheme: dark\)/g) || []).length, 1, "only the no-script token fallback may follow the OS theme");
});

test("signed-in webmail uses Admin mail workspace semantics and exposes no password-management entry", () => {
  const app = readWebmailSource("../src/App.tsx");
  const api = readWebmailSource("../src/api.ts");
  const workspace = readWebmailSource("../src/mailWorkspace.css");

  for (const className of [
    "mail-workspace",
    "mail-list-panel",
    "mail-list-header",
    "mail-list-viewport",
    "mail-list-item",
    "mail-row-selected",
    "mail-row-idle",
    "mail-detail-pane",
    "mail-detail-card",
    "mail-detail-topbar",
    "mail-detail-header",
    "mail-detail-sender-row",
    "mail-detail-body",
    "mail-list-topbar",
  ]) {
    assert.match(app, new RegExp(`className=[^\\n]*${className}|className=\\{[^\\n]*${className}`), `missing Admin-aligned class ${className}`);
    assert.match(workspace, new RegExp(`\\.${className}\\b`), `missing workspace styling for ${className}`);
  }

  assert.doesNotMatch(app, /changeAddressPassword|passwordDialogOpen|newMailboxPassword|passwordSaving|saveMailboxPassword|changePasswordTitle|修改密码|Change password/);
  assert.doesNotMatch(api, /address_change_password|changeAddressPassword/);
  assert.doesNotMatch(workspace, /webmail-modal/);
  const signedHeaderStart = app.indexOf('<aside className="sidebar mail-list-panel"');
  const signedAccountStart = app.indexOf('<div className="account-card">', signedHeaderStart);
  assert.ok(signedHeaderStart > 0 && signedAccountStart > signedHeaderStart);
  assert.doesNotMatch(app.slice(signedHeaderStart, signedAccountStart), /<BrandLogo/);
});

test("webmail uses one bundled Maple Mono family for Chinese, Latin, and verification codes", () => {
  const theme = readWebmailSource("../src/theme.css");
  const workspace = readWebmailSource("../src/mailWorkspace.css");

  assert.match(theme, /@font-face\s*\{[^}]*font-family:\s*"Loven7 Maple Mono";[^}]*local\("Maple Mono NF CN"\)[^}]*maple-mono-nf-cn-web\.woff2[^}]*font-display:\s*swap;/s);
  assert.match(theme, /--apple-cn-font-ui:[^;]*"Loven7 Maple Mono"[^;]*"Maple Mono NF CN"[^;]*Noto Sans Mono CJK SC[^;]*Microsoft YaHei UI/s);
  assert.match(theme, /--font-code:\s*var\(--apple-cn-font-ui\)/);
  assert.match(theme, /:root\[data-font-mode="en"\][\s\S]*--mail-ui-font:\s*var\(--font-ui\)/);
  assert.match(workspace, /\.mail-workspace,[\s\S]*font-family:\s*var\(--mail-ui-font, var\(--font-ui\)\)\s*!important/);
  assert.match(workspace, /\.mail-title-heading\s*\{[\s\S]*font-family:\s*var\(--mail-ui-font, var\(--font-ui\)\)\s*!important[\s\S]*font-weight:\s*600\s*!important/);
  assert.match(workspace, /\.mail-subject\s*\{[\s\S]*font-family:\s*var\(--mail-ui-font, var\(--font-ui\)\)\s*!important[\s\S]*font-weight:\s*600\s*!important/);
  assert.match(workspace, /\.verification-code-button\s*\{[\s\S]*font-family:\s*var\(--font-code\)\s*!important/);
  assert.match(workspace, /\.mail-detail-subject,[\s\S]*font-weight:\s*550\s*!important/);
});

test("signed-in mail list uses calm hierarchy, visible row boundaries, and inline verification actions", () => {
  const workspace = readWebmailSource("../src/mailWorkspace.css");

  assert.match(workspace, /\.mail-list-topbar\s*\{[^}]*justify-content:\s*space-between;[^}]*margin-bottom:\s*10px;/s);
  assert.match(workspace, /\.mail-list-item\.mail-row\s*\{[^}]*border:\s*1px solid var\(--lm-border\);[^}]*border-radius:\s*10px;[^}]*background:\s*var\(--lm-surface\);/s);
  assert.match(workspace, /\.mail-list-viewport\.mail-list\s*\{[^}]*gap:\s*8px;/s);
  assert.doesNotMatch(workspace, /\.mail-count-badge/);
  assert.doesNotMatch(workspace, /\.mail-list-header \.brand-logo-compact/);
  assert.doesNotMatch(readWebmailSource("../src/App.tsx"), /mail-list-recipient-inline/);
  assert.match(readWebmailSource("../src/App.tsx"), /formatListDate\(mail\.date \|\| mail\.createdAt, locale\)/);
  assert.match(workspace, /\.mail-list-header \.address-copy-text\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/s);
  assert.match(workspace, /\.mail-list-header \.mail-toolbar\s*\{[^}]*display:\s*inline-flex;[^}]*gap:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(workspace, /\.mail-list-header \.mail-toolbar \.refresh-label\s*\{[^}]*clip:\s*rect\(0 0 0 0\);/s);
});

test("webmail keeps read messages visibly interactive and removes the desktop reader spacer", () => {
  const workspace = readWebmailSource("../src/mailWorkspace.css");

  assert.doesNotMatch(workspace, /\.mail-list-item\.mail-row\.(?:read|unread)\s*\{/);
  assert.doesNotMatch(workspace, /\.mail-list-item\.read\s+:is\([^)]*\.mail-subject/);
  assert.match(workspace, /\.mail-list-item\.mail-row-selected[\s\S]*background:\s*var\(--lm-selected\)/);
  assert.match(workspace, /\.mail-detail-card\.mail-detail\s*\{[\s\S]*position:\s*relative/);
  assert.match(workspace, /\.mail-detail-topbar\s*\{[\s\S]*position:\s*absolute/);
  assert.match(workspace, /@media\s*\(max-width:\s*760px\)[\s\S]*\.mail-detail-topbar\s*\{[\s\S]*position:\s*static/);
});

test("webmail theme keeps Admin semantics with a Codex-inspired charcoal palette", () => {
  const webmailTheme = readWebmailSource("../src/theme.css");
  const adminTheme = readWebmailSource("../../admin/src/theme.css");
  const webmailLight = extractCssBlock(webmailTheme, ":root");
  const adminLight = extractCssBlock(adminTheme, ":root");
  const webmailDarkMedia = extractCssBlock(webmailTheme, "@media (prefers-color-scheme: dark)");
  const webmailDark = extractCssBlock(webmailDarkMedia, ":root:not([data-theme])");
  const adminDark = extractCssBlock(adminTheme, ".theme-dark");

  const coreMappings = [
    ["bg", "bg"],
    ["surface", "panel"],
    ["surface-soft", "panel-soft"],
    ["surface-muted", "panel-muted"],
    ["surface-hover", "panel-hover"],
    ["border", "border"],
    ["divider", "divider"],
    ["text-strong", "text-strong"],
    ["text", "text"],
    ["text-soft", "text-soft"],
    ["muted", "muted"],
    ["muted-soft", "muted-soft"],
    ["ink", "ink"],
    ["ink-hover", "ink-hover"],
    ["ink-on", "ink-on"],
    ["accent", "accent"],
    ["accent-hover", "accent-hover"],
    ["accent-soft", "accent-soft"],
    ["accent-strong", "accent-strong"],
    ["success", "success"],
    ["success-soft", "success-soft"],
    ["warning", "warning"],
    ["warning-soft", "warning-soft"],
    ["danger", "danger"],
    ["danger-soft", "danger-soft"],
  ] as const;

  for (const [webmailName, adminName] of coreMappings) {
    assert.ok(readCssVariable(webmailLight, `lm-${webmailName}`), `missing light semantic token --lm-${webmailName}`);
    assert.ok(readCssVariable(webmailDark, `lm-${webmailName}`), `missing dark semantic token --lm-${webmailName}`);
    assert.ok(readCssVariable(adminLight, `admin-${adminName}`), `missing Admin semantic token --admin-${adminName}`);
    assert.ok(readCssVariable(adminDark, `admin-${adminName}`), `missing Admin dark semantic token --admin-${adminName}`);
  }

  assert.equal(readCssVariable(webmailDark, "lm-bg"), "#141413");
  assert.equal(readCssVariable(webmailDark, "lm-text-strong"), "#f5f4ee");
  assert.equal(readCssVariable(webmailDark, "lm-accent"), "#da7756");

  for (const radius of ["panel", "card", "control", "control-sm", "pill"] as const) {
    assert.equal(
      readCssVariable(webmailLight, `lm-radius-${radius}`),
      readCssVariable(adminLight, `admin-radius-${radius}`),
      `radius --lm-radius-${radius} should match Admin`,
    );
  }
});

test("webmail mobile panes remain full-screen without desktop card gutters", () => {
  const baseStyles = readWebmailSource("../src/styles.css");
  const theme = readWebmailSource("../src/theme.css");
  const baseMobile = extractCssBlock(baseStyles, "@media (max-width: 760px)");
  const themeMobile = extractCssBlock(theme, "@media (max-width: 760px)");

  assert.match(baseStyles, /html,\s*body,\s*#root\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*100dvh;[^}]*overflow:\s*hidden;/s);
  assert.match(baseStyles, /\.app-shell\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/s);
  assert.match(baseMobile, /\.app-shell\s*\{[^}]*grid-template-columns:\s*1fr;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/s);
  assert.match(baseMobile, /\.sidebar,\s*\.reader\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s);
  assert.match(themeMobile, /\.app-shell\s*\{[^}]*padding:\s*0;[^}]*gap:\s*0;/s);
  assert.match(themeMobile, /\.sidebar,\s*\.reader\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
  assert.match(themeMobile, /\.reader\s*\{[^}]*padding:\s*0;[^}]*background:\s*var\(--lm-surface\);/s);
  assert.match(themeMobile, /\.mail-detail\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/s);
});

test("HTML mail keeps a white rendering canvas in both light and dark themes", () => {
  const theme = readWebmailSource("../src/theme.css");
  const mailParser = readWebmailSource("../src/mailParser.ts");

  assert.match(
    theme,
    /\.mail-body-shell\.mode-html,\s*\.mail-frame,\s*\.mail-html-view\s*\{[^}]*background:\s*#ffffff;/s,
  );
  assert.match(mailParser, /html\{[^}]*background:#fff;[^}]*\}body\{[^}]*background:#fff;/s);
});

test("mailbox cache key is isolated by API origin and mailbox identity", async () => {
  const first = await buildSessionCacheKey("https://mail-a.example", "user@example.com", "jwt-a");
  const otherApi = await buildSessionCacheKey("https://mail-b.example", "user@example.com", "jwt-a");
  const otherAccount = await buildSessionCacheKey("https://mail-a.example", "other@example.com", "jwt-a");
  assert.notEqual(first, otherApi);
  assert.notEqual(first, otherAccount);
});

test("cache truncation keeps offset contiguous and enforces a byte budget", () => {
  const mails = Array.from({ length: 500 }, (_, index) => ({
    id: 500 - index,
    subject: `mail-${index}`,
    preview: "x".repeat(1_000),
    raw: "r".repeat(30_000),
    html: `<p>${"h".repeat(30_000)}</p>`,
    text: "t".repeat(30_000),
    createdAt: new Date(1_700_000_000_000 - index).toISOString(),
  }));
  const prepared = prepareMailboxCachePayload({
    cacheKey: "scope",
    address: "user@example.com",
    updatedAt: "",
    nextOffset: 500,
    mails,
  }, 512_000);
  const bytes = new TextEncoder().encode(JSON.stringify(prepared)).byteLength;
  assert.equal(prepared.version, MAILBOX_CACHE_VERSION);
  assert.ok(prepared.mails.length <= 300);
  assert.equal(prepared.nextOffset, prepared.mails.length);
  assert.ok(bytes <= 512_000, `cache payload uses ${bytes} bytes`);
});

test("authoritative scan removes deleted ghost messages but preserves older unscanned rows", () => {
  const existing = [5, 4, 3, 2, 1].map((id) => ({ id }));
  const reconciled = reconcileServerMailRange(existing, new Set([5, 3]), 3, false);
  assert.deepEqual(reconciled.map((mail) => mail.id), [5, 3, 2, 1]);
});

test("JWT links use fragments and legacy query links remain readable", () => {
  assert.equal(readJwtFromHref("https://mail.example/#JWT=fragment-token"), "fragment-token");
  assert.equal(readJwtFromHref("https://mail.example/?JWT=legacy-token"), "legacy-token");
  assert.equal(clearJwtFromHref("https://mail.example/?JWT=secret&view=inbox#JWT=secret-2&theme=dark"), "/?view=inbox#theme=dark");
});

test("mail HTML allows only the same-origin image proxy inside a scriptless frame", () => {
  const document = buildMailFrameSrcDoc('<img src="https://tracker.example/pixel.gif"><p>Hello</p>');
  assert.match(document, /sandboxed-mail|loven7-render-root/);
  assert.match(document, /img-src data: blob: https:\/\/mail\.invalid;/);
  assert.doesNotMatch(document, /img-src data: blob: https: http:/);
  assert.doesNotMatch(document, /<script/i);
});

test("chunk load failures are recognized for recoverable update UI", () => {
  assert.equal(isChunkLoadError(new Error("Failed to fetch dynamically imported module")), true);
  assert.equal(isChunkLoadError(new Error("ordinary validation failure")), false);
});

test("webmail keeps HTTP status and invalidates only runtime 401/403 responses", async () => {
  const originalFetch = globalThis.fetch;
  const observedStatuses: number[] = [];
  const unsubscribe = subscribeAuthenticationFailures((error) => observedStatuses.push(error.status));
  let mode: "401" | "403" | "503" | "network" = "401";
  globalThis.fetch = (async () => {
    if (mode === "network") throw new TypeError("network unavailable");
    const status = Number(mode);
    return new Response(JSON.stringify({ message: `status ${status}` }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await assert.rejects(fetchSafeSettings("active-token"), (error: unknown) => error instanceof ApiError && error.status === 401);
    mode = "403";
    await assert.rejects(fetchSafeSettings("active-token"), (error: unknown) => error instanceof ApiError && error.status === 403);
    mode = "503";
    await assert.rejects(fetchSafeSettings("active-token"), (error: unknown) => error instanceof ApiError && error.status === 503);
    mode = "network";
    await assert.rejects(fetchSafeSettings("active-token"), /network unavailable/);
    assert.deepEqual(observedStatuses, [401, 403]);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});
