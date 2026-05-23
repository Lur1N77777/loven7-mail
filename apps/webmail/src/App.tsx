import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSession, deleteMail, fetchMailPage, fetchSafeSettings, fetchShareInfo, fetchShareMailPage, fetchShareSettings, hideSharedMail } from "./api";
import { clearJwtFromUrl, clearStoredSession, hashToken, loadStoredSession, readJwtFromUrl, saveSession } from "./auth";
import { clearMailboxCache, readMailboxCache, writeMailboxCache } from "./cache";
import { clearImageMemoryCache, resolveMailImageAssets } from "./imageMemoryCache";
import { getMailBodyText, mergeMails, parseMailBatch, sanitizeMailHtml } from "./mailParser";
import { BrandAvatar } from "./brandIdentity";
import type { MailPage, ParsedMail, SafeSettings, ShareInfo, SharedMailbox, WebmailSession } from "./types";
import "./styles.css";

const PAGE_SIZE = 50;
const AUTO_REFRESH_MS = 10_000;

type LoadingState = "boot" | "login" | "sync" | "idle";
type MobilePane = "list" | "reader";
type MailViewMode = "html" | "text" | "source";

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getSender(mail: ParsedMail) {
  return mail.from?.name || mail.from?.address || "未知发件人";
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

function getMailboxLabel(mailbox: SharedMailbox) {
  return mailbox.address || `邮箱 #${mailbox.id}`;
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
        Loven7 Mail
      </span>
    </div>
  );
}

