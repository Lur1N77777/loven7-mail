import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type TouchEvent } from 'react';
import { ArrowLeft, CheckCheck, ChevronDown, Copy, Download, MoreHorizontal, Paperclip, RefreshCw, Reply, ReplyAll, Star, Trash2, X } from 'lucide-react';
import { buildQuery, type Requester } from '../lib/api';
import { ADDRESS_INPUT_DEBOUNCE_MS, CACHE_TTL, COPY_HINT_MS, DEFAULT_PAGE_SIZE, MAIL_READ_HISTORY_MAX, NEW_MAIL_FLASH_MS, STORAGE_KEYS, SWIPE } from '../lib/constants';
import { cls, formatDateTime, formatShortDate, normalizeSearch } from '../lib/format';
import { copyText } from '../lib/clipboard';
import { readJsonStorage, readStorage, writeJsonStorage, writeLocalStorage } from '../lib/storage';
import { buildMailHtmlDocument, getDownloadEmlUrl, looksLikeMimeSource, parseRawMail, parseRawMailListItem, parseSendbox, sanitizeMailHtml, sanitizeVerificationCode } from '../lib/mailParser';
import type { ComposePayload, ListResponse, ParsedMail, ParsedSendbox, RawMailRecord, SendboxRecord } from '../types/api';
import { EmptyState, LoadingState, Pagination, type Notify, useConfirm } from '../components/Common';
import { BrandAvatar } from '../lib/brandIdentity';
import type { MenuKey } from '../components/Shell';

type MailMode = 'inbox' | 'unknown' | 'sent';
type AnyMail = ParsedMail | ParsedSendbox;
type MailListEntry =
  | { type: 'single'; key: string; mail: AnyMail }
  | { type: 'stack'; key: string; senderKey: string; mails: AnyMail[]; latest: AnyMail; codeCount: number; unreadCount: number };

type MailListCache = {
  version: number;
  count: number;
  savedAt: number;
  items: AnyMail[];
};
type MailboxAddressRequest = { address: string; requestId: number };
type FetchOptions = { addressOverride?: string; pageOverride?: number; forceRefresh?: boolean };

const MAIL_LIST_CACHE_VERSION = 4;
const isParsed = (mail: AnyMail): mail is ParsedMail => typeof (mail as ParsedMail).senderAddress === 'string';
const storageId = (mode: MailMode, id: number) => `${mode}:${id}`;

function isCompactMailViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px), (hover: none) and (pointer: coarse)').matches;
}

