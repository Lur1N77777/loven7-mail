import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createSession, deleteMail, fetchMailPage, fetchSafeSettings, fetchShareInfo, fetchShareMailPage, fetchShareSettings, hideSharedMail } from "./api";
import { clearJwtFromUrl, clearStoredSession, hashToken, loadStoredSession, readJwtFromUrl, saveSession } from "./auth";
import { clearMailboxCache, readMailboxCache, writeMailboxCache } from "./cache";
import { clearImageMemoryCache, resolveMailImageAssets } from "./imageMemoryCache";
import { getMailBodyText, mergeMails, parseMailBatch, sanitizeMailHtml } from "./mailParser";
import { BrandAvatar } from "./brandIdentity";
import { applyRuntimeLocale, readInitialLocale, writeLocale, type AppLocale } from "./locale";
import type { MailPage, ParsedMail, SafeSettings, ShareInfo, SharedMailbox, WebmailSession } from "./types";
import "./styles.css";

const PAGE_SIZE = 50;
const AUTO_REFRESH_MS = 10_000;
const OFFICIAL_GITHUB_URL = "https://github.com/Lur1N77777/loven7-mail-cloudflare-suite";

type LoadingState = "boot" | "login" | "sync" | "idle";
type MobilePane = "list" | "reader";
type MailViewMode = "html" | "text" | "source";
type ActiveRun = { id: number; controller: AbortController; cacheKey?: string };
type SyncTask = { runId: number; promise: Promise<void> };

const STALE_SESSION_MESSAGE = "loven7_session_changed";

function staleSessionError() {
  const error = new Error(STALE_SESSION_MESSAGE);
  error.name = "AbortError";
  return error;
}

function isAbortLike(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === "AbortError" || candidate.message === STALE_SESSION_MESSAGE;
}

function isRuntimeConfigError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /Cloudflare Pages|MAIL_WORKER_BASE_URL|SHARE_KV|SHARE_ENCRYPTION_SECRET|邮箱 API 未配置|共享功能未/.test(error.message);
}

function formatDate(value: string | undefined, locale: AppLocale) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getSender(mail: ParsedMail, locale: AppLocale = "zh-CN") {
  return mail.from?.name || mail.from?.address || (locale === "en-US" ? "Unknown sender" : "未知发件人");
}

function maxMailId(mails: ParsedMail[]) {
  return mails.reduce((max, mail) => Math.max(max, mail.id), 0);
}

function readShareTokenFromPath() {
  const match = window.location.pathname.match(/^\/s\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : "";
}

function isShareSession(session: WebmailSession | null): session is WebmailSession & { shareToken: string; shareMailboxId: string } {
  return Boolean(session?.shareToken && session.shareMailboxId);
}

function getMailboxLabel(mailbox: SharedMailbox, locale: AppLocale = "zh-CN") {
  return mailbox.address || `${locale === "en-US" ? "Mailbox" : "邮箱"} #${mailbox.id}`;
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

function BrandLogo({ variant = "regular" }: { variant?: "hero" | "regular" | "compact" }) {
  return (
    <div className={`brand-logo brand-logo-${variant}`} role="img" aria-label="Loven7 Mail">
      <svg className="brand-sigil" viewBox="0 0 48 48" aria-hidden="true" fill="none">
        <path
          className="brand-sigil-line"
          d="M9.5 27.4c5.9-11.9 16.7-16.7 29-13-5.2 2.4-9.4 6.3-12.4 11.5 4.6-.8 8.9-.2 12.4 2-9.4.8-16 4.6-19.9 11.4-1.2-5-4.2-8.9-9.1-11.9Z"
        />
        <path
          className="brand-sigil-line brand-sigil-line-soft"
          d="M18 27.4c5.6-1.7 11.5-5 17.4-10"
        />
        <path
          className="brand-sigil-line brand-sigil-line-faint"
          d="M12.7 15.1c2.3-2.4 5.2-3.9 8.6-4.4"
        />
        <circle className="brand-sigil-dot" cx="34.7" cy="28.1" r="2" />
      </svg>
      <span className="brand-wordmark" aria-hidden="true">
        <span>Loven7</span>
        <span>Mail</span>
      </span>
    </div>
  );
}

function PasswordVisibilityIcon({ visible }: { visible: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {visible ? (
        <>
          <path d="M3.7 5.2 20.3 18.8" />
          <path d="M9.9 9.1a3 3 0 0 0 4.2 4.2" />
          <path d="M6.5 7.4C4.8 8.5 3.4 10 2.5 12c1.8 3.7 5.3 6 9.5 6 1.6 0 3.1-.3 4.4-1" />
          <path d="M11.1 6.1c.3 0 .6-.1.9-.1 4.2 0 7.7 2.3 9.5 6a11.1 11.1 0 0 1-2.2 3" />
        </>
      ) : (
        <>
          <path d="M2.5 12c1.8-3.7 5.3-6 9.5-6s7.7 2.3 9.5 6c-1.8 3.7-5.3 6-9.5 6s-7.7-2.3-9.5-6Z" />
          <path d="M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z" />
        </>
      )}
    </svg>
  );
}

function LanguageGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.4" />
      <path d="M3.8 12h16.4" />
      <path d="M12 3.6c2.1 2.3 3.2 5.1 3.2 8.4s-1.1 6.1-3.2 8.4" />
      <path d="M12 3.6C9.9 5.9 8.8 8.7 8.8 12s1.1 6.1 3.2 8.4" />
    </svg>
  );
}

function MenuChevron() {
  return (
    <svg className="locale-menu-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.2 6.4 8 10l3.8-3.6" />
    </svg>
  );
}

function WebmailLocaleMenu({ locale, setLocale, title, label }: {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  title: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const options: Array<{ value: AppLocale; label: string; short: string }> = [
    { value: "zh-CN", label: "中文", short: "中" },
    { value: "en-US", label: "English", short: "EN" },
  ];

  const updateMenuPosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect || typeof window === "undefined") return;
    const width = Math.min(180, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const top = Math.min(rect.bottom + 8, window.innerHeight - 96);
    setMenuPosition({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open) updateMenuPosition();
  }, [open, updateMenuPosition]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onReposition = () => updateMenuPosition();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onReposition, { passive: true });
    window.addEventListener("orientationchange", onReposition, { passive: true });
    window.addEventListener("scroll", onReposition, { passive: true, capture: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("orientationchange", onReposition);
      window.removeEventListener("scroll", onReposition, { capture: true });
    };
  }, [open, updateMenuPosition]);

  const current = options.find((option) => option.value === locale) || options[0];

  return (
    <div className="webmail-locale-menu-root" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="webmail-locale-toggle toolbar-locale-toggle"
        title={title}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <LanguageGlyph className="locale-menu-glyph" />
        <span>{current.short}</span>
        <MenuChevron />
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div
          ref={menuRef}
          className="webmail-locale-menu"
          role="menu"
          aria-label={label}
          style={{ top: menuPosition.top, left: menuPosition.left }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={locale === option.value}
              className={locale === option.value ? "active" : ""}
              onClick={() => {
                setLocale(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              <em>{option.short}</em>
            </button>
          ))}
        </div>
      , document.body) : null}
    </div>
  );
}