function MailHtmlView({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
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
  const [loginError, setLoginError] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>("list");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [refreshCycleKey, setRefreshCycleKey] = useState(0);
  const [refreshFeedback, setRefreshFeedback] = useState<string | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);
  const [copiedCodeMailId, setCopiedCodeMailId] = useState<number | null>(null);
  const [mailViewMode, setMailViewMode] = useState<MailViewMode>("html");
  const [resolvedHtml, setResolvedHtml] = useState<{ mailId: number; html: string } | null>(null);
  const syncRef = useRef<Promise<void> | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const refreshFeedbackTimerRef = useRef<number | null>(null);
  const autoRefreshTimerRef = useRef<number | null>(null);
  const isRefreshingRef = useRef(false);
  const addressCopyTimerRef = useRef<number | null>(null);
  const codeCopyTimerRef = useRef<number | null>(null);

  const selectedMail = useMemo(
    () => mails.find((mail) => mail.id === selectedId) || mails[0] || null,
    [mails, selectedId]
  );

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

  const fetchSessionMailPage = useCallback((activeSession: WebmailSession, limit: number, offset: number): Promise<MailPage> => {
    if (isShareSession(activeSession)) {
      return fetchShareMailPage(activeSession.shareToken, activeSession.shareMailboxId, limit, offset);
    }
    return fetchMailPage(activeSession.jwt, limit, offset);
  }, []);

  const fetchSessionSettings = useCallback((activeSession: WebmailSession): Promise<SafeSettings> => {
    if (isShareSession(activeSession)) {
      return fetchShareSettings(activeSession.shareToken, activeSession.shareMailboxId);
    }
    return fetchSafeSettings(activeSession.jwt);
  }, []);

  const persist = useCallback(
    async (nextMails: ParsedMail[], offset = nextMails.length, more = hasMoreHistory) => {
      if (!session) return;
      await writeMailboxCache({
        cacheKey: session.cacheKey,
        address: session.address,
        updatedAt: new Date().toISOString(),
        nextOffset: offset,
        mails: nextMails,
      });
      setNextOffset(offset);
      setHasMoreHistory(more);
    },
    [hasMoreHistory, session]
  );

  const loadFirstPage = useCallback(async (activeSession: WebmailSession) => {
    const page = await fetchSessionMailPage(activeSession, PAGE_SIZE, 0);
    const parsed = await parseMailBatch(page.results);
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
    setNextOffset(next.length);
    setHasMoreHistory(more);
    return next.length;
  }, [fetchSessionMailPage]);

  const syncIncremental = useCallback(
    async (activeSession: WebmailSession, currentMails: ParsedMail[]) => {
      const sinceId = maxMailId(currentMails);
      if (!sinceId) return await loadFirstPage(activeSession);

      const rawNew = [];
      let offset = 0;
      let reachedAnchor = false;
      let reachedEnd = false;
      let totalCount = currentMails.length;

      while (!reachedAnchor && !reachedEnd && offset < PAGE_SIZE * 100) {
        const page = await fetchSessionMailPage(activeSession, PAGE_SIZE, offset);
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
        setHasMoreHistory(currentMails.length < totalCount);
        return 0;
      }

      const parsed = await parseMailBatch(rawNew);
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
      setNextOffset(next.length);
      setHasMoreHistory(next.length < totalCount);
      return rawNew.length;
    },
    [fetchSessionMailPage, loadFirstPage]
  );

  const hydrateAndSync = useCallback(
    async (activeSession: WebmailSession) => {
      if (syncRef.current) return syncRef.current;
      const task = (async () => {
        setLoading("sync");
        setError(null);
        const cached = await readMailboxCache(activeSession.cacheKey);
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
            cachedMails = mergeMails(cachedMails, reparsed);
            setMails(cachedMails);
            await writeMailboxCache({
              cacheKey: activeSession.cacheKey,
              address: activeSession.address,
              updatedAt: new Date().toISOString(),
              nextOffset: cached.nextOffset || cachedMails.length,
              mails: cachedMails,
            });
          }

          const added = await syncIncremental(activeSession, cachedMails);
          if (added > 0) showToast(`新增 ${added} 封邮件`);
        } else {
          await loadFirstPage(activeSession);
        }
        setLoading("idle");
      })()
        .catch((err: Error) => {
          setError(err.message || "同步失败");
          setLoading("idle");
        })
        .finally(() => {
          syncRef.current = null;
        });
      syncRef.current = task;
      return task;
    },
    [loadFirstPage, showToast, syncIncremental]
  );

  const activateSession = useCallback(
    async (jwt: string, address: string, settings?: SafeSettings) => {
      const activeSession: WebmailSession = {
        jwt,
        address: address || "当前邮箱",
        settings,
        cacheKey: await hashToken(`${address || "current"}:${jwt}`),
      };
    saveSession(activeSession);
    setShareInfo(null);
    setSession(activeSession);
    setAutoRefreshEnabled(true);
    setMobilePane("list");
    await hydrateAndSync(activeSession);
    },
    [hydrateAndSync]
  );

  const activateShareMailbox = useCallback(
    async (token: string, info: ShareInfo, mailboxId: string) => {
      const mailbox = info.addresses.find((item) => item.id === mailboxId) || info.addresses[0];
      if (!mailbox) throw new Error("共享链接内没有可用邮箱");
      setLoading("login");
      setError(null);
      setLoginError(null);
      syncRef.current = null;
      clearImageMemoryCache();
      setResolvedHtml(null);
      setMails([]);
      setSelectedId(null);
      setNextOffset(0);
      setHasMoreHistory(false);
      const settings = await fetchShareSettings(token, mailbox.id).catch(() => undefined);
      const activeSession: WebmailSession = {
        jwt: `share:${token}:${mailbox.id}`,
        address: settings?.address || mailbox.address || getMailboxLabel(mailbox),
        settings,
        cacheKey: await hashToken(`share:${token}:${mailbox.id}`),
        shareToken: token,
        shareMailboxId: mailbox.id,
        shareMailboxes: info.addresses,
        readonly: true,
      };
      setShareInfo(info);
      setSession(activeSession);
      setAutoRefreshEnabled(true);
      setMobilePane("list");
      await hydrateAndSync(activeSession);
    },
    [hydrateAndSync]
  );

  const loginWithJwt = useCallback(
    async (jwt: string) => {
      setLoading("login");
      setError(null);
      setLoginError(null);
      const result = await createSession(jwt);
      const activeJwt = result.jwt || jwt;
      const address = result.address || result.settings?.address || "当前邮箱";
      await activateSession(activeJwt, address, result.settings);
    },
    [activateSession]
  );

  const loginWithPassword = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const cleanEmail = email.trim();
      if (!cleanEmail || !password) {
        setLoginError("请输入邮箱和密码");
        return;
      }
      setLoading("login");
      setError(null);
      setLoginError(null);
      try {
        const result = await createSession({ email: cleanEmail, password });
        if (!result.jwt) throw new Error("邮箱或密码错误");
        const address = result.address || result.settings?.address || cleanEmail;
        await activateSession(result.jwt, address, result.settings);
        setPassword("");
      } catch (err) {
        setLoginError(err instanceof Error ? err.message : "邮箱或密码错误");
        setLoading("idle");
      }
    },
    [activateSession, email, password]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const shareToken = readShareTokenFromPath();
      const urlJwt = readJwtFromUrl();
      if (urlJwt) clearJwtFromUrl();
      try {
        if (shareToken) {
          setLoading("login");
          const info = await fetchShareInfo(shareToken);
          if (!cancelled) await activateShareMailbox(shareToken, info, info.addresses[0]?.id || "");
          return;
        }
        if (urlJwt) {
          if (!cancelled) await loginWithJwt(urlJwt);
          return;
        }
        const stored = await loadStoredSession();
        if (cancelled) return;
        if (stored) {
          setSession(stored);
          setMobilePane("list");
          void fetchSessionSettings(stored)
            .then((settings) => {
              const refreshed = { ...stored, address: settings.address || stored.address, settings };
              saveSession(refreshed);
              setSession(refreshed);
            })
            .catch(() => undefined);
          await hydrateAndSync(stored);
        } else {
          setLoading("idle");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "登录失败");
          setLoginError(err instanceof Error ? err.message : "登录失败");
          setLoading("idle");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (refreshFeedbackTimerRef.current) window.clearTimeout(refreshFeedbackTimerRef.current);
      if (autoRefreshTimerRef.current) window.clearInterval(autoRefreshTimerRef.current);
      if (addressCopyTimerRef.current) window.clearTimeout(addressCopyTimerRef.current);
      if (codeCopyTimerRef.current) window.clearTimeout(codeCopyTimerRef.current);
      clearImageMemoryCache();
    };
  }, [activateShareMailbox, fetchSessionSettings, hydrateAndSync, loginWithJwt]);

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
    if (!session || isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    setIsRefreshing(true);
    setError(null);
    if (!options.silent && refreshFeedbackTimerRef.current) {
      window.clearTimeout(refreshFeedbackTimerRef.current);
      refreshFeedbackTimerRef.current = null;
    }
    if (!options.silent) setRefreshFeedback(null);
    try {
      const added = await syncIncremental(session, mails);
      if (!options.silent) showRefreshFeedback(added > 0 ? `新增 ${added}` : "已刷新");
    } catch (err) {
      const message = err instanceof Error ? err.message : "刷新失败";
      setError(message);
      if (!options.silent) showRefreshFeedback("刷新失败");
      showToast(message);
    } finally {
      isRefreshingRef.current = false;
      setIsRefreshing(false);
    }
  }, [mails, session, showRefreshFeedback, showToast, syncIncremental]);

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
    setLoading("sync");
    setError(null);
    try {
      const page = await fetchSessionMailPage(session, PAGE_SIZE, nextOffset);
      const parsed = await parseMailBatch(page.results);
      const next = mergeMails(mails, parsed);
      setMails(next);
      await persist(next, next.length, page.results.length === PAGE_SIZE && next.length < page.count);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading("idle");
    }
  }, [fetchSessionMailPage, loading, mails, nextOffset, persist, session]);

  const removeMail = useCallback(
    async (mail: ParsedMail) => {
      if (!session) return;
      if (isShareSession(session)) {
        if (!shareInfo?.permissions?.hideMail) {
          showToast("该共享链接不允许删除邮件显示");
          return;
        }
        if (!window.confirm(`从此共享链接删除「${mail.subject || "这封邮件"}」的显示？后台真实邮件不会被删除。`)) return;
        await hideSharedMail(session.shareToken, session.shareMailboxId, mail.id);
        const next = mails.filter((item) => item.id !== mail.id);
        setMails(next);
        setSelectedId(next[0]?.id ?? null);
        if (!next.length) setMobilePane("list");
        await persist(next, Math.max(0, nextOffset - 1), hasMoreHistory);
        showToast("已从此共享链接删除显示");
        return;
      }
      if (!window.confirm(`删除「${mail.subject || "这封邮件"}」？`)) return;
      await deleteMail(session.jwt, mail.id);
      const next = mails.filter((item) => item.id !== mail.id);
      setMails(next);
      setSelectedId(next[0]?.id ?? null);
      if (!next.length) setMobilePane("list");
      await persist(next, Math.max(0, nextOffset - 1), hasMoreHistory);
      showToast("邮件已删除");
    },
    [hasMoreHistory, mails, nextOffset, persist, session, shareInfo?.permissions?.hideMail, showToast]
  );

  const logout = useCallback(async () => {
    if (session && !isShareSession(session)) await clearMailboxCache(session.cacheKey).catch(() => undefined);
    if (!isShareSession(session)) clearStoredSession();
    setSession(null);
    setShareInfo(null);
    setAutoRefreshEnabled(true);
    setRefreshFeedback(null);
    setResolvedHtml(null);
    clearImageMemoryCache();
    setMails([]);
    setSelectedId(null);
    setNextOffset(0);
    setHasMoreHistory(false);
    setMobilePane("list");
    setError(null);
    setLoginError(null);
  }, [session]);

  const switchSharedMailbox = useCallback(
    async (mailboxId: string) => {
      if (!session?.shareToken || !shareInfo || mailboxId === session.shareMailboxId) return;
      try {
        await activateShareMailbox(session.shareToken, shareInfo, mailboxId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "切换邮箱失败";
        setError(message);
        showToast(message);
        setLoading("idle");
      }
    },
    [activateShareMailbox, session?.shareMailboxId, session?.shareToken, shareInfo, showToast]
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
    showToast("验证码已复制");
    if (codeCopyTimerRef.current) window.clearTimeout(codeCopyTimerRef.current);
    codeCopyTimerRef.current = window.setTimeout(() => setCopiedCodeMailId(null), 1500);
  }, [showToast]);

  const bodyText = selectedMail ? getMailBodyText(selectedMail) : "";
  const activeViewMode: MailViewMode = selectedMail?.html ? mailViewMode : mailViewMode === "source" ? "source" : "text";
  const selectedResolvedHtml = selectedMail && resolvedHtml?.mailId === selectedMail.id ? resolvedHtml.html : "";

  useEffect(() => {
    let cancelled = false;
    if (!selectedMail?.html || activeViewMode !== "html") {
      setResolvedHtml(null);
      return;
    }

    setResolvedHtml((current) => (current?.mailId === selectedMail.id ? current : null));
    resolveMailImageAssets(selectedMail.html)
      .then((html) => {
        if (!cancelled) setResolvedHtml({ mailId: selectedMail.id, html });
      })
      .catch(() => {
        if (!cancelled) setResolvedHtml({ mailId: selectedMail.id, html: selectedMail.html || "" });
      });

    return () => {
      cancelled = true;
    };
  }, [activeViewMode, selectedMail?.html, selectedMail?.id]);

  if (!session && (loading === "boot" || loading === "login")) {
    return (
      <div className="login-shell">
        {toast ? <div className="toast">{toast}</div> : null}
        <section className="login-card boot-card">
          <BrandLogo variant="hero" />
          <div className="spinner" />
          <p>{loading === "login" ? "正在验证访问凭证" : "正在启动邮箱"}</p>
        </section>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="login-shell">
        {toast ? <div className="toast">{toast}</div> : null}
        <section className="login-card">
          <div className="login-brand">
            <BrandLogo variant="regular" />
            <p>请输入管理员提供的邮箱与密码</p>
          </div>

          <form className="login-form" onSubmit={loginWithPassword}>
            <label>
              <span>邮箱地址</span>
              <input
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoComplete="username"
                placeholder="name@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              <span>密码</span>
              <input
                type="password"
                autoComplete="current-password"
                placeholder="请输入密码"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {loginError || error ? <div className="login-error">{loginError || error}</div> : null}
            <button className="primary-button login-button" disabled={loading === "login"} type="submit">
              {loading === "login" ? "正在登录…" : "登录邮箱"}
            </button>
          </form>
        </section>
      </div>
    );
  }

  const refreshButtonStyle = {
    "--refresh-duration": `${AUTO_REFRESH_MS}ms`,
  } as React.CSSProperties;

  return (
    <div className={`app-shell pane-${mobilePane} ${isShareSession(session) ? "share-mode" : ""}`}>
      {toast ? <div className="toast">{toast}</div> : null}
      <aside className="sidebar" aria-label="邮箱侧栏">
        <div className="brand-row">
          <BrandLogo variant="compact" />
        </div>

        <div className="account-card">
          <span>{isShareSession(session) ? "共享邮箱" : "当前邮箱"}</span>
          {isShareSession(session) && (shareInfo?.addresses.length || 0) > 1 ? (
            <label className="mailbox-switcher">
              <span>选择邮箱</span>
              <select
                value={session.shareMailboxId}
                onChange={(event) => void switchSharedMailbox(event.target.value)}
                disabled={loading === "login" || loading === "sync"}
                aria-label="选择共享邮箱"
              >
                {shareInfo?.addresses.map((mailbox) => (
                  <option key={mailbox.id} value={mailbox.id}>{getMailboxLabel(mailbox)}</option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="account-address-row">
            <button className="address-copy-button" type="button" onClick={copyCurrentAddress} title="点击复制邮箱地址">
              {session.address}
            </button>
            <em className={`copy-hint ${addressCopied ? "visible" : ""}`} aria-live="polite">已复制</em>
          </div>
        </div>

        <div className="toolbar">
          <button
            className={`primary-button refresh-button ${autoRefreshEnabled ? "auto-refresh-active" : ""}`}
            disabled={loading === "sync"}
            onClick={() => {
              setRefreshCycleKey((key) => key + 1);
              void refresh();
            }}
            style={refreshButtonStyle}
            title={autoRefreshEnabled ? "圆环显示距离下次自动刷新约 10 秒" : "手动刷新"}
          >
            <span key={refreshCycleKey} className="refresh-icon" aria-hidden="true">
              <svg className="refresh-ring" viewBox="0 0 20 20" focusable="false">
                <circle className="refresh-ring-track" cx="10" cy="10" r="7" />
                <circle className="refresh-ring-progress" cx="10" cy="10" r="7" />
              </svg>
            </span>
            <span>{refreshFeedback || "刷新"}</span>
          </button>
          <button
            className={`auto-refresh-button ${autoRefreshEnabled ? "active" : ""}`}
            type="button"
            aria-pressed={autoRefreshEnabled}
            title={autoRefreshEnabled ? "已开启：每 10 秒自动刷新" : "开启每 10 秒自动刷新"}
            onClick={() => {
              setAutoRefreshEnabled((enabled) => {
                const next = !enabled;
                showToast(next ? "自动刷新已开启" : "自动刷新已关闭");
                return next;
              });
            }}
          >
            <span className="auto-dot" aria-hidden="true" />
            <span>自动</span>
          </button>
          <button className="ghost-button" onClick={logout}>退出</button>
        </div>

        <div className="mail-list" aria-label="邮件列表">
          {mails.map((mail) => (
            <div
              key={mail.id}
              className={`mail-row ${mail.id === selectedMail?.id ? "selected" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => selectMail(mail)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  selectMail(mail);
                }
              }}
            >
              <div className="mail-row-inner">
                <BrandAvatar sender={mail.from?.address || getSender(mail)} senderName={mail.from?.name || getSender(mail)} size={32} className="mail-list-brand-avatar" />
                <div className="mail-row-content">
                  <span className="mail-row-top">
                    <strong>{mail.subject}</strong>
                    <time>{formatDate(mail.date || mail.createdAt)}</time>
                  </span>
                  <span className="mail-row-from">{getSender(mail)}</span>
                  <span className="mail-row-preview">{mail.preview || "(无内容)"}</span>
                  {mail.verificationCode ? (
                    <span className="code-row">
                      <button
                        type="button"
                        className="code-pill code-copy-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void copyVerificationCode(mail);
                        }}
                      >
                        验证码 {mail.verificationCode}
                      </button>
                      <em className={`code-copy-hint ${copiedCodeMailId === mail.id ? "visible" : ""}`} aria-live="polite">已复制</em>
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
          {!mails.length && loading !== "sync" ? <div className="list-empty">暂无邮件</div> : null}
        </div>

        {hasMoreHistory ? (
          <button className="load-more" disabled={loading === "sync"} onClick={loadMore}>
            加载更多历史
          </button>
        ) : mails.length ? (
          <div className="end-note">已显示已加载历史</div>
        ) : null}
      </aside>

      <main className="reader" aria-label="邮件内容">
        {error && !mails.length ? (
          <section className="empty-state error-state">
            <h1>加载失败</h1>
            <p>{error}</p>
            <button className="primary-button" onClick={() => hydrateAndSync(session)}>重试</button>
          </section>
        ) : selectedMail ? (
          <article key={selectedMail.id} className="mail-detail">
            <button className="mobile-back" onClick={() => setMobilePane("list")}>返回列表</button>
            <header className="detail-header">
              <BrandAvatar sender={selectedMail.from?.address || getSender(selectedMail)} senderName={selectedMail.from?.name || getSender(selectedMail)} size={42} className="mail-detail-brand-avatar" />
              <div className="detail-title-block">
                <h1>{selectedMail.subject}</h1>
                <p>{getSender(selectedMail)} · {formatDate(selectedMail.date || selectedMail.createdAt)}</p>
              </div>
              <div className="detail-actions">
                {selectedMail.verificationCode ? (
                  <button className="primary-button" onClick={() => copyVerificationCode(selectedMail)}>
                    复制验证码
                  </button>
                ) : null}
                <button className="ghost-button" onClick={() => copyText(bodyText).then(() => showToast("正文已复制"))}>复制正文</button>
                {(!isShareSession(session) || shareInfo?.permissions?.hideMail) ? <button className="danger-button" onClick={() => removeMail(selectedMail)}>{isShareSession(session) ? "删除邮件" : "删除"}</button> : null}
              </div>
            </header>

            {error ? <div className="inline-error">{error}</div> : null}

            <dl className="meta-grid">
              <div><dt>发件人</dt><dd>{selectedMail.from?.address || getSender(selectedMail)}</dd></div>
              <div><dt>收件人</dt><dd>{selectedMail.to?.map((item) => item.address || item.name).join(", ") || session.address}</dd></div>
              <div><dt>附件</dt><dd>{selectedMail.attachments?.length ? `${selectedMail.attachments.length} 个` : "无"}</dd></div>
            </dl>

            <div className="mail-view-tabs" role="tablist" aria-label="邮件显示格式">
              <button
                className={activeViewMode === "html" ? "active" : ""}
                disabled={!selectedMail.html}
                onClick={() => setMailViewMode("html")}
                type="button"
              >
                HTML 格式
              </button>
              <button
                className={activeViewMode === "text" ? "active" : ""}
                onClick={() => setMailViewMode("text")}
                type="button"
              >
                显示文本格式
              </button>
              <button
                className={activeViewMode === "source" ? "active" : ""}
                onClick={() => setMailViewMode("source")}
                type="button"
              >
                显示源码格式
              </button>
            </div>

            <div key={`${selectedMail.id}:${activeViewMode}`} className={`mail-body-shell mode-${activeViewMode}`}>
              {activeViewMode === "html" && selectedMail.html ? (
                selectedResolvedHtml ? (
                  <MailHtmlView html={selectedResolvedHtml} />
                ) : (
                  <div className="mail-image-loading">
                    <div className="spinner compact-spinner" />
                    <span>正在优化加载邮件图片…</span>
                  </div>
                )
              ) : (
                <pre className={`plain-body ${activeViewMode === "source" ? "source-body" : ""}`}>{activeViewMode === "source" ? selectedMail.raw || "(无源码)" : bodyText || "(无内容)"}</pre>
              )}
            </div>
          </article>
        ) : (
          <section className="empty-state">
            <h1>暂无邮件</h1>
            <p>有新邮件时点击刷新即可显示。</p>
          </section>
        )}
      </main>
    </div>
  );
}