function useCompactMailViewport(): boolean {
  const [compact, setCompact] = useState(isCompactMailViewport);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const query = window.matchMedia('(max-width: 1023px), (hover: none) and (pointer: coarse)');
    const update = () => setCompact(query.matches);
    update();
    if (query.addEventListener) query.addEventListener('change', update);
    else query.addListener?.(update);
    window.addEventListener('resize', update, { passive: true });
    window.addEventListener('orientationchange', update, { passive: true });
    return () => {
      if (query.removeEventListener) query.removeEventListener('change', update);
      else query.removeListener?.(update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return compact;
}

function getRecipient(mail: AnyMail): string {
  if (isParsed(mail)) return mail.address || mail.to || '';
  return mail.to_mail || '';
}

const EMAIL_IN_TEXT_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;

function normalizeMailAddressToken(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeMailAddressToken(item);
      if (normalized) return normalized;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return normalizeMailAddressToken(record.email || record.address || record.mail || record.name || '');
  }
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  const email = text.match(EMAIL_IN_TEXT_RE)?.[0] || '';
  if (email) return email;
  return text
    .replace(/^mailto:/i, '')
    .replace(/[<>"']/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function getStackRecipientKey(mail: AnyMail): string {
  // 堆叠必须以“后端记录的实际收件邮箱”为准。
  // 邮件头里的 To/Delivered-To 可能为空、群发、别名或被伪造；拿它兜底会把不同收件邮箱误堆到一起。
  const backendRecipientCandidates = isParsed(mail)
    ? [mail.address, (mail as any).recipient, (mail as any).mailbox, (mail as any).mail_address, (mail as any).to_address]
    : [mail.to_mail, (mail as any).address, (mail as any).recipient, (mail as any).mailbox, (mail as any).mail_address, (mail as any).to_address];
  for (const candidate of backendRecipientCandidates) {
    const normalized = normalizeMailAddressToken(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function getSender(mail: AnyMail): string {
  return isParsed(mail) ? mail.sender : mail.address;
}

function getSenderAddress(mail: AnyMail): string {
  return isParsed(mail) ? mail.senderAddress : String(mail.from_mail || mail.address || '');
}

function getSenderName(mail: AnyMail): string {
  return isParsed(mail) ? mail.senderName : String(mail.from_name || mail.address || '');
}

function normalizeSenderKey(mail: AnyMail): string {
  const address = getSenderAddress(mail).trim().toLowerCase();
  if (address) return address;
  const sender = getSender(mail).trim().toLowerCase();
  return sender ? `name:${sender}` : `mail:${mail.id}`;
}

function normalizeMailStackKey(mail: AnyMail): string | null {
  const recipientKey = getStackRecipientKey(mail);
  if (!recipientKey) return null;
  return `${recipientKey}::${normalizeSenderKey(mail)}`;
}

function groupConsecutiveSenderMails(mails: AnyMail[], enabled: boolean): MailListEntry[] {
  if (!enabled) return mails.map((mail) => ({ type: 'single' as const, key: `mail:${mail.id}`, mail }));
  const entries: MailListEntry[] = [];
  let previousStackKey: string | null = null;

  for (const mail of mails) {
    const stackKey = normalizeMailStackKey(mail);
    const last = entries[entries.length - 1];

    // 只有“同一个实际收件邮箱 + 同一个发件人 + 当前列表中连续相邻”才允许堆叠。
    // 没有可信收件邮箱时宁可单独展示，也绝不跨邮箱误合并。
    if (stackKey && last?.type === 'stack' && previousStackKey === stackKey && last.senderKey === stackKey) {
      last.mails.push(mail);
      last.codeCount += getVerificationCodes(mail).length;
      if (mail.isUnread) last.unreadCount += 1;
      previousStackKey = stackKey;
      continue;
    }

    if (stackKey && last?.type === 'single' && previousStackKey === stackKey && normalizeMailStackKey(last.mail) === stackKey) {
      const stackMails = [last.mail, mail];
      entries[entries.length - 1] = {
        type: 'stack',
        key: `stack:${stackKey}:${last.mail.id}`,
        senderKey: stackKey,
        mails: stackMails,
        latest: last.mail,
        codeCount: stackMails.reduce((sum, item) => sum + getVerificationCodes(item).length, 0),
        unreadCount: stackMails.filter((item) => item.isUnread).length,
      };
      previousStackKey = stackKey;
      continue;
    }

    entries.push({ type: 'single', key: `mail:${mail.id}`, mail });
    previousStackKey = stackKey;
  }
  return entries;
}

const searchTextCache = new WeakMap<AnyMail, string>();

function getSearchText(mail: AnyMail): string {
  const cached = searchTextCache.get(mail);
  if (cached) return cached;
  const value = normalizeSearch(`${getSender(mail)} ${getRecipient(mail)} ${mail.subject} ${mail.preview} ${!isParsed(mail) ? mail.to_mail : mail.to}`);
  searchTextCache.set(mail, value);
  return value;
}

function getVerificationCodes(mail: AnyMail): string[] {
  const list = Array.isArray((mail as any).verificationCodes) ? (mail as any).verificationCodes : [];
  return [...new Set([...(list as string[]), mail.verificationCode]
    .map(sanitizeVerificationCode)
    .filter(Boolean) as string[])].slice(0, 6);
}

function getAttachmentObjectUrls(items: AnyMail[]): Set<string> {
  const urls = new Set<string>();
  items.forEach((mail) => {
    if (!isParsed(mail)) return;
    mail.attachments.forEach((attachment) => {
      if (attachment.url?.startsWith('blob:')) urls.add(attachment.url);
    });
  });
  return urls;
}

function applyLocalState<T extends AnyMail>(items: T[], mode: MailMode, readIds: Set<string>, starredIds: Set<string>, readAllBefore: Record<string, number>): T[] {
  return items.map((mail) => {
    const key = storageId(mode, mail.id);
    const readByBulk = mail.id <= Number(readAllBefore[mode] || 0);
    return { ...mail, isUnread: !(readIds.has(key) || readByBulk), isStarred: starredIds.has(key) };
  });
}

function mailListCacheKey(mode: MailMode, page: number, pageSize: number, address: string): string {
  return `${STORAGE_KEYS.mailListCachePrefix}${mode}:${page}:${pageSize}:${encodeURIComponent(address.trim())}`;
}

function mailDetailCacheKey(mode: MailMode, id: number): string {
  return `${STORAGE_KEYS.mailDetailSessionPrefix}${mode}:${id}`;
}

function stripForListCache(mail: AnyMail): AnyMail {
  const clone: any = { ...mail };
  if (isParsed(mail)) {
    clone.raw = '';
    clone.message = '';
    clone.text = mail.preview || '';
    clone.attachments = [];
  } else {
    clone.raw = '';
    clone.content = String(mail.preview || mail.content || '').slice(0, 500);
  }
  return clone as AnyMail;
}

const SESSION_DETAIL_MAX_BYTES = 800_000;

function stripForSessionDetail(mail: AnyMail): AnyMail {
  const clone: any = { ...mail };
  if (isParsed(mail)) clone.attachments = [];
  if (typeof clone.raw === 'string' && clone.raw.length > SESSION_DETAIL_MAX_BYTES) clone.raw = '';
  return clone as AnyMail;
}

function readSessionMailDetail(mode: MailMode, id: number): AnyMail | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(mailDetailCacheKey(mode, id));
    return raw ? JSON.parse(raw) as AnyMail : null;
  } catch {
    return null;
  }
}

function writeSessionMailDetail(mode: MailMode, mail: AnyMail): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(mailDetailCacheKey(mode, mail.id), JSON.stringify(stripForSessionDetail(mail)));
  } catch {
    // 会话缓存失败不影响主流程
  }
}

export function MailWorkspace({ mode, active, request, notify, ask, globalQuery, addressRequest, setActiveMenu, setComposeSeed }: { mode: MailMode; active: boolean; request: Requester; notify: Notify; ask: ReturnType<typeof useConfirm>['ask']; globalQuery: string; addressRequest?: MailboxAddressRequest | null; setActiveMenu: (menu: MenuKey) => void; setComposeSeed: (seed: Partial<ComposePayload>) => void }) {
  const [mails, setMails] = useState<AnyMail[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [count, setCount] = useState(0);
  const [mobileLoadedPages, setMobileLoadedPages] = useState(1);
  const [mobileLoadingMore, setMobileLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [address, setAddress] = useState('');
  const [addressInput, setAddressInput] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [expandedMailStacks, setExpandedMailStacks] = useState<Set<string>>(new Set());
  const [isMobileDetail, setIsMobileDetail] = useState(false);
  const [mobileDetailDragX, setMobileDetailDragX] = useState(0);
  const [mobileDetailSettling, setMobileDetailSettling] = useState(false);
  const [mobileDetailMenuOpen, setMobileDetailMenuOpen] = useState(false);
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set(readJsonStorage<string[]>(STORAGE_KEYS.mailReadIds, [])));
  const [readAllBefore, setReadAllBefore] = useState<Record<string, number>>(() => readJsonStorage<Record<string, number>>(STORAGE_KEYS.mailReadAllBefore, {}));
  const [starredIds, setStarredIds] = useState<Set<string>>(() => new Set(readJsonStorage<string[]>(STORAGE_KEYS.mailStarredIds, [])));
  const [autoRefresh, setAutoRefresh] = useState(() => readStorage(STORAGE_KEYS.mailAutoRefreshEnabled, 'true') !== 'false');
  const [autoSeconds, setAutoSeconds] = useState(() => Math.max(15, Number(readStorage(STORAGE_KEYS.mailAutoRefreshSeconds, '60')) || 60));
  const [refreshCountdown, setRefreshCountdown] = useState(autoSeconds);
  const compactViewport = useCompactMailViewport();
  const consumedAddressRequestRef = useRef<number | null>(null);
  const fetchSeqRef = useRef(0);
  const latestMailsRef = useRef<AnyMail[]>([]);
  const latestCountRef = useRef(0);
  const fetchInFlightRef = useRef(false);
  const suppressNextFetchRef = useRef(false);
  const addressDebounceRef = useRef<number | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const mobileLoadMoreSeqRef = useRef(0);
  const mobileLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const newIdsTimerRef = useRef<number | null>(null);
  const mobileDetailHistoryRef = useRef(false);
  const attachmentUrlsRef = useRef<Set<string>>(new Set());
  const mailSwipeRef = useRef<{ active: boolean; startX: number; startY: number; lastX: number; lastY: number }>({ active: false, startX: 0, startY: 0, lastX: 0, lastY: 0 });
  const deferredQuery = useDeferredValue(normalizeSearch(globalQuery));
  const title = mode === 'sent' ? '发件箱' : mode === 'unknown' ? '未知邮件' : '收件箱';
  const currentListCacheKey = useMemo(() => mailListCacheKey(mode, page, pageSize, address), [address, mode, page, pageSize]);

  useEffect(() => {
    setMobileDetailMenuOpen(false);
  }, [isMobileDetail, selectedId]);
  useEffect(() => {
    setFilterMenuOpen(false);
  }, [activeTab, mode]);
  useEffect(() => {
    setExpandedMailStacks(new Set());
  }, [activeTab, address, deferredQuery, mode, page]);

  const persistReadIds = useCallback((next: Set<string>) => {
    setReadIds(new Set(next));
    writeJsonStorage(STORAGE_KEYS.mailReadIds, [...next].slice(-MAIL_READ_HISTORY_MAX));
  }, []);
  const persistReadAllBefore = useCallback((next: Record<string, number>) => {
    setReadAllBefore(next);
    writeJsonStorage(STORAGE_KEYS.mailReadAllBefore, next);
  }, []);
  const persistStarredIds = useCallback((next: Set<string>) => {
    setStarredIds(new Set(next));
    writeJsonStorage(STORAGE_KEYS.mailStarredIds, [...next].slice(-MAIL_READ_HISTORY_MAX));
  }, []);

  const saveListCache = useCallback((items: AnyMail[], totalCount: number, cacheKey = currentListCacheKey) => {
    writeJsonStorage(cacheKey, {
      version: MAIL_LIST_CACHE_VERSION,
      count: totalCount,
      savedAt: Date.now(),
      items: items.map(stripForListCache),
    });
  }, [currentListCacheKey]);

  const hydrateListCache = useCallback((targetAddress: string, targetPage = 1) => {
    const cacheKey = mailListCacheKey(mode, targetPage, pageSize, targetAddress.trim());
    const cached = readJsonStorage<MailListCache | null>(cacheKey, null);
    if (!cached || cached.version !== MAIL_LIST_CACHE_VERSION || !Array.isArray(cached.items)) return false;
    setMails(applyLocalState(cached.items, mode, readIds, starredIds, readAllBefore));
    setCount(cached.count || cached.items.length);
    return true;
  }, [mode, pageSize, readAllBefore, readIds, starredIds]);

  const loadPage = useCallback(async (offset: number, forceRefresh = false, targetAddress = address, signal?: AbortSignal) => {
    const normalizedAddress = targetAddress.trim();
    if (mode === 'sent') {
      const res = await request<ListResponse<SendboxRecord>>(`/admin/sendbox${buildQuery({ limit: pageSize, offset, address: normalizedAddress })}`, { forceRefresh, signal });
      return { results: (res.results || []).map(parseSendbox), count: res.count };
    }
    const endpoint = mode === 'unknown' ? '/admin/mails_unknow' : '/admin/mails';
    const res = await request<ListResponse<RawMailRecord>>(`${endpoint}${buildQuery({ limit: pageSize, offset, address: mode === 'inbox' ? normalizedAddress : '' })}`, { forceRefresh, signal });
    return { results: (res.results || []).map(parseRawMailListItem), count: res.count };
  }, [mode, pageSize, request]);

  const fetchData = useCallback(async (incremental = false, options: FetchOptions = {}) => {
    const targetAddress = options.addressOverride ?? address;
    const targetPage = options.pageOverride ?? page;
    const forceNetwork = Boolean(options.forceRefresh || incremental);
    const seq = ++fetchSeqRef.current;
    fetchAbortRef.current?.abort();
    const abortController = new AbortController();
    fetchAbortRef.current = abortController;
    fetchInFlightRef.current = true;
    const currentMails = latestMailsRef.current;
    if (incremental) setRefreshing(true);
    else if (currentMails.length === 0) setLoading(true);
    else setRefreshing(true);
    try {
      const offset = incremental ? 0 : (targetPage - 1) * pageSize;
      const { results, count: totalCount } = await loadPage(offset, forceNetwork, targetAddress, abortController.signal);
      if (seq !== fetchSeqRef.current) return;
      const parsed = applyLocalState(results, mode, readIds, starredIds, readAllBefore);
      const nextCount = typeof totalCount === 'number' ? totalCount : parsed.length;
      setCount(nextCount);

      if (incremental && targetPage !== 1) {
        const addedCount = Math.max(0, nextCount - latestCountRef.current);
        if (addedCount > 0) notify('info', `检测到 ${addedCount} 封新邮件，回到第一页可查看`);
        return;
      }

      setMobileLoadedPages(Math.max(1, targetPage));

      if (incremental && currentMails.length > 0) {
        const existing = new Set(currentMails.map((mail) => mail.id));
        const added = parsed.filter((mail) => !existing.has(mail.id));
        setMails(parsed);
        saveListCache(parsed, nextCount, mailListCacheKey(mode, targetPage, pageSize, targetAddress));
        if (added.length) {
          setNewIds(new Set(added.map((mail) => mail.id)));
          if (newIdsTimerRef.current !== null) window.clearTimeout(newIdsTimerRef.current);
          newIdsTimerRef.current = window.setTimeout(() => { setNewIds(new Set()); newIdsTimerRef.current = null; }, NEW_MAIL_FLASH_MS);
          notify('success', `新增 ${added.length} 封邮件`);
        }
      } else {
        setMails(parsed);
        saveListCache(parsed, nextCount, mailListCacheKey(mode, targetPage, pageSize, targetAddress));
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (seq === fetchSeqRef.current) notify('error', error instanceof Error ? error.message : '邮件加载失败');
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
        setRefreshing(false);
        setRefreshCountdown(Math.max(15, autoSeconds));
        fetchInFlightRef.current = false;
        if (fetchAbortRef.current === abortController) fetchAbortRef.current = null;
      }
    }
  }, [address, autoSeconds, loadPage, mode, notify, page, pageSize, readAllBefore, readIds, saveListCache, starredIds]);

  const closeMobileDetail = useCallback(() => {
    setIsMobileDetail(false);
    if (typeof window !== 'undefined' && mobileDetailHistoryRef.current && window.history.state?.loven7MailDetail) {
      const currentState = { ...(window.history.state || {}) };
      delete currentState.loven7MailDetail;
      window.history.replaceState({ ...currentState, loven7MailBase: true }, document.title, window.location.href);
      mobileDetailHistoryRef.current = false;
      return;
    }
    mobileDetailHistoryRef.current = false;
  }, []);

  const forceAddressInbox = useCallback((nextAddress: string) => {
    const normalizedAddress = nextAddress.trim();
    if (addressDebounceRef.current !== null) {
      window.clearTimeout(addressDebounceRef.current);
      addressDebounceRef.current = null;
    }
    setAddressInput(normalizedAddress);
    suppressNextFetchRef.current = true;
    setAddress(normalizedAddress);
    setPage(1);
    setSelectedId(null);
    setActiveTab('all');
    if (isMobileDetail) closeMobileDetail();
    hydrateListCache(normalizedAddress, 1);
    fetchData(false, { addressOverride: normalizedAddress, pageOverride: 1, forceRefresh: true });
  }, [closeMobileDetail, fetchData, hydrateListCache, isMobileDetail]);

  useEffect(() => {
    latestMailsRef.current = mails;
  }, [mails]);
  useEffect(() => {
    const currentUrls = getAttachmentObjectUrls(mails);
    attachmentUrlsRef.current.forEach((url) => {
      if (!currentUrls.has(url)) URL.revokeObjectURL(url);
    });
    attachmentUrlsRef.current = currentUrls;
  }, [mails]);
  useEffect(() => () => {
    fetchAbortRef.current?.abort();
    attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    attachmentUrlsRef.current.clear();
  }, []);
  useEffect(() => {
    latestCountRef.current = count;
  }, [count]);
  useEffect(() => {
    const nextAddress = addressInput.trim();
    if (nextAddress === address) return undefined;
    const delay = nextAddress ? ADDRESS_INPUT_DEBOUNCE_MS : 0;
    const id = window.setTimeout(() => {
      setAddress(nextAddress);
      setPage(1);
      setSelectedId(null);
      addressDebounceRef.current = null;
    }, delay);
    addressDebounceRef.current = id;
    return () => { window.clearTimeout(id); if (addressDebounceRef.current === id) addressDebounceRef.current = null; };
  }, [address, addressInput]);
  useEffect(() => {
    const cached = readJsonStorage<MailListCache | null>(currentListCacheKey, null);
    if (!cached || cached.version !== MAIL_LIST_CACHE_VERSION || !Array.isArray(cached.items)) return;
    setMails(applyLocalState(cached.items, mode, readIds, starredIds, readAllBefore));
    setCount(cached.count || cached.items.length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentListCacheKey, mode]);
  useEffect(() => {
    if (suppressNextFetchRef.current) {
      suppressNextFetchRef.current = false;
      return;
    }
    fetchData(false);
  }, [mode, page, pageSize, address]);
  useEffect(() => {
    if (mode !== 'inbox' || !addressRequest || consumedAddressRequestRef.current === addressRequest.requestId) return;
    consumedAddressRequestRef.current = addressRequest.requestId;
    forceAddressInbox(addressRequest.address);
  }, [addressRequest, forceAddressInbox, mode]);
  useEffect(() => { setMails((current) => applyLocalState(current, mode, readIds, starredIds, readAllBefore)); }, [mode, readAllBefore, readIds, starredIds]);
  useEffect(() => () => { if (newIdsTimerRef.current !== null) window.clearTimeout(newIdsTimerRef.current); }, []);
  useEffect(() => { writeLocalStorage(STORAGE_KEYS.mailAutoRefreshEnabled, autoRefresh ? 'true' : 'false'); }, [autoRefresh]);
  useEffect(() => { writeLocalStorage(STORAGE_KEYS.mailAutoRefreshSeconds, String(autoSeconds)); }, [autoSeconds]);
  useEffect(() => { setRefreshCountdown(Math.max(15, autoSeconds)); }, [autoSeconds, autoRefresh, active]);
  useEffect(() => {
    const syncRefreshSettings = () => {
      setAutoRefresh(readStorage(STORAGE_KEYS.mailAutoRefreshEnabled, 'true') !== 'false');
      setAutoSeconds(Math.max(15, Number(readStorage(STORAGE_KEYS.mailAutoRefreshSeconds, '60')) || 60));
    };
    window.addEventListener('loven7-mail-refresh-settings', syncRefreshSettings);
    return () => window.removeEventListener('loven7-mail-refresh-settings', syncRefreshSettings);
  }, []);
  useEffect(() => {
    const onGlobalRefresh = (event: Event) => {
      const targetMenu = (event as CustomEvent<{ menu?: string }>).detail?.menu;
      if (!targetMenu || targetMenu === mode) fetchData(true);
    };
    window.addEventListener('loven7-global-refresh', onGlobalRefresh);
    return () => window.removeEventListener('loven7-global-refresh', onGlobalRefresh);
  }, [fetchData, mode]);
  useEffect(() => {
    if (!active || !autoRefresh) return undefined;
    const id = window.setInterval(() => {
      setRefreshCountdown((current) => {
        if (current <= 1) {
          if (!fetchInFlightRef.current) window.setTimeout(() => fetchData(true), 0);
          return Math.max(15, autoSeconds);
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [active, autoRefresh, autoSeconds, fetchData]);
  useEffect(() => {
    if (active && mails.length > 0 && !loading && !refreshing) fetchData(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPopState = () => {
      mobileDetailHistoryRef.current = false;
      if (isMobileDetail) setIsMobileDetail(false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [isMobileDetail]);
  useEffect(() => {
    if (typeof window === 'undefined' || !isMobileDetail || mobileDetailHistoryRef.current || !compactViewport) return;
    const currentState = window.history.state || {};
    if (currentState.loven7MailDetail) {
      mobileDetailHistoryRef.current = true;
      return;
    }
    const baseState = currentState.loven7MailBase ? currentState : { ...currentState, loven7MailBase: true };
    if (!currentState.loven7MailBase) window.history.replaceState(baseState, document.title, window.location.href);
    if (!window.history.state?.loven7MailDetail) window.history.pushState({ ...baseState, loven7MailDetail: true }, document.title, window.location.href);
    mobileDetailHistoryRef.current = true;
  }, [compactViewport, isMobileDetail]);
  useEffect(() => {
    if (compactViewport || !isMobileDetail) return;
    mobileDetailHistoryRef.current = false;
    setIsMobileDetail(false);
  }, [compactViewport, isMobileDetail]);

  const filtered = useMemo(() => mails.filter((mail) => {
    const matchesQuery = !deferredQuery || getSearchText(mail).includes(deferredQuery);
    const matchesTab = activeTab === 'all' || (activeTab === 'attachments' && isParsed(mail) && mail.attachments.length > 0) || (activeTab === 'starred' && Boolean(mail.isStarred)) || (activeTab === 'unread' && Boolean(mail.isUnread)) || (activeTab === 'read' && !mail.isUnread);
    return matchesQuery && matchesTab;
  }), [activeTab, deferredQuery, mails]);
  const mailListEntries = useMemo(() => groupConsecutiveSenderMails(filtered, mode !== 'sent'), [filtered, mode]);
  const selected = filtered.find((mail) => mail.id === selectedId) || filtered[0] || null;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const unreadCount = useMemo(() => mails.filter((mail) => mail.isUnread).length, [mails]);
  const tabOptions = mode === 'sent'
    ? [['all', '全部'], ['starred', '标注'], ['attachments', '附件']]
    : [['all', '全部'], ['unread', '未读'], ['read', '已读'], ['starred', '标注'], ['attachments', '附件']];
  const activeTabLabel = tabOptions.find(([key]) => key === activeTab)?.[1] || '全部';
  const mobileHasMore = mobileLoadedPages < totalPages && mails.length < count;
  const toggleMailStack = useCallback((key: string) => {
    setExpandedMailStacks((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const loadMoreMobile = useCallback(async () => {
    if (!compactViewport || mobileLoadingMore || loading || refreshing || !mobileHasMore) return;
    const nextPage = mobileLoadedPages + 1;
    const seq = ++mobileLoadMoreSeqRef.current;
    setMobileLoadingMore(true);
    try {
      const { results, count: totalCount } = await loadPage((nextPage - 1) * pageSize, false, address);
      if (seq !== mobileLoadMoreSeqRef.current) return;
      const parsed = applyLocalState(results, mode, readIds, starredIds, readAllBefore);
      const existing = new Set(latestMailsRef.current.map((mail) => mail.id));
      const merged = [...latestMailsRef.current, ...parsed.filter((mail) => !existing.has(mail.id))];
      setMails(merged);
      setCount(typeof totalCount === 'number' ? totalCount : Math.max(count, merged.length));
      setMobileLoadedPages(nextPage);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '加载更多邮件失败');
    } finally {
      if (seq === mobileLoadMoreSeqRef.current) setMobileLoadingMore(false);
    }
  }, [address, compactViewport, count, loadPage, loading, mobileHasMore, mobileLoadedPages, mobileLoadingMore, mode, notify, pageSize, readAllBefore, readIds, refreshing, starredIds]);

  useEffect(() => {
    if (!compactViewport || !mobileLoadMoreRef.current) return undefined;
    const target = mobileLoadMoreRef.current;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMoreMobile();
    }, { root: null, rootMargin: '360px 0px 360px 0px', threshold: 0.01 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [compactViewport, loadMoreMobile, filtered.length]);

  const clearAddressFilter = useCallback(() => {
    if (addressDebounceRef.current !== null) {
      window.clearTimeout(addressDebounceRef.current);
      addressDebounceRef.current = null;
    }
    setAddressInput('');
    suppressNextFetchRef.current = true;
    setAddress('');
    setPage(1);
    setSelectedId(null);
    setActiveTab('all');
    hydrateListCache('', 1);
    fetchData(false, { addressOverride: '', pageOverride: 1, forceRefresh: false });
  }, [fetchData, hydrateListCache]);
  const clearAddressFilterFromPress = useCallback((event?: PointerEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => {
    event?.preventDefault();
    event?.stopPropagation();
    clearAddressFilter();
  }, [clearAddressFilter]);

  const markRead = useCallback((mail: AnyMail) => {
    const next = new Set(readIds);
    next.add(storageId(mode, mail.id));
    persistReadIds(next);
    const cachedDetail = readSessionMailDetail(mode, mail.id);
    if (cachedDetail && !(isParsed(cachedDetail) && !cachedDetail.message && (cachedDetail.raw || (isParsed(mail) && mail.raw)))) {
      setMails((current) => current.map((item) => (item.id === mail.id ? { ...item, ...cachedDetail } : item)));
    } else {
      writeSessionMailDetail(mode, mail);
      const rawSource = isParsed(cachedDetail || mail) ? String((cachedDetail || mail).raw || (isParsed(mail) ? mail.raw || '' : '')) : '';
      if (isParsed(mail) && !mail.message && (mail.raw || rawSource)) {
        parseRawMail({ ...mail, raw: mail.raw || rawSource })
          .then((fullMail) => {
            writeSessionMailDetail(mode, fullMail);
            setMails((current) => current.map((item) => (item.id === mail.id ? { ...item, ...fullMail, isUnread: false, isStarred: item.isStarred } : item)));
          })
          .catch((error) => console.warn('mail detail parse failed', error));
      }
    }
    setSelectedId(mail.id);
    if (compactViewport) setIsMobileDetail(true);
  }, [compactViewport, mode, persistReadIds, readIds]);
  const openNextMobileMail = useCallback(() => {
    const currentId = selected?.id ?? selectedId;
    const currentIndex = filtered.findIndex((mail) => mail.id === currentId);
    const nextMail = filtered[currentIndex >= 0 ? currentIndex + 1 : 0];
    if (nextMail) {
      markRead(nextMail);
      return;
    }
    notify('info', '已经是最后一封邮件');
  }, [filtered, markRead, notify, selected?.id, selectedId]);
  const settleMobileDetailOffset = useCallback((offset: number, after?: () => void) => {
    setMobileDetailSettling(true);
    setMobileDetailDragX(offset);
    window.setTimeout(() => {
      after?.();
      setMobileDetailDragX(0);
      window.setTimeout(() => setMobileDetailSettling(false), 30);
    }, 150);
  }, []);
  const closeMobileDetailWithMotion = useCallback(() => {
    const width = typeof window === 'undefined' ? 420 : Math.max(window.innerWidth, 360);
    settleMobileDetailOffset(width, closeMobileDetail);
  }, [closeMobileDetail, settleMobileDetailOffset]);
  const openNextMobileMailWithMotion = useCallback(() => {
    settleMobileDetailOffset(-96, openNextMobileMail);
  }, [openNextMobileMail, settleMobileDetailOffset]);
  const toggleStar = useCallback((mail: AnyMail) => {
    const key = storageId(mode, mail.id);
    const next = new Set(starredIds);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    persistStarredIds(next);
  }, [mode, persistStarredIds, starredIds]);
  const markVisibleRead = () => {
    const targets = filtered.filter((mail) => mail.isUnread);
    if (!targets.length) {
      notify('info', '当前视图没有未读邮件');
      return;
    }
    const next = new Set(readIds);
    targets.forEach((mail) => next.add(storageId(mode, mail.id)));
    persistReadIds(next);
    notify('success', `已标记 ${targets.length} 封为已读`);
  };
  const markAllRead = () => {
    if (!mails.length) {
      notify('info', '当前邮箱没有可标记邮件');
      return;
    }
    const maxId = Math.max(...mails.map((mail) => mail.id), Number(readAllBefore[mode] || 0));
    persistReadAllBefore({ ...readAllBefore, [mode]: maxId });
    notify('success', '已将当前邮箱现有邮件全部标记为已读');
  };
  const copyValue = useCallback(async (value: string, label = '已复制', key?: string) => {
    try {
      await copyText(value);
      if (key) {
        setCopiedKey(key);
        window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), COPY_HINT_MS);
      }
      notify('success', label);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '复制失败，请手动复制');
    }
  }, [notify]);
  const deleteMail = (mail: AnyMail) => ask({ title: `删除邮件 #${mail.id}`, body: mode === 'sent' ? '将删除该发件箱记录。' : '将删除该原始邮件记录。', actionLabel: '删除', onConfirm: async () => { await request(mode === 'sent' ? `/admin/sendbox/${mail.id}` : `/admin/mails/${mail.id}`, { method: 'DELETE' }); notify('success', '邮件已删除'); setSelectedId(null); setMails((current) => current.filter((item) => item.id !== mail.id)); await fetchData(true); } });
  const composeFromMail = (mail: AnyMail, kind: 'reply' | 'forward') => {
    if (isParsed(mail)) setComposeSeed({ from_mail: mail.address || '', to_mail: kind === 'reply' ? mail.senderAddress : '', to_name: kind === 'reply' ? mail.senderName : '', subject: `${kind === 'reply' ? 'Re' : 'Fwd'}: ${mail.subject}`, content: `\n\n---- 原邮件 ----\n${mail.text || mail.preview}`, is_html: false });
    else setComposeSeed({ from_mail: mail.address, subject: `Fwd: ${mail.subject}`, content: mail.content, is_html: mail.is_html });
    setActiveMenu('compose');
  };
  useEffect(() => {
    if (!isMobileDetail) return undefined;
    const isInsideDetail = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('.mobile-mail-detail'));
    const handleNativeStart = (event: globalThis.TouchEvent) => {
      if (event.touches.length !== 1 || !isInsideDetail(event.target)) return;
      const touch = event.touches[0];
      mailSwipeRef.current = { active: true, startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastY: touch.clientY };
    };
    const handleNativeMove = (event: globalThis.TouchEvent) => {
      if (!mailSwipeRef.current.active || event.touches.length !== 1 || !isInsideDetail(event.target)) return;
      mailSwipeRef.current.lastX = event.touches[0].clientX;
      mailSwipeRef.current.lastY = event.touches[0].clientY;
      const dx = mailSwipeRef.current.lastX - mailSwipeRef.current.startX;
      const dy = Math.abs(mailSwipeRef.current.lastY - mailSwipeRef.current.startY);
      if (Math.abs(dx) > SWIPE.startThreshold && Math.abs(dx) > dy * SWIPE.ratio) {
        event.preventDefault();
        setMobileDetailSettling(false);
        setMobileDetailDragX(Math.max(-96, Math.min(dx, 140)));
      }
    };
    const handleNativeEnd = (event: globalThis.TouchEvent) => {
      if (!mailSwipeRef.current.active || !isInsideDetail(event.target)) return;
      const swipe = mailSwipeRef.current;
      mailSwipeRef.current = { active: false, startX: 0, startY: 0, lastX: 0, lastY: 0 };
      const dx = swipe.lastX - swipe.startX;
      const dy = Math.abs(swipe.lastY - swipe.startY);
      if (Math.abs(dx) < SWIPE.mailMinDistance || dy > SWIPE.mailMaxVertical) {
        settleMobileDetailOffset(0);
        return;
      }
      event.preventDefault();
      if (dx > 0) closeMobileDetailWithMotion();
      else openNextMobileMailWithMotion();
    };
    const handleNativeCancel = () => {
      mailSwipeRef.current = { active: false, startX: 0, startY: 0, lastX: 0, lastY: 0 };
      settleMobileDetailOffset(0);
    };
    document.addEventListener('touchstart', handleNativeStart, { capture: true, passive: true });
    document.addEventListener('touchmove', handleNativeMove, { capture: true, passive: false });
    document.addEventListener('touchend', handleNativeEnd, { capture: true, passive: false });
    document.addEventListener('touchcancel', handleNativeCancel, { capture: true, passive: true });
    return () => {
      document.removeEventListener('touchstart', handleNativeStart, { capture: true });
      document.removeEventListener('touchmove', handleNativeMove, { capture: true });
      document.removeEventListener('touchend', handleNativeEnd, { capture: true });
      document.removeEventListener('touchcancel', handleNativeCancel, { capture: true });
    };
  }, [closeMobileDetailWithMotion, isMobileDetail, openNextMobileMailWithMotion, settleMobileDetailOffset]);

  useEffect(() => {
    if (!isMobileDetail) return undefined;
    const handleFrameSwipe = (event: MessageEvent) => {
      const data = event.data as { type?: string; direction?: 'left' | 'right'; dx?: number } | null;
      if (!data) return;
      if (data.type === 'loven7-mail-iframe-swipe-progress') {
        setMobileDetailSettling(false);
        setMobileDetailDragX(Math.max(-96, Math.min(140, Number(data.dx || 0))));
        return;
      }
      if (data.type !== 'loven7-mail-iframe-swipe') return;
      if (data.direction === 'right') closeMobileDetailWithMotion();
      else if (data.direction === 'left') openNextMobileMailWithMotion();
    };
    window.addEventListener('message', handleFrameSwipe);
    return () => window.removeEventListener('message', handleFrameSwipe);
  }, [closeMobileDetailWithMotion, isMobileDetail, openNextMobileMailWithMotion]);

  return (
    <div className="mail-workspace flex h-full min-h-0 overflow-hidden bg-white">
      <div className={cls('mail-list-panel relative flex h-full min-h-0 w-full shrink-0 flex-col border-r border-slate-100 lg:w-[430px] xl:w-[470px]', isMobileDetail ? 'hidden lg:flex' : 'flex')}>
        <div className="mail-list-header shrink-0 px-2.5 py-2 md:p-4 md:pb-2">
          <div className="mail-toolbar flex flex-wrap items-center gap-2">
            <div className="mr-auto min-w-0">
              <div className="mail-title-line flex items-center gap-2">
                <h2 className="mail-title-heading truncate text-[17px] font-bold text-slate-800 md:text-2xl">{title}</h2>
                <span className="mail-count-badge rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 md:text-sm">{count || filtered.length} 封</span>
                {unreadCount > 0 && <span className="mail-count-badge unread rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-800">{unreadCount} 未读</span>}
              </div>
              <div className="mt-1 text-[11px] font-medium text-slate-500">{autoRefresh ? `自动刷新开启 · ${refreshCountdown}s 后同步` : '自动刷新关闭'}</div>
            </div>
            <div className="mail-toolbar-actions" data-no-page-swipe="true">
              {!(mode === 'inbox' || mode === 'sent') && <button className="mail-tool-btn primary" onClick={() => fetchData(true)} title="增量刷新" aria-label="增量刷新"><RefreshCw size={15} className={cls(refreshing && 'animate-spin')} /><span className="mail-tool-text">刷新</span></button>}
              <div className="mail-filter-popover" data-no-page-swipe="true">
                <button
                  type="button"
                  className={cls('mail-filter-select mail-filter-trigger', filterMenuOpen && 'active')}
                  onClick={() => setFilterMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={filterMenuOpen}
                  aria-label="邮件筛选"
                >
                  <span>{activeTabLabel}</span>
                  <ChevronDown size={14} className="mail-filter-chevron" />
                </button>
                {filterMenuOpen && (
                  <div className="mail-filter-menu" role="menu">
                    {tabOptions.map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        role="menuitemradio"
                        aria-checked={activeTab === key}
                        className={cls(activeTab === key && 'active')}
                        onClick={() => { setActiveTab(key); setPage(1); setFilterMenuOpen(false); }}
                      >
                        <span>{label}</span>
                        {activeTab === key && <span className="mail-filter-selected-dot" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button className="mail-tool-btn mail-read-btn" onClick={markVisibleRead} title="将当前筛选结果标记为已读" aria-label="一键已读"><CheckCheck size={15} /><span className="mail-tool-text">一键已读</span></button>
              <button className="mail-tool-btn mail-read-btn" onClick={markAllRead} title="将当前邮箱已存在邮件全部标记为已读" aria-label="全部已读"><CheckCheck size={15} /><span className="mail-tool-text">全部已读</span></button>
            </div>
          </div>
          {(mode === 'inbox' || mode === 'sent') && <div className="mail-address-search-row mt-2" data-no-page-swipe="true">
            <div className="address-filter-wrap">
              <input
                value={addressInput}
                onChange={(e) => { setAddressInput(e.target.value); setPage(1); setSelectedId(null); }}
                onKeyDown={(event) => { if (event.key === 'Escape' && addressInput) clearAddressFilter(); }}
                className="form-input address-filter-input rounded-xl py-1.5 pr-9 text-[13px] md:rounded-2xl md:py-2 md:text-sm"
                placeholder="筛选邮箱地址"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
              />
              {addressInput && (
                <button
                  type="button"
                  className="address-filter-clear"
                  data-no-page-swipe="true"
                  onPointerDown={clearAddressFilterFromPress}
                  onTouchStart={clearAddressFilterFromPress}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={clearAddressFilterFromPress}
                  aria-label="清空邮箱地址筛选"
                  title="清空邮箱地址筛选"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <button className="mail-tool-btn primary mail-search-refresh" onClick={() => fetchData(true)} title="增量刷新" aria-label="增量刷新"><RefreshCw size={15} className={cls(refreshing && 'animate-spin')} /><span className="mail-tool-text">刷新</span></button>
          </div>}
        </div>
        <div className="mail-list-viewport flex-1 overflow-y-auto px-2 pb-2 md:px-4 md:pb-4">
          {loading && mails.length === 0 ? <LoadingState /> : filtered.length === 0 ? <EmptyState title="没有匹配的邮件" body="尝试刷新、修改地址筛选或调整当前筛选。" /> : mailListEntries.map((entry) => (
            entry.type === 'single' ? (
              <MailListItem
                key={entry.key}
                mail={entry.mail}
                mode={mode}
                selected={selected?.id === entry.mail.id}
                isNew={newIds.has(entry.mail.id)}
                copiedKey={copiedKey}
                onOpen={markRead}
                onCopy={copyValue}
                onToggleStar={toggleStar}
              />
            ) : (
              <MailListStackItem
                key={entry.key}
                entry={entry}
                mode={mode}
                selectedId={selected?.id ?? null}
                expanded={expandedMailStacks.has(entry.key)}
                isNew={entry.mails.some((mail) => newIds.has(mail.id))}
                copiedKey={copiedKey}
                onOpen={markRead}
                onCopy={copyValue}
                onToggleStar={toggleStar}
                onToggle={() => toggleMailStack(entry.key)}
              />
            )
          ))}
          {compactViewport && mails.length > 0 && (
            <div ref={mobileLoadMoreRef} className="mobile-mail-load-more" data-no-page-swipe="true">
              {mobileLoadingMore ? '正在加载更多邮件…' : mobileHasMore ? '继续下滑加载更多' : '没有更多邮件'}
            </div>
          )}
        </div>
        {!compactViewport && <Pagination page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} count={count} variant="floating" />}
      </div>
      <div className="mail-detail-pane hidden h-full min-w-0 flex-1 flex-col lg:flex">
        {!compactViewport && <MailDetail mail={selected} mode={mode} onDelete={deleteMail} onReply={(mail) => composeFromMail(mail, 'reply')} onForward={(mail) => composeFromMail(mail, 'forward')} onCopy={copyValue} onToggleStar={toggleStar} />}
      </div>
      {isMobileDetail && (
        <div
          className={cls('mobile-mail-detail absolute inset-0 z-40 flex h-full min-h-0 flex-col bg-white lg:hidden', mobileDetailSettling && 'mobile-detail-settling')}
          style={{ transform: `translate3d(${mobileDetailDragX}px, 0, 0)` }}
        >
          <div className="mobile-detail-topbar flex h-9 shrink-0 items-center border-b border-slate-100 px-2">
            <button onClick={closeMobileDetailWithMotion} className="mobile-detail-back rounded-full p-1.5 text-slate-600 hover:bg-slate-100" aria-label="返回邮件列表"><ArrowLeft size={18} /></button>
            <span className="mobile-detail-topbar-title min-w-0 flex-1 truncate px-2 text-sm font-semibold text-slate-800">{selected?.subject || '邮件详情'}</span>
            {selected && (
              <div className="mobile-detail-topbar-actions" data-no-page-swipe="true">
                <button
                  onClick={() => toggleStar(selected)}
                  className={cls('mobile-detail-icon-action', selected.isStarred ? 'active' : '')}
                  title="星星代表收藏/标记，点击后可在列表“标注”里筛选"
                  aria-label={selected.isStarred ? '取消标注' : '标注邮件'}
                >
                  <Star size={17} fill={selected.isStarred ? 'currentColor' : 'none'} />
                </button>
                <div className="mobile-detail-more-root">
                  <button
                    type="button"
                    className={cls('mobile-detail-icon-action', mobileDetailMenuOpen && 'active')}
                    onClick={() => setMobileDetailMenuOpen((open) => !open)}
                    aria-haspopup="menu"
                    aria-expanded={mobileDetailMenuOpen}
                    aria-label="更多邮件操作"
                  >
                    <MoreHorizontal size={18} />
                  </button>
                  {mobileDetailMenuOpen && (
                    <div className="mobile-detail-action-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => { setMobileDetailMenuOpen(false); composeFromMail(selected, 'reply'); }}><Reply size={15} />回复</button>
                      <button type="button" role="menuitem" onClick={() => { setMobileDetailMenuOpen(false); composeFromMail(selected, 'forward'); }}><MoreHorizontal size={15} />转发</button>
                      <button type="button" role="menuitem" className="danger" onClick={() => { setMobileDetailMenuOpen(false); deleteMail(selected); }}><Trash2 size={15} />删除</button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <MailDetail mail={selected} mode={mode} onDelete={deleteMail} onReply={(mail) => composeFromMail(mail, 'reply')} onForward={(mail) => composeFromMail(mail, 'forward')} onCopy={copyValue} onToggleStar={toggleStar} mobile />
        </div>
      )}
    </div>
  );
}

const MailListItem = memo(function MailListItem({ mail, mode, selected, isNew, copiedKey, onOpen, onCopy, onToggleStar }: {
  mail: AnyMail;
  mode: MailMode;
  selected: boolean;
  isNew: boolean;
  copiedKey: string | null;
  onOpen: (mail: AnyMail) => void;
  onCopy: (value: string, label?: string, key?: string) => void;
  onToggleStar: (mail: AnyMail) => void;
}) {
  const recipient = getRecipient(mail);
  const primaryCode = getVerificationCodes(mail)[0];
  const senderAddress = getSenderAddress(mail);
  const senderName = getSenderName(mail);
  const copyKey = `recipient-${mode}-${mail.id}`;
  const openByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(mail);
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(mail)}
      onKeyDown={openByKeyboard}
      className={cls('mail-list-item group relative mb-1 w-full cursor-pointer px-3 py-1.5 text-left transition-all md:mb-1 md:px-3.5 md:py-2', selected ? 'mail-row-selected' : 'mail-row-idle', mail.isUnread && 'mail-row-unread', isNew && 'animate-mail-in')}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <BrandAvatar sender={senderAddress} senderName={senderName} size={32} className="mail-list-brand-avatar" />
        <div className="min-w-0 flex-1">
      <div className="mb-0.5 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="mail-sender block truncate text-[13px] font-normal text-slate-600 md:text-[14px]">{getSender(mail)}</span>
          <div className="mt-0.5 flex items-center gap-2">
            <h4 className="mail-subject truncate text-[14px] font-semibold text-slate-900 md:text-[15px]">{mail.subject}</h4>
            {isParsed(mail) && mail.attachments.length > 0 && <Paperclip size={13} className="shrink-0 text-slate-400" />}
          </div>
        </div>
        <div className="mail-list-side flex shrink-0 flex-col items-end gap-1">
          <span className="mail-time text-[12px] font-semibold text-slate-600">{formatShortDate(mail.created_at)}</span>
          {primaryCode && <button type="button" onClick={(event) => { event.stopPropagation(); onCopy(primaryCode, '已复制验证码'); }} className="verify-pill compact">{primaryCode}</button>}
        </div>
      </div>
      <div className="account-address-row mb-0.5">
        <span className="hidden text-xs text-slate-500 sm:inline">收件人</span>
        <button type="button" onClick={(event) => { event.stopPropagation(); onCopy(recipient, '已复制收件人地址', copyKey); }} className="address-copy-button" title="点击复制邮箱地址">{recipient || '未知收件地址'}</button>
        <em className={cls('copy-hint', copiedKey === copyKey && 'show')} aria-live="polite">已复制</em>
      </div>
      <div className="flex items-center gap-2 md:gap-3">
        <p className="line-clamp-1 min-w-0 flex-1 text-[12px] leading-5 text-slate-500 md:text-xs">{mail.preview}</p>
        <span onClick={(event) => { event.stopPropagation(); onToggleStar(mail); }} title="星星代表收藏/标记，点击可固定到“标注”筛选" className={cls('mail-star-toggle shrink-0 rounded-full p-1 transition', mail.isStarred ? 'text-slate-700' : 'text-slate-300 opacity-0 group-hover:opacity-100')}>
          <Star size={15} fill={mail.isStarred ? 'currentColor' : 'none'} />
        </span>
      </div>
        </div>
      </div>
    </div>
  );
});

const MailListStackItem = memo(function MailListStackItem({ entry, mode, selectedId, expanded, isNew, copiedKey, onOpen, onCopy, onToggleStar, onToggle }: {
  entry: Extract<MailListEntry, { type: 'stack' }>;
  mode: MailMode;
  selectedId: number | null;
  expanded: boolean;
  isNew: boolean;
  copiedKey: string | null;
  onOpen: (mail: AnyMail) => void;
  onCopy: (value: string, label?: string, key?: string) => void;
  onToggleStar: (mail: AnyMail) => void;
  onToggle: () => void;
}) {
  const mail = entry.latest;
  const recipient = getRecipient(mail);
  const primaryCode = getVerificationCodes(mail)[0];
  const senderAddress = getSenderAddress(mail);
  const senderName = getSenderName(mail);
  const copyKey = `recipient-stack-${mode}-${mail.id}`;
  const selected = entry.mails.some((item) => item.id === selectedId);
  const openByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(mail);
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(mail)}
      onKeyDown={openByKeyboard}
      className={cls('mail-list-item mail-stack-item group relative mb-1 w-full cursor-pointer px-3 py-1.5 text-left transition-all md:mb-1 md:px-3.5 md:py-2', selected ? 'mail-row-selected' : 'mail-row-idle', entry.unreadCount > 0 && 'mail-row-unread', isNew && 'animate-mail-in', expanded && 'mail-stack-expanded')}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <BrandAvatar sender={senderAddress} senderName={senderName} size={32} className="mail-list-brand-avatar" />
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <span className="mail-sender block truncate text-[13px] font-normal text-slate-600 md:text-[14px]">{getSender(mail)}</span>
              <div className="mt-0.5 flex items-center gap-2">
                <h4 className="mail-subject truncate text-[14px] font-semibold text-slate-900 md:text-[15px]">{mail.subject}</h4>
                <span className="mail-stack-count-pill">{entry.mails.length} 封</span>
                {entry.unreadCount > 0 && <span className="mail-stack-count-pill unread">{entry.unreadCount} 未读</span>}
                {isParsed(mail) && mail.attachments.length > 0 && <Paperclip size={13} className="shrink-0 text-slate-400" />}
              </div>
            </div>
            <div className="mail-list-side flex shrink-0 flex-col items-end gap-1">
              <span className="mail-time text-[12px] font-semibold text-slate-600">{formatShortDate(mail.created_at)}</span>
              <button
                type="button"
                className="mail-stack-expand-button"
                onClick={(event) => { event.stopPropagation(); onToggle(); }}
                aria-expanded={expanded}
              >
                <ChevronDown size={14} className={cls(expanded && 'open')} />
              </button>
            </div>
          </div>
          <div className="account-address-row mb-0.5">
            <span className="hidden text-xs text-slate-500 sm:inline">收件人</span>
            <button type="button" onClick={(event) => { event.stopPropagation(); onCopy(recipient, '已复制收件人地址', copyKey); }} className="address-copy-button" title="点击复制邮箱地址">{recipient || '未知收件地址'}</button>
            <em className={cls('copy-hint', copiedKey === copyKey && 'show')} aria-live="polite">已复制</em>
          </div>
          <div className="flex items-center gap-2 md:gap-3">
            <p className="line-clamp-1 min-w-0 flex-1 text-[12px] leading-5 text-slate-500 md:text-xs">{mail.preview}</p>
            {entry.codeCount > 0 && <span className="verify-pill compact mail-stack-code-pill">{entry.codeCount} 个验证码</span>}
            {primaryCode && <button type="button" onClick={(event) => { event.stopPropagation(); onCopy(primaryCode, '已复制验证码'); }} className="verify-pill compact">{primaryCode}</button>}
            <span onClick={(event) => { event.stopPropagation(); onToggleStar(mail); }} title="星星代表收藏/标记，点击可固定到“标注”筛选" className={cls('mail-star-toggle shrink-0 rounded-full p-1 transition', mail.isStarred ? 'text-slate-700' : 'text-slate-300 opacity-0 group-hover:opacity-100')}>
              <Star size={15} fill={mail.isStarred ? 'currentColor' : 'none'} />
            </span>
          </div>
          <div className={cls('mail-stack-children-shell', expanded && 'open')} aria-hidden={!expanded}>
            <div className="mail-stack-children" onClick={(event) => event.stopPropagation()}>
              {entry.mails.map((stackMail, index) => {
                const stackCodes = getVerificationCodes(stackMail);
                return (
                  <div
                    key={stackMail.id}
                    role="button"
                    tabIndex={expanded ? 0 : -1}
                    className={cls('mail-stack-child', selectedId === stackMail.id && 'active', stackMail.isUnread && 'unread')}
                    onClick={() => onOpen(stackMail)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onOpen(stackMail);
                      }
                    }}
                  >
                    <span className="mail-stack-child-index">{index + 1}</span>
                    <span className="mail-stack-child-main">
                      <strong>{stackMail.subject}</strong>
                      <small>{stackMail.preview || '无内容预览'}</small>
                    </span>
                    {stackCodes[0] ? (
                      <button
                        type="button"
                        className="verify-pill compact mail-stack-child-code"
                        tabIndex={expanded ? 0 : -1}
                        onClick={(event) => {
                          event.stopPropagation();
                          onCopy(stackCodes[0], '已复制验证码');
                        }}
                      >
                        {stackCodes[0]}
                      </button>
                    ) : null}
                    <time>{formatShortDate(stackMail.created_at)}</time>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

function MailDetail({ mail, mode, onDelete, onReply, onForward, onCopy, onToggleStar, mobile: _mobile = false }: { mail: AnyMail | null; mode: MailMode; onDelete: (mail: AnyMail) => void; onReply: (mail: AnyMail) => void; onForward: (mail: AnyMail) => void; onCopy: (value: string, label?: string, key?: string) => void; onToggleStar: (mail: AnyMail) => void; mobile?: boolean }) {
  useEffect(() => { if (mail) writeSessionMailDetail(mode, mail); }, [mail, mode]);
  const parsedForMemo = mail ? isParsed(mail) : false;
  const htmlForFrame = mail ? String(parsedForMemo ? mail.message : mail.is_html ? mail.content : '') : '';
  const rawForDownload = mail && parsedForMemo ? String(mail.raw || '') : '';
  const iframeDocument = useMemo(() => {
    return htmlForFrame ? buildMailHtmlDocument(parsedForMemo ? htmlForFrame : sanitizeMailHtml(htmlForFrame)) : '';
  }, [htmlForFrame, parsedForMemo]);
  const emlUrl = useMemo(() => (rawForDownload ? getDownloadEmlUrl(rawForDownload) : ''), [rawForDownload]);
  useEffect(() => () => { if (emlUrl) URL.revokeObjectURL(emlUrl); }, [emlUrl]);
  if (!mail) return <div className="p-8"><EmptyState title="请选择一封邮件" body="左侧列表选择邮件后，会在这里显示解析后的正文、附件和原始下载入口。" /></div>;
  const parsed = isParsed(mail);
  const text = parsed ? (looksLikeMimeSource(mail.text) ? '' : mail.text) : mail.content;
  const senderAddress = getSenderAddress(mail);
  const senderName = getSenderName(mail);
  const subtitle = parsed ? `<${mail.senderAddress}>` : '发件记录';
  const recipientAddress = getRecipient(mail);
  const verificationCodes = getVerificationCodes(mail);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mail-detail-scroll min-h-0 flex-1 overflow-hidden p-1.5 sm:p-2.5 md:p-4 xl:p-5">
        <article className={cls('mail-detail-card mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col rounded-2xl border border-slate-100/80 bg-white p-2.5 shadow-sm sm:rounded-3xl sm:p-3.5 md:p-4 xl:p-5', _mobile && 'mail-detail-card-mobile')}>
          <header className={cls('mail-detail-header shrink-0', _mobile && 'is-mobile')}>
            <div className="mail-detail-subject-row flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="mail-detail-subject truncate text-[1.05rem] font-bold leading-snug text-slate-800 sm:text-[1.25rem] md:text-[1.45rem]">{mail.subject}</h1>
                <div className="mail-detail-meta-strip mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <span className="mail-detail-meta-pill rounded-full bg-slate-100 px-2 py-0.5">ID #{mail.id}</span>
                  <span className="mail-time mail-detail-meta-pill rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-700">{formatDateTime(mail.created_at)}</span>
                  {mode === 'unknown' && <span className="mail-detail-meta-pill rounded-full bg-rose-50 px-2 py-0.5 text-rose-600">未知邮件</span>}
                  {verificationCodes.map((code) => <button key={code} onClick={() => onCopy(code, '已复制验证码')} className="verify-pill"><Copy size={12} /> {code}</button>)}
                </div>
              </div>
              <button onClick={() => onToggleStar(mail)} className={cls('mail-detail-star rounded-full p-2 transition hover:bg-slate-100', mail.isStarred ? 'text-slate-800' : 'text-slate-300 hover:text-slate-600')} title="星星代表收藏/标记，点击后可在列表“标注”里筛选"><Star size={21} fill={mail.isStarred ? 'currentColor' : 'none'} /></button>
            </div>
            <div className="mail-detail-sender-row mt-2.5 flex gap-2.5 md:mt-3"><BrandAvatar sender={senderAddress} senderName={senderName} size={40} className="mail-detail-brand-avatar" /><div className="min-w-0 flex-1"><div className="mail-detail-sender-main flex flex-wrap items-center gap-2"><span className="font-semibold text-slate-800">{parsed ? mail.senderName : mail.address}</span><span className="truncate text-sm text-slate-500">{subtitle}</span></div><div className="account-address-row mail-detail-recipient-row mt-0.5"><span className="text-sm text-slate-500">收件人：</span><button type="button" onClick={() => onCopy(recipientAddress, '已复制收件人地址', `detail-recipient-${mode}-${mail.id}`)} className="plain-copy-address" title="点击复制邮箱地址">{recipientAddress || '未知收件地址'}</button></div></div><div className="hidden shrink-0 items-center gap-1.5 lg:flex"><button onClick={() => onReply(mail)} className="detail-action" title="回复"><Reply size={16} /></button><button onClick={() => onReply(mail)} className="detail-action" title="回复全部"><ReplyAll size={16} /></button><button onClick={() => onForward(mail)} className="detail-action" title="转发"><MoreHorizontal size={16} /></button><button onClick={() => onDelete(mail)} className="detail-action text-rose-500" title="删除"><Trash2 size={16} /></button></div></div>
          </header>
          <div className="my-2 h-px shrink-0 bg-slate-100 md:my-2.5" />
          <div className="mail-detail-body min-h-0 flex-1 overflow-hidden">
            {iframeDocument ? <iframe title={`mail-${mail.id}`} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcDoc={iframeDocument} referrerPolicy="no-referrer" className="mail-frame" /> : <pre className="mail-text">{text || mail.preview || '邮件正文仍在后台同步，请稍后刷新。'}</pre>}
          </div>
          {parsed && mail.attachments.length > 0 && <div className="mt-2.5 shrink-0"><h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800"><Paperclip size={16} /> 附件 ({mail.attachments.length})</h4><div className="grid max-h-24 gap-2 overflow-y-auto sm:grid-cols-2">{mail.attachments.map((attachment) => <a key={attachment.id} href={attachment.url} download={attachment.filename} className="flex items-center justify-between rounded-2xl border border-slate-200 p-2 transition hover:bg-slate-50"><div className="flex min-w-0 items-center gap-2"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-[10px] font-bold uppercase text-slate-700">{attachment.filename.split('.').pop() || 'file'}</div><div className="min-w-0"><p className="truncate text-xs font-medium text-slate-700">{attachment.filename}</p><p className="text-[11px] text-slate-400">{attachment.size}</p></div></div><Download size={14} className="text-slate-400" /></a>)}</div></div>}
          <footer className="mt-2.5 flex shrink-0 flex-wrap gap-2 border-t border-slate-100 pt-2.5"><button className="btn-secondary compact" onClick={() => onReply(mail)}><Reply size={15} /> 回复</button><button className="btn-secondary compact" onClick={() => onForward(mail)}><MoreHorizontal size={15} /> 转发</button>{parsed && mail.raw && emlUrl && <a className="btn-secondary compact" href={emlUrl} download={`${mail.id}.eml`}><Download size={15} /> 下载 EML</a>}<button className="btn-danger compact" onClick={() => onDelete(mail)}><Trash2 size={15} /> 删除</button></footer>
        </article>
      </div>
    </div>
  );
}