const UI_COPY = {
  "zh-CN": {
    bootLogin: "正在验证访问凭证",
    boot: "正在启动邮箱",
    loginTitle: "邮箱登录",
    loginIntro: "请输入管理员提供的邮箱与密码",
    emailLabel: "邮箱地址",
    passwordLabel: "密码",
    passwordPlaceholder: "请输入密码",
    showPassword: "显示密码",
    hidePassword: "隐藏密码",
    loginButton: "登录邮箱",
    loggingIn: "正在登录…",
    localeTitle: "切换到 English",
    languageLabel: "界面语言",
    currentMailbox: "当前邮箱",
    sharedMailbox: "共享邮箱",
    selectMailbox: "选择邮箱",
    copied: "已复制",
    copyAddressAction: "复制",
    copyAddressTitle: "点击复制邮箱地址",
    autoRefreshTitleOn: "已开启：每 10 秒自动刷新",
    autoRefreshTitleOff: "开启每 10 秒自动刷新",
    refreshTitleOn: "圆环显示距离下次自动刷新约 10 秒",
    refreshTitleOff: "手动刷新",
    refresh: "刷新",
    auto: "自动",
    logout: "退出",
    compose: "写邮件",
    composeTitle: "发送邮件",
    toMail: "收件人",
    toName: "收件人名称",
    fromName: "发件人名称",
    subject: "主题",
    content: "正文",
    htmlMode: "HTML 正文",
    send: "发送",
    sending: "发送中…",
    sendSuccess: "邮件已发送",
    sendAccess: "申请发信权限",
    sendAccessSuccess: "已提交发信权限申请",
    composeHint: "发件权限由后台允许的域名、余额和角色控制；没有权限时 Worker 会拒绝请求。",
    close: "关闭",
    noContent: "(无内容)",
    verificationCode: "验证码",
    emptyList: "暂无邮件",
    loadMore: "加载更多历史",
    allLoaded: "已加载全部邮件",
    sidebarLabel: "邮箱侧栏",
    readerLabel: "邮件内容",
    loadFailed: "加载失败",
    retry: "重试",
    backToList: "返回列表",
    copyCode: "复制验证码",
    copyBody: "复制正文",
    bodyCopied: "正文已复制",
    hideMail: "删除邮件",
    delete: "删除",
    sender: "发件人",
    recipient: "收件人",
    attachments: "附件",
    none: "无",
    mailFormat: "邮件显示格式",
    htmlFormat: "HTML 格式",
    textFormat: "显示文本格式",
    sourceFormat: "显示源码格式",
    optimizingImages: "加载中…",
    noSource: "(无源码)",
    emptyTitle: "暂无邮件",
    emptyBody: "等待刷新新邮件",
    credentialsRequired: "请输入邮箱和密码",
    wrongPassword: "邮箱或密码错误",
    loginFailed: "登录失败",
    syncFailed: "同步失败",
    currentAddress: "当前邮箱",
    noSharedMailbox: "共享链接内没有可用邮箱",
    refreshed: "已刷新",
    refreshFailed: "刷新失败",
    loadFailedToast: "加载失败",
    switchFailed: "切换邮箱失败",
    autoOn: "自动刷新已开启",
    autoOff: "自动刷新已关闭",
    codeCopied: "验证码已复制",
    newMails: (count: number) => `新增 ${count} 封邮件`,
    newShort: (count: number) => `新增 ${count}`,
    hideNotAllowed: "该共享链接不允许删除邮件",
    hideConfirm: (subject: string) => `删除「${subject || "这封邮件"}」？删除后此链接将不再显示这封邮件。`,
    hidden: "邮件已删除",
    deleteConfirm: (subject: string) => `删除「${subject || "这封邮件"}」？`,
    deleted: "邮件已删除",
    officialRepository: "官方 GitHub 仓库",
    officialRepositoryTitle: "打开官方 GitHub 仓库",
  },
  "en-US": {
    bootLogin: "Verifying access",
    boot: "Starting mailbox",
    loginTitle: "Mailbox sign in",
    loginIntro: "Enter the mailbox and password from your administrator",
    emailLabel: "Email address",
    passwordLabel: "Password",
    passwordPlaceholder: "Enter password",
    showPassword: "Show password",
    hidePassword: "Hide password",
    loginButton: "Open mailbox",
    loggingIn: "Signing in…",
    localeTitle: "切换到中文",
    languageLabel: "Language",
    currentMailbox: "Current mailbox",
    sharedMailbox: "Shared mailbox",
    selectMailbox: "Choose mailbox",
    copied: "Copied",
    copyAddressAction: "Copy",
    copyAddressTitle: "Copy mailbox address",
    autoRefreshTitleOn: "On: auto refresh every 10 seconds",
    autoRefreshTitleOff: "Turn on 10-second auto refresh",
    refreshTitleOn: "Ring shows about 10 seconds until the next refresh",
    refreshTitleOff: "Refresh now",
    refresh: "Refresh",
    auto: "Auto",
    logout: "Exit",
    compose: "Compose",
    composeTitle: "Send mail",
    toMail: "To",
    toName: "Recipient name",
    fromName: "Sender name",
    subject: "Subject",
    content: "Message",
    htmlMode: "HTML body",
    send: "Send",
    sending: "Sending…",
    sendSuccess: "Mail sent",
    sendAccess: "Request send access",
    sendAccessSuccess: "Send access requested",
    composeHint: "Sending is controlled by allowed domains, balance, and role permissions. The Worker rejects unauthorized requests.",
    close: "Close",
    noContent: "(No content)",
    verificationCode: "Code",
    emptyList: "No mail",
    loadMore: "Load older mail",
    allLoaded: "All mail loaded",
    sidebarLabel: "Mailbox sidebar",
    readerLabel: "Message content",
    loadFailed: "Load failed",
    retry: "Retry",
    backToList: "Back to list",
    copyCode: "Copy code",
    copyBody: "Copy body",
    bodyCopied: "Body copied",
    hideMail: "Delete mail",
    delete: "Delete",
    sender: "From",
    recipient: "To",
    attachments: "Attachments",
    none: "None",
    mailFormat: "Message format",
    htmlFormat: "HTML",
    textFormat: "Text",
    sourceFormat: "Source",
    optimizingImages: "Loading…",
    noSource: "(No source)",
    emptyTitle: "No mail",
    emptyBody: "Waiting for new mail",
    credentialsRequired: "Enter email and password",
    wrongPassword: "Incorrect email or password",
    loginFailed: "Login failed",
    syncFailed: "Sync failed",
    currentAddress: "Current mailbox",
    noSharedMailbox: "No available mailbox in this shared link",
    refreshed: "Refreshed",
    refreshFailed: "Refresh failed",
    loadFailedToast: "Load failed",
    switchFailed: "Mailbox switch failed",
    autoOn: "Auto refresh on",
    autoOff: "Auto refresh off",
    codeCopied: "Verification code copied",
    newMails: (count: number) => `${count} new message${count === 1 ? "" : "s"}`,
    newShort: (count: number) => `+${count} new`,
    hideNotAllowed: "This shared link does not allow deleting mail",
    hideConfirm: (subject: string) => `Delete “${subject || "this message"}”? It will no longer appear in this shared link.`,
    hidden: "Mail deleted",
    deleteConfirm: (subject: string) => `Delete “${subject || "this message"}”?`,
    deleted: "Mail deleted",
    officialRepository: "Official GitHub repository",
    officialRepositoryTitle: "Open official GitHub repository",
  },
} as const;

function MailHtmlView({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot || host.attachShadow({ mode: "open" });
    const safeHtml = sanitizeMailHtml(html, { allowExternalImages: true });
    root.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          min-height: 100%;
          background: #fff;
          color: #172033;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
          font-size: 15px;
          line-height: 1.58;
        }
        * { box-sizing: border-box; }
        .mail-shadow-content {
          display: flow-root;
          width: 100%;
          max-width: 100%;
          min-height: 0;
          padding: 18px;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        a { color: #2563eb; text-decoration-thickness: .08em; text-underline-offset: 2px; }
        img, svg, video, canvas { max-width: 100% !important; height: auto !important; }
        table { max-width: 100%; border-collapse: collapse; table-layout: auto; }
        td, th { max-width: 100%; overflow-wrap: anywhere; }
        pre, code { white-space: pre-wrap !important; word-break: break-word; overflow-wrap: anywhere; }
        blockquote { margin-left: 0; padding-left: 14px; border-left: 3px solid #dbe7ff; color: #42526b; }
        form[data-disabled-form='true'] { opacity: .75; pointer-events: none; }
        @media (max-width: 560px) {
          :host { font-size: 14px; line-height: 1.54; }
          .mail-shadow-content { padding: 10px; }
          p { margin-block: .72em; }
          table[width], td[width], th[width] { max-width: 100% !important; }
        }
      </style>
      <div class="mail-shadow-content">${safeHtml}</div>
    `;
    return () => {
      root.innerHTML = "";
    };
  }, [html]);

  return <div className="mail-html-view" ref={hostRef} />;
}

type MailListRowProps = {
  mail: ParsedMail;
  selected: boolean;
  locale: AppLocale;
  noContent: string;
  verificationCodeLabel: string;
  copiedLabel: string;
  copied: boolean;
  onSelect: (mail: ParsedMail) => void;
  onCopyVerificationCode: (mail: ParsedMail) => void;
};

const MailListRow = React.memo(function MailListRow({
  mail,
  selected,
  locale,
  noContent,
  verificationCodeLabel,
  copiedLabel,
  copied,
  onSelect,
  onCopyVerificationCode,
}: MailListRowProps) {
  const sender = getSender(mail, locale);
  const senderName = mail.from?.name || sender;
  const senderAddress = mail.from?.address || sender;
  const select = () => onSelect(mail);

  return (
    <div
      className={`mail-row ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      }}
    >
      <div className="mail-row-inner">
        <BrandAvatar sender={senderAddress} senderName={senderName} size={32} className="mail-list-brand-avatar" />
        <div className="mail-row-content">
          <span className="mail-row-top">
            <strong>{mail.subject}</strong>
            <time>{formatDate(mail.date || mail.createdAt, locale)}</time>
          </span>
          <span className="mail-row-from">{sender}</span>
          <span className="mail-row-preview">{mail.preview || noContent}</span>
          {mail.verificationCode ? (
            <span className="code-row">
              <button
                type="button"
                className="code-pill code-copy-button"
                onClick={(event) => {
                  event.stopPropagation();
                  onCopyVerificationCode(mail);
                }}
              >
                {verificationCodeLabel} {mail.verificationCode}
              </button>
              <em className={`code-copy-hint ${copied ? "visible" : ""}`} aria-live="polite">{copiedLabel}</em>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
});

export default function App() {
  const [session, setSession] = useState<WebmailSession | null>(null);
  const [shareInfo, setShareInfo] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState<LoadingState>("boot");
  const [mails, setMails] = useState<ParsedMail[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [locale, setLocale] = useState<AppLocale>(() => readInitialLocale());
  const [loginError, setLoginError] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>("list");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [refreshCycleKey, setRefreshCycleKey] = useState(0);
  const [refreshFeedback, setRefreshFeedback] = useState<string | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);
  const [mailboxMenuOpen, setMailboxMenuOpen] = useState(false);
  const [copiedCodeMailId, setCopiedCodeMailId] = useState<number | null>(null);
  const [mailViewMode, setMailViewMode] = useState<MailViewMode>("html");
  const [resolvedHtml, setResolvedHtml] = useState<{ cacheKey: string; mailId: number; html: string } | null>(null);
  const syncRef = useRef<SyncTask | null>(null);
  const runSequenceRef = useRef(0);
  const activeRunRef = useRef<ActiveRun | null>(null);
  const sessionRef = useRef<WebmailSession | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const refreshFeedbackTimerRef = useRef<number | null>(null);
  const autoRefreshTimerRef = useRef<number | null>(null);
  const isRefreshingRef = useRef(false);
  const addressCopyTimerRef = useRef<number | null>(null);
  const codeCopyTimerRef = useRef<number | null>(null);
  const mailboxMenuRef = useRef<HTMLDivElement | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const copy = UI_COPY[locale];
  const copyRef = useRef(copy);
  const localeRef = useRef(locale);

  const selectedMail = useMemo(
    () => mails.find((mail) => mail.id === selectedId) || mails[0] || null,
    [mails, selectedId]
  );

  const setActiveSession = useCallback((nextSession: WebmailSession | null) => {
    sessionRef.current = nextSession;
    setSession(nextSession);
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!mailboxMenuOpen) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!mailboxMenuRef.current?.contains(event.target as Node)) setMailboxMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMailboxMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [mailboxMenuOpen]);

  useEffect(() => {
    setMailboxMenuOpen(false);
  }, [session?.shareMailboxId, session?.shareToken]);

  const beginRun = useCallback((cacheKey?: string): ActiveRun => {
    activeRunRef.current?.controller.abort();
    const run: ActiveRun = {
      id: ++runSequenceRef.current,
      controller: new AbortController(),
      cacheKey,
    };
    activeRunRef.current = run;
    syncRef.current = null;
    isRefreshingRef.current = false;
    setIsRefreshing(false);
    return run;
  }, []);

  const cancelRun = useCallback(() => {
    activeRunRef.current?.controller.abort();
    activeRunRef.current = null;
    runSequenceRef.current += 1;
    syncRef.current = null;
    isRefreshingRef.current = false;
    setIsRefreshing(false);
  }, []);

  const isRunActive = useCallback((run: ActiveRun, activeSession?: WebmailSession) => {
    const current = activeRunRef.current;
    if (!current || current.id !== run.id || run.controller.signal.aborted) return false;
    if (activeSession) {
      if (current.cacheKey && current.cacheKey !== activeSession.cacheKey) return false;
      if (sessionRef.current?.cacheKey !== activeSession.cacheKey) return false;
    }
    return true;
  }, []);

  const assertRunActive = useCallback((run: ActiveRun, activeSession?: WebmailSession) => {
    if (!isRunActive(run, activeSession)) throw staleSessionError();
  }, [isRunActive]);

  const attachRunSession = useCallback((run: ActiveRun, activeSession: WebmailSession) => {
    assertRunActive(run);
    run.cacheKey = activeSession.cacheKey;
    if (activeRunRef.current?.id === run.id) activeRunRef.current.cacheKey = activeSession.cacheKey;
  }, [assertRunActive]);

  const getRunForSession = useCallback((activeSession: WebmailSession): ActiveRun => {
    const current = activeRunRef.current;
    if (!current || current.controller.signal.aborted || (current.cacheKey && current.cacheKey !== activeSession.cacheKey)) {
      return beginRun(activeSession.cacheKey);
    }
    current.cacheKey = activeSession.cacheKey;
    return current;
  }, [beginRun]);

  const resetMailboxState = useCallback(() => {
    clearImageMemoryCache();
    setResolvedHtml(null);
    setMails([]);
    setSelectedId(null);
    setNextOffset(0);
    setHasMoreHistory(false);
  }, []);

  useEffect(() => {
    writeLocale(locale);
    applyRuntimeLocale(locale);
    copyRef.current = UI_COPY[locale];
    localeRef.current = locale;
  }, [locale]);

  useEffect(() => {
    if (session || !loginError || loading !== "idle") return undefined;
    const timer = window.setTimeout(() => {
      passwordInputRef.current?.focus();
      passwordInputRef.current?.select();
    }, 40);
    return () => window.clearTimeout(timer);
  }, [loading, loginError, session]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 1800);
  }, []);

  const showRefreshFeedback = useCallback((message: string) => {
    setRefreshFeedback(message);
    if (refreshFeedbackTimerRef.current) window.clearTimeout(refreshFeedbackTimerRef.current);
    refreshFeedbackTimerRef.current = window.setTimeout(() => setRefreshFeedback(null), 1300);
  }, []);

  const fetchSessionMailPage = useCallback((activeSession: WebmailSession, limit: number, offset: number, signal?: AbortSignal): Promise<MailPage> => {
    if (isShareSession(activeSession)) {
      return fetchShareMailPage(activeSession.shareToken, activeSession.shareMailboxId, limit, offset, { signal });
    }
    return fetchMailPage(activeSession.jwt, limit, offset, { signal });
  }, []);

  const fetchSessionSettings = useCallback((activeSession: WebmailSession, signal?: AbortSignal): Promise<SafeSettings> => {
    if (isShareSession(activeSession)) {
      return fetchShareSettings(activeSession.shareToken, activeSession.shareMailboxId, { signal });
    }
    return fetchSafeSettings(activeSession.jwt, { signal });
  }, []);

  const persist = useCallback(
    async (activeSession: WebmailSession, nextMails: ParsedMail[], offset = nextMails.length, more = hasMoreHistory, run = activeRunRef.current) => {
      if (run && !isRunActive(run, activeSession)) return;
      await writeMailboxCache({
        cacheKey: activeSession.cacheKey,
        address: activeSession.address,
        updatedAt: new Date().toISOString(),
        nextOffset: offset,
        mails: nextMails,
      });
      if (run && !isRunActive(run, activeSession)) return;
      setNextOffset(offset);
      setHasMoreHistory(more);
    },
    [hasMoreHistory, isRunActive]
  );

  const loadFirstPage = useCallback(async (activeSession: WebmailSession, run: ActiveRun) => {
    assertRunActive(run, activeSession);
    const page = await fetchSessionMailPage(activeSession, PAGE_SIZE, 0, run.controller.signal);
    assertRunActive(run, activeSession);
    const parsed = await parseMailBatch(page.results);
    assertRunActive(run, activeSession);
    const next = mergeMails([], parsed);
    setMails(next);
    setSelectedId((current) => current ?? next[0]?.id ?? null);
    const more = page.results.length === PAGE_SIZE && next.length < page.count;
    await writeMailboxCache({
      cacheKey: activeSession.cacheKey,
      address: activeSession.address,
      updatedAt: new Date().toISOString(),
      nextOffset: next.length,
      mails: next,
    });
    assertRunActive(run, activeSession);
    setNextOffset(next.length);
    setHasMoreHistory(more);
    return next.length;
  }, [assertRunActive, fetchSessionMailPage]);

  const syncIncremental = useCallback(
    async (activeSession: WebmailSession, currentMails: ParsedMail[], run: ActiveRun) => {
      assertRunActive(run, activeSession);
      const sinceId = maxMailId(currentMails);
      if (!sinceId) return await loadFirstPage(activeSession, run);

      const rawNew = [];
      let offset = 0;
      let reachedAnchor = false;
      let reachedEnd = false;
      let totalCount = currentMails.length;

      while (!reachedAnchor && !reachedEnd && offset < PAGE_SIZE * 100) {
        assertRunActive(run, activeSession);
        const page = await fetchSessionMailPage(activeSession, PAGE_SIZE, offset, run.controller.signal);
        assertRunActive(run, activeSession);
        totalCount = page.count;
        if (page.results.length === 0) {
          reachedEnd = true;
          break;
        }
        for (const item of page.results) {
          if (item.id <= sinceId) reachedAnchor = true;
          if (item.id > sinceId) rawNew.push(item);
        }
        offset += page.results.length;
        reachedEnd = page.results.length < PAGE_SIZE;
      }

      if (!rawNew.length) {
        assertRunActive(run, activeSession);
        setHasMoreHistory(currentMails.length < totalCount);
        return 0;
      }

      const parsed = await parseMailBatch(rawNew);
      assertRunActive(run, activeSession);
      const next = mergeMails(currentMails, parsed);
      setMails(next);
      setSelectedId((current) => current ?? next[0]?.id ?? null);
      await writeMailboxCache({
        cacheKey: activeSession.cacheKey,
        address: activeSession.address,
        updatedAt: new Date().toISOString(),
        nextOffset: next.length,
        mails: next,
      });
      assertRunActive(run, activeSession);
      setNextOffset(next.length);
      setHasMoreHistory(next.length < totalCount);
      return rawNew.length;
    },
    [assertRunActive, fetchSessionMailPage, loadFirstPage]
  );

  const hydrateAndSync = useCallback(
    async (activeSession: WebmailSession, run: ActiveRun) => {
      if (syncRef.current?.runId === run.id) return syncRef.current.promise;
      const task = (async () => {
        assertRunActive(run, activeSession);
        setLoading("sync");
        setError(null);
        const cached = await readMailboxCache(activeSession.cacheKey);
        assertRunActive(run, activeSession);
        if (cached?.mails?.length) {
          let cachedMails = cached.mails;
          setMails(cachedMails);
          setSelectedId((current) => current ?? cachedMails[0]?.id ?? null);
          setNextOffset(cached.nextOffset || cachedMails.length);

          const mailsWithRaw = cachedMails.filter((mail) => mail.raw?.trim());
          if (mailsWithRaw.length) {
            const reparsed = await parseMailBatch(
              mailsWithRaw.map((mail) => ({
                id: mail.id,
                raw: mail.raw,
                subject: mail.subject,
                message_id: mail.messageId,
                created_at: mail.createdAt,
              }))
            );
            assertRunActive(run, activeSession);
            cachedMails = mergeMails(cachedMails, reparsed);
            setMails(cachedMails);
            await writeMailboxCache({
              cacheKey: activeSession.cacheKey,
              address: activeSession.address,
              updatedAt: new Date().toISOString(),
              nextOffset: cached.nextOffset || cachedMails.length,
              mails: cachedMails,
            });
            assertRunActive(run, activeSession);
          }

          const added = await syncIncremental(activeSession, cachedMails, run);
          assertRunActive(run, activeSession);
          if (added > 0) showToast(copyRef.current.newMails(added));
        } else {
          await loadFirstPage(activeSession, run);
        }
        assertRunActive(run, activeSession);
        setLoading("idle");
      })()
        .catch((err: Error) => {
          if (isAbortLike(err) || !isRunActive(run, activeSession)) return;
          setError(err.message || copyRef.current.syncFailed);
          setLoading("idle");
        })
        .finally(() => {
          if (syncRef.current?.runId === run.id) syncRef.current = null;
        });
      syncRef.current = { runId: run.id, promise: task };
      return task;
    },
    [assertRunActive, isRunActive, loadFirstPage, showToast, syncIncremental]
  );

  const activateSession = useCallback(
    async (jwt: string, address: string, settings?: SafeSettings, run = beginRun()) => {
      const activeSession: WebmailSession = {
        jwt,
        address: address || copyRef.current.currentAddress,
        settings,
        cacheKey: await hashToken(`${address || "current"}:${jwt}`),
      };
      attachRunSession(run, activeSession);
      saveSession(activeSession);
      setShareInfo(null);
      resetMailboxState();
      setActiveSession(activeSession);
      setAutoRefreshEnabled(true);
      setMobilePane("list");
      await hydrateAndSync(activeSession, run);
    },
    [attachRunSession, beginRun, hydrateAndSync, resetMailboxState, setActiveSession]
  );

  const activateShareMailbox = useCallback(
    async (token: string, info: ShareInfo, mailboxId: string, run = beginRun()) => {
      const mailbox = info.addresses.find((item) => item.id === mailboxId) || info.addresses[0];
      if (!mailbox) throw new Error(copyRef.current.noSharedMailbox);
      setLoading("login");
      setError(null);
      setLoginError(null);
      resetMailboxState();
      const settings = await fetchShareSettings(token, mailbox.id, { signal: run.controller.signal }).catch((error) => {
        if (isAbortLike(error)) throw error;
        if (isRuntimeConfigError(error)) throw error;
        return undefined;
      });
      assertRunActive(run);
      const activeSession: WebmailSession = {
        jwt: `share:${token}:${mailbox.id}`,
        address: settings?.address || mailbox.address || getMailboxLabel(mailbox, localeRef.current),
        settings,
        cacheKey: await hashToken(`share:${token}:${mailbox.id}`),
        shareToken: token,
        shareMailboxId: mailbox.id,
        shareMailboxes: info.addresses,
        readonly: true,
      };
      attachRunSession(run, activeSession);
      setShareInfo(info);
      setActiveSession(activeSession);
      setAutoRefreshEnabled(true);
      setMobilePane("list");
      await hydrateAndSync(activeSession, run);
    },
    [assertRunActive, attachRunSession, beginRun, hydrateAndSync, resetMailboxState, setActiveSession]
  );

  const loginWithJwt = useCallback(
    async (jwt: string, run = beginRun()) => {
      setLoading("login");
      setError(null);
      setLoginError(null);
      const result = await createSession(jwt, { signal: run.controller.signal });
      assertRunActive(run);
      const activeJwt = result.jwt || jwt;
      const address = result.address || result.settings?.address || copyRef.current.currentAddress;
      await activateSession(activeJwt, address, result.settings, run);
    },
    [activateSession, assertRunActive, beginRun]
  );

  const loginWithPassword = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const cleanEmail = email.trim();
      if (!cleanEmail || !password) {
        setLoginError(copy.credentialsRequired);
        window.setTimeout(() => {
          if (!cleanEmail) emailInputRef.current?.focus();
          else passwordInputRef.current?.focus();
        }, 0);
        return;
      }
      const run = beginRun();
      setLoading("login");
      setError(null);
      setLoginError(null);
      try {
        const result = await createSession({ email: cleanEmail, password }, { signal: run.controller.signal });
        assertRunActive(run);
        if (!result.jwt) throw new Error(copy.wrongPassword);
        const address = result.address || result.settings?.address || cleanEmail;
        await activateSession(result.jwt, address, result.settings, run);
        setPassword("");
      } catch (err) {
        if (isAbortLike(err) || !isRunActive(run)) return;
        setLoginError(err instanceof Error ? err.message : copy.wrongPassword);
        setLoading("idle");
        window.setTimeout(() => passwordInputRef.current?.focus(), 0);
      }
    },
    [activateSession, assertRunActive, beginRun, copy.credentialsRequired, copy.wrongPassword, email, isRunActive, password]
  );

  useEffect(() => {
    let cancelled = false;
    const run = beginRun();
    (async () => {
      const shareToken = readShareTokenFromPath();
      const urlJwt = readJwtFromUrl();
      if (urlJwt) clearJwtFromUrl();
      try {
        if (shareToken) {
          setLoading("login");
          const info = await fetchShareInfo(shareToken, { signal: run.controller.signal });
          assertRunActive(run);
          if (!cancelled) await activateShareMailbox(shareToken, info, info.addresses[0]?.id || "", run);
          return;
        }
        if (urlJwt) {
          if (!cancelled) await loginWithJwt(urlJwt, run);
          return;
        }
        const stored = await loadStoredSession();
        if (cancelled) return;
        assertRunActive(run);
        if (stored) {
          attachRunSession(run, stored);
          setActiveSession(stored);
          setMobilePane("list");
          void fetchSessionSettings(stored, run.controller.signal)
            .then((settings) => {
              if (!isRunActive(run, stored)) return;
              const refreshed = { ...stored, address: settings.address || stored.address, settings };
              saveSession(refreshed);
              setActiveSession(refreshed);
            })
            .catch((error) => {
              if (isAbortLike(error)) return;
            });
          await hydrateAndSync(stored, run);
        } else {
          if (isRunActive(run)) setLoading("idle");
        }
      } catch (err) {
        if (!cancelled && !isAbortLike(err) && isRunActive(run)) {
          setError(err instanceof Error ? err.message : copyRef.current.loginFailed);
          setLoginError(err instanceof Error ? err.message : copyRef.current.loginFailed);
          setLoading("idle");
        }
      }
    })();
    return () => {
      cancelled = true;
      cancelRun();
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (refreshFeedbackTimerRef.current) window.clearTimeout(refreshFeedbackTimerRef.current);
      if (autoRefreshTimerRef.current) window.clearInterval(autoRefreshTimerRef.current);
      if (addressCopyTimerRef.current) window.clearTimeout(addressCopyTimerRef.current);
      if (codeCopyTimerRef.current) window.clearTimeout(codeCopyTimerRef.current);
      clearImageMemoryCache();
    };
  }, [activateShareMailbox, assertRunActive, attachRunSession, beginRun, cancelRun, fetchSessionSettings, hydrateAndSync, isRunActive, loginWithJwt, setActiveSession]);

  useEffect(() => {
    const clear = () => clearImageMemoryCache();
    window.addEventListener("pagehide", clear);
    window.addEventListener("beforeunload", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("beforeunload", clear);
      clear();
    };
  }, []);

  const refresh = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!session || loading === "sync" || isRefreshingRef.current) return;
    const activeSession = session;
    const run = getRunForSession(activeSession);
    if (!isRunActive(run, activeSession)) return;
    isRefreshingRef.current = true;
    setIsRefreshing(true);
    setError(null);
    if (!options.silent && refreshFeedbackTimerRef.current) {
      window.clearTimeout(refreshFeedbackTimerRef.current);
      refreshFeedbackTimerRef.current = null;
    }
    if (!options.silent) setRefreshFeedback(null);
    try {
      const added = await syncIncremental(activeSession, mails, run);
      assertRunActive(run, activeSession);
      if (!options.silent) showRefreshFeedback(added > 0 ? copy.newShort(added) : copy.refreshed);
    } catch (err) {
      if (isAbortLike(err) || !isRunActive(run, activeSession)) return;
      const message = err instanceof Error ? err.message : copy.refreshFailed;
      setError(message);
      if (!options.silent) showRefreshFeedback(copy.refreshFailed);
      showToast(message);
    } finally {
      if (activeRunRef.current?.id === run.id) {
        isRefreshingRef.current = false;
        setIsRefreshing(false);
      }
    }
  }, [assertRunActive, copy, getRunForSession, isRunActive, loading, mails, session, showRefreshFeedback, showToast, syncIncremental]);

  useEffect(() => {
    if (autoRefreshTimerRef.current) {
      window.clearInterval(autoRefreshTimerRef.current);
      autoRefreshTimerRef.current = null;
    }
    if (!session || !autoRefreshEnabled) return;

    autoRefreshTimerRef.current = window.setInterval(() => {
      if (document.hidden) return;
      void refresh({ silent: true });
    }, AUTO_REFRESH_MS);

    return () => {
      if (autoRefreshTimerRef.current) {
        window.clearInterval(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, [autoRefreshEnabled, refresh, refreshCycleKey, session]);

  const loadMore = useCallback(async () => {
    if (!session || loading === "sync") return;
    const activeSession = session;
    const run = getRunForSession(activeSession);
    if (!isRunActive(run, activeSession)) return;
    setLoading("sync");
    setError(null);
    try {
      const page = await fetchSessionMailPage(activeSession, PAGE_SIZE, nextOffset, run.controller.signal);
      assertRunActive(run, activeSession);
      const parsed = await parseMailBatch(page.results);
      assertRunActive(run, activeSession);
      const next = mergeMails(mails, parsed);
      setMails(next);
      await persist(activeSession, next, next.length, page.results.length === PAGE_SIZE && next.length < page.count, run);
    } catch (err) {
      if (isAbortLike(err) || !isRunActive(run, activeSession)) return;
      setError(err instanceof Error ? err.message : copy.loadFailedToast);
    } finally {
      if (isRunActive(run, activeSession)) setLoading("idle");
    }
  }, [assertRunActive, copy.loadFailedToast, fetchSessionMailPage, getRunForSession, isRunActive, loading, mails, nextOffset, persist, session]);

  const removeMail = useCallback(
    async (mail: ParsedMail) => {
      if (!session) return;
      const activeSession = session;
      const run = getRunForSession(activeSession);
      if (!isRunActive(run, activeSession)) return;
      try {
        if (isShareSession(activeSession)) {
          if (!shareInfo?.permissions?.hideMail) {
            showToast(copy.hideNotAllowed);
            return;
          }
          if (!window.confirm(copy.hideConfirm(mail.subject))) return;
          await hideSharedMail(activeSession.shareToken, activeSession.shareMailboxId, mail.id, { signal: run.controller.signal });
          assertRunActive(run, activeSession);
          const next = mails.filter((item) => item.id !== mail.id);
          setMails(next);
          setSelectedId(next[0]?.id ?? null);
          if (!next.length) setMobilePane("list");
          await persist(activeSession, next, Math.max(0, nextOffset - 1), hasMoreHistory, run);
          assertRunActive(run, activeSession);
          showToast(copy.hidden);
          return;
        }
        if (!window.confirm(copy.deleteConfirm(mail.subject))) return;
        await deleteMail(activeSession.jwt, mail.id, { signal: run.controller.signal });
        assertRunActive(run, activeSession);
        const next = mails.filter((item) => item.id !== mail.id);
        setMails(next);
        setSelectedId(next[0]?.id ?? null);
        if (!next.length) setMobilePane("list");
        await persist(activeSession, next, Math.max(0, nextOffset - 1), hasMoreHistory, run);
        assertRunActive(run, activeSession);
        showToast(copy.deleted);
      } catch (err) {
        if (isAbortLike(err) || !isRunActive(run, activeSession)) return;
        const message = err instanceof Error ? err.message : copy.refreshFailed;
        setError(message);
        showToast(message);
      }
    },
    [assertRunActive, copy, getRunForSession, hasMoreHistory, isRunActive, mails, nextOffset, persist, session, shareInfo?.permissions?.hideMail, showToast]
  );

  const logout = useCallback(() => {
    const activeSession = session;
    cancelRun();
    if (activeSession && !isShareSession(activeSession)) void clearMailboxCache(activeSession.cacheKey).catch(() => undefined);
    if (!isShareSession(activeSession)) clearStoredSession();
    setActiveSession(null);
    setShareInfo(null);
    setAutoRefreshEnabled(true);
    setRefreshFeedback(null);
    setIsRefreshing(false);
    setLoading("idle");
    resetMailboxState();
    setMobilePane("list");
    setError(null);
    setLoginError(null);
  }, [cancelRun, resetMailboxState, session, setActiveSession]);

  const switchSharedMailbox = useCallback(
    async (mailboxId: string) => {
      if (!session?.shareToken || !shareInfo || mailboxId === session.shareMailboxId) return;
      try {
        await activateShareMailbox(session.shareToken, shareInfo, mailboxId);
      } catch (err) {
        if (isAbortLike(err)) return;
        const message = err instanceof Error ? err.message : copy.switchFailed;
        setError(message);
        showToast(message);
        setLoading("idle");
      }
    },
    [activateShareMailbox, copy.switchFailed, session?.shareMailboxId, session?.shareToken, shareInfo, showToast]
  );

  const selectMail = useCallback((mail: ParsedMail) => {
    setSelectedId(mail.id);
    setMobilePane("reader");
    if (!mail.html && mailViewMode === "html") setMailViewMode("text");
  }, [mailViewMode]);

  const copyCurrentAddress = useCallback(async () => {
    if (!session?.address) return;
    await copyText(session.address);
    setAddressCopied(true);
    if (addressCopyTimerRef.current) window.clearTimeout(addressCopyTimerRef.current);
    addressCopyTimerRef.current = window.setTimeout(() => setAddressCopied(false), 1600);
  }, [session?.address]);



  const copyVerificationCode = useCallback(async (mail: ParsedMail) => {
    if (!mail.verificationCode) return;
    await copyText(mail.verificationCode);
    setCopiedCodeMailId(mail.id);
    showToast(copy.codeCopied);
    if (codeCopyTimerRef.current) window.clearTimeout(codeCopyTimerRef.current);
    codeCopyTimerRef.current = window.setTimeout(() => setCopiedCodeMailId(null), 1500);
  }, [copy.codeCopied, showToast]);

  const bodyText = useMemo(() => (selectedMail ? getMailBodyText(selectedMail) : ""), [selectedMail]);
  const activeViewMode: MailViewMode = selectedMail?.html ? mailViewMode : mailViewMode === "source" ? "source" : "text";
  const selectedResolvedHtml = selectedMail?.html
    ? (resolvedHtml?.cacheKey === session?.cacheKey && resolvedHtml?.mailId === selectedMail.id ? resolvedHtml.html : selectedMail.html)
    : "";

  useEffect(() => {
    let cancelled = false;
    const cacheKey = session?.cacheKey || "";
    if (!selectedMail?.html || activeViewMode !== "html") {
      setResolvedHtml(null);
      return;
    }

    const mailId = selectedMail.id;
    const fallbackHtml = selectedMail.html || "";
    setResolvedHtml((current) => (current?.cacheKey === cacheKey && current?.mailId === mailId ? current : null));
    resolveMailImageAssets(fallbackHtml)
      .then((html) => {
        if (!cancelled && sessionRef.current?.cacheKey === cacheKey) setResolvedHtml({ cacheKey, mailId, html });
      })
      .catch(() => {
        if (!cancelled && sessionRef.current?.cacheKey === cacheKey) setResolvedHtml({ cacheKey, mailId, html: fallbackHtml });
      });

    return () => {
      cancelled = true;
    };
  }, [activeViewMode, selectedMail?.html, selectedMail?.id, session?.cacheKey]);

  if (!session && (loading === "boot" || loading === "login")) {
    return (
      <div className="login-shell">
        {toast ? <div className="toast">{toast}</div> : null}
        <section className="login-card boot-card">
          <BrandLogo variant="hero" />
          <div className="spinner" />
          <p>{loading === "login" ? copy.bootLogin : copy.boot}</p>
        </section>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="account-portal-shell mailbox-direct-shell">
        {toast ? <div className="toast">{toast}</div> : null}
        <section className="account-portal-hero" aria-hidden="true">
          <BrandLogo variant="compact" />
        </section>
        <main className="account-portal-panel mailbox-direct-panel" aria-label={copy.loginTitle}>
          <div className="account-panel-inner mailbox-direct-panel-inner">
            <div className="account-panel-top mailbox-direct-panel-top">
              <BrandLogo variant="compact" />
              <WebmailLocaleMenu locale={locale} setLocale={setLocale} title={copy.localeTitle} label={copy.languageLabel} />
            </div>
            <section className="account-auth-card mailbox-direct-card">
              <div className="account-title-block">
                <h1>{copy.loginTitle}</h1>
                <p>{copy.loginIntro}</p>
              </div>
              <form className="account-form mailbox-direct-form" onSubmit={loginWithPassword}>
                <label>
                  <span>{copy.emailLabel}</span>
                  <input
                    ref={emailInputRef}
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="username"
                    inputMode="email"
                    autoFocus
                  />
                </label>
                <label>
                  <span>{copy.passwordLabel}</span>
                  <div className="password-input-wrap">
                    <input
                      ref={passwordInputRef}
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder={copy.passwordPlaceholder}
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      className="password-toggle"
                      aria-label={showPassword ? copy.hidePassword : copy.showPassword}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((visible) => !visible)}
                    >
                      <PasswordVisibilityIcon visible={showPassword} />
                    </button>
                  </div>
                </label>
                {loginError ? <div className="account-message error" role="alert">{loginError}</div> : null}
                <button className="account-primary-button mailbox-direct-submit" type="submit" disabled={loading === "login"} aria-busy={loading === "login"}>
                  {loading === "login" ? <><span className="button-spinner" aria-hidden="true" /> {copy.loggingIn}</> : copy.loginButton}
                </button>
              </form>
              <a className="official-repository-link account-repository-link" href={OFFICIAL_GITHUB_URL} target="_blank" rel="noreferrer" title={copy.officialRepositoryTitle}>
                {copy.officialRepository}
              </a>
            </section>
          </div>
        </main>
      </div>
    );
  }

  const refreshButtonStyle = {
    "--refresh-duration": `${AUTO_REFRESH_MS}ms`,
  } as React.CSSProperties;

  return (
    <div className={`app-shell pane-${mobilePane} ${isShareSession(session) ? "share-mode" : ""}`}>
      {toast ? <div className="toast">{toast}</div> : null}
      <aside className="sidebar" aria-label={copy.sidebarLabel}>
        <div className="brand-row">
          <BrandLogo variant="compact" />
        </div>

        <div className="account-card">
          <span>{isShareSession(session) ? copy.sharedMailbox : copy.currentMailbox}</span>
          <div
            className={`account-address-row ${(isShareSession(session) && (shareInfo?.addresses.length || 0) > 1) ? "has-mailbox-menu" : ""}`}
            ref={mailboxMenuRef}
            data-current-mailbox-id={isShareSession(session) ? session.shareMailboxId : ""}
          >
            <button
              className="address-copy-button"
              type="button"
              onClick={copyCurrentAddress}
              title={copy.copyAddressTitle}
            >
              <span className="address-copy-text">{session.address}</span>
              <span className="address-copy-affordance" aria-hidden="true">{copy.copyAddressAction}</span>
            </button>
            {isShareSession(session) && (shareInfo?.addresses.length || 0) > 1 ? (
              <button
                className="mailbox-menu-button"
                type="button"
                aria-label={copy.selectMailbox}
                aria-expanded={mailboxMenuOpen}
                aria-controls="shared-mailbox-menu"
                disabled={loading === "login" || loading === "sync"}
                onClick={() => setMailboxMenuOpen((open) => !open)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M4.2 6.3 8 10l3.8-3.7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : null}
            <em className={`copy-hint ${addressCopied ? "visible" : ""}`} aria-live="polite">{copy.copied}</em>
            {isShareSession(session) && (shareInfo?.addresses.length || 0) > 1 && mailboxMenuOpen ? (
              <div className="mailbox-menu" id="shared-mailbox-menu" role="listbox" aria-label={copy.selectMailbox}>
                {shareInfo?.addresses.map((mailbox) => {
                  const label = getMailboxLabel(mailbox, locale);
                  const selected = mailbox.id === session.shareMailboxId;
                  return (
                    <button
                      key={mailbox.id}
                      className={`mailbox-menu-option ${selected ? "active" : ""}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        setMailboxMenuOpen(false);
                        void switchSharedMailbox(mailbox.id);
                      }}
                    >
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>

        <div className="toolbar">
          <button
            className={`primary-button refresh-button ${autoRefreshEnabled ? "auto-refresh-active" : ""}`}
            disabled={loading === "sync" || isRefreshing}
            aria-busy={isRefreshing}
            onClick={() => {
              setRefreshCycleKey((key) => key + 1);
              void refresh();
            }}
            style={refreshButtonStyle}
            title={autoRefreshEnabled ? copy.refreshTitleOn : copy.refreshTitleOff}
          >
            <span key={refreshCycleKey} className="refresh-icon" aria-hidden="true">
              <svg className="refresh-ring" viewBox="0 0 20 20" focusable="false">
                <circle className="refresh-ring-track" cx="10" cy="10" r="7" />
                <circle className="refresh-ring-progress" cx="10" cy="10" r="7" />
              </svg>
            </span>
            <span>{refreshFeedback || copy.refresh}</span>
          </button>
          <button
            className={`auto-refresh-button ${autoRefreshEnabled ? "active" : ""}`}
            type="button"
            aria-pressed={autoRefreshEnabled}
            title={autoRefreshEnabled ? copy.autoRefreshTitleOn : copy.autoRefreshTitleOff}
            onClick={() => {
              setAutoRefreshEnabled((enabled) => {
                const next = !enabled;
                showToast(next ? copy.autoOn : copy.autoOff);
                return next;
              });
            }}
          >
            <span className="auto-dot" aria-hidden="true" />
            <span>{copy.auto}</span>
          </button>
          <WebmailLocaleMenu locale={locale} setLocale={setLocale} title={copy.localeTitle} label={copy.languageLabel} />
          <button className="ghost-button" onClick={logout}>{copy.logout}</button>
        </div>

        <div className="mail-list" aria-label={copy.sidebarLabel}>
          {mails.map((mail) => (
            <MailListRow
              key={mail.id}
              mail={mail}
              selected={mail.id === selectedMail?.id}
              locale={locale}
              noContent={copy.noContent}
              verificationCodeLabel={copy.verificationCode}
              copiedLabel={copy.copied}
              copied={copiedCodeMailId === mail.id}
              onSelect={selectMail}
              onCopyVerificationCode={copyVerificationCode}
            />
          ))}
          {!mails.length && loading !== "sync" ? (
            <div className="list-empty">
              <strong>{copy.emptyList}</strong>
              <span>{copy.emptyBody}</span>
            </div>
          ) : null}
        </div>

        {hasMoreHistory ? (
          <button className="load-more" disabled={loading === "sync"} onClick={loadMore}>
            {copy.loadMore}
          </button>
        ) : mails.length ? (
          <div className="end-note">{copy.allLoaded}</div>
        ) : null}
        <a className="official-repository-link sidebar-repository-link" href={OFFICIAL_GITHUB_URL} target="_blank" rel="noreferrer" title={copy.officialRepositoryTitle}>
          {copy.officialRepository}
        </a>
      </aside>

      <main className="reader" aria-label={copy.readerLabel}>
        {error && !mails.length ? (
          <section className="empty-state error-state">
            <h1>{copy.loadFailed}</h1>
            <p>{error}</p>
            <button className="primary-button" onClick={() => {
              const run = getRunForSession(session);
              void hydrateAndSync(session, run);
            }}>{copy.retry}</button>
          </section>
        ) : selectedMail ? (
          <article className="mail-detail">
            <button className="mobile-back" onClick={() => setMobilePane("list")}>{copy.backToList}</button>
            <header className="detail-header">
              <BrandAvatar sender={selectedMail.from?.address || getSender(selectedMail, locale)} senderName={selectedMail.from?.name || getSender(selectedMail, locale)} size={42} className="mail-detail-brand-avatar" />
              <div className="detail-title-block">
                <h1>{selectedMail.subject}</h1>
                <p>{getSender(selectedMail, locale)} · {formatDate(selectedMail.date || selectedMail.createdAt, locale)}</p>
              </div>
              <div className="detail-actions">
                {selectedMail.verificationCode ? (
                  <button className="primary-button" onClick={() => copyVerificationCode(selectedMail)}>
                    {copy.copyCode}
                  </button>
                ) : null}
                <button className="ghost-button" onClick={() => copyText(bodyText).then(() => showToast(copy.bodyCopied))}>{copy.copyBody}</button>
                {(!isShareSession(session) || shareInfo?.permissions?.hideMail) ? <button className="danger-button" onClick={() => removeMail(selectedMail)}>{isShareSession(session) ? copy.hideMail : copy.delete}</button> : null}
              </div>
            </header>

            {error ? <div className="inline-error">{error}</div> : null}

            <dl className="meta-grid">
              <div><dt>{copy.sender}</dt><dd>{selectedMail.from?.address || getSender(selectedMail, locale)}</dd></div>
              <div><dt>{copy.recipient}</dt><dd>{selectedMail.to?.map((item) => item.address || item.name).join(", ") || session.address}</dd></div>
              <div><dt>{copy.attachments}</dt><dd>{selectedMail.attachments?.length ? (locale === "en-US" ? `${selectedMail.attachments.length}` : `${selectedMail.attachments.length} 个`) : copy.none}</dd></div>
            </dl>

            <div className="mail-view-tabs" role="tablist" aria-label={copy.mailFormat}>
              <button
                className={activeViewMode === "html" ? "active" : ""}
                disabled={!selectedMail.html}
                onClick={() => setMailViewMode("html")}
                type="button"
              >
                {copy.htmlFormat}
              </button>
              <button
                className={activeViewMode === "text" ? "active" : ""}
                onClick={() => setMailViewMode("text")}
                type="button"
              >
                {copy.textFormat}
              </button>
              <button
                className={activeViewMode === "source" ? "active" : ""}
                onClick={() => setMailViewMode("source")}
                type="button"
              >
                {copy.sourceFormat}
              </button>
            </div>

            <div className={`mail-body-shell mode-${activeViewMode}`}>
              {activeViewMode === "html" && selectedMail.html ? (
                selectedResolvedHtml ? (
                  <MailHtmlView html={selectedResolvedHtml} />
                ) : (
                  <div className="mail-image-loading" aria-label={copy.optimizingImages}>
                    <div className="spinner compact-spinner" />
                  </div>
                )
              ) : (
                <pre className={`plain-body ${activeViewMode === "source" ? "source-body" : ""}`}>{activeViewMode === "source" ? selectedMail.raw || copy.noSource : bodyText || copy.noContent}</pre>
              )}
            </div>
          </article>
        ) : (
          <section className="empty-state">
            <h1>{copy.emptyTitle}</h1>
            {copy.emptyBody ? <p>{copy.emptyBody}</p> : null}
          </section>
        )}
      </main>
    </div>
  );
}
