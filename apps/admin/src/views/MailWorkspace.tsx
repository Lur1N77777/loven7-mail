import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type TouchEvent, type UIEvent } from 'react';
import { Archive, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Download, MoreHorizontal, Paperclip, RefreshCw, Reply, Star, Trash2, X } from 'lucide-react';
import { buildQuery, type Requester } from '../lib/api';
import { ADDRESS_INPUT_DEBOUNCE_MS, CACHE_TTL, COPY_HINT_MS, DEFAULT_PAGE_SIZE, MAIL_READ_HISTORY_MAX, NEW_MAIL_FLASH_MS, STORAGE_KEYS } from '../lib/constants';
import { cls, formatShortDate, normalizeSearch } from '../lib/format';
import { getRuntimeLocale, localeText } from '../lib/locale';
import { copyText } from '../lib/clipboard';
import { readJsonStorage, readStorage, writeJsonStorage, writeLocalStorage } from '../lib/storage';
import { buildMailHtmlDocument, getDownloadEmlUrl, looksLikeMimeSource, parseRawMail, parseRawMailListItem, parseSendbox, sanitizeMailHtml, sanitizeVerificationCode } from '../lib/mailParser';
import type { ComposePayload, ListResponse, ParsedMail, ParsedSendbox, RawMailRecord, SendboxRecord } from '../types/api';
import { EmptyState, LoadingState, type Notify, useConfirm } from '../components/Common';
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
type RemoteMailState = {
  mode?: MailMode;
  readIds?: string[];
  starredIds?: string[];
  readAllBefore?: Record<string, number>;
  updatedAt?: number;
};
type MailboxAddressRequest = { address: string; requestId: number };
type FetchOptions = { addressOverride?: string; pageOverride?: number; forceRefresh?: boolean };
type TranslateFn = (zh: string, en: string) => string;
type PullRefreshLock = 'none' | 'pull' | 'scroll';
type MailStateStorageKeys = { readIds: string; readAllBefore: string; starredIds: string };
type PressPoint = { x: number; y: number };
type MobileMailChromePaddingVars = CSSProperties & {
  '--mobile-mail-viewport-top-pad': string;
  '--mobile-mail-viewport-bottom-pad': string;
};

const MAIL_LIST_CACHE_VERSION = 4;
const MAIL_SEARCH_INDEX_PAGE_SIZE = 240;
const MAIL_SEARCH_INDEX_MAX_PAGES = 240;
const MAIL_STATE_CHANGED_EVENT = 'loven7-mail-state-changed';
const PULL_REFRESH_TRIGGER = 52;
const PULL_REFRESH_MAX_OFFSET = 86;
const MOBILE_MAIL_CHROME_COLLAPSE_TRAVEL = 360;
const MOBILE_MAIL_CHROME_EXPAND_TRAVEL = 320;
const MOBILE_MAIL_CHROME_SETTLE_DELAY = 220;
const RECIPIENT_COPY_DRAG_TOLERANCE = 8;
const isParsed = (mail: AnyMail): mail is ParsedMail => typeof (mail as ParsedMail).senderAddress === 'string';
const mailStateMode = (mode: MailMode): MailMode => (mode === 'unknown' ? 'inbox' : mode);
const storageId = (mode: MailMode, id: number) => `${mailStateMode(mode)}:${id}`;

function stateIdCandidates(mode: MailMode, id: number) {
  const primary = storageId(mode, id);
  if (mailStateMode(mode) !== 'inbox') return [primary];
  return [primary, `unknown:${id}`];
}

function hasMailStateId(ids: Set<string>, mode: MailMode, id: number) {
  return stateIdCandidates(mode, id).some((key) => ids.has(key));
}

function deleteMailStateId(ids: Set<string>, mode: MailMode, id: number) {
  stateIdCandidates(mode, id).forEach((key) => ids.delete(key));
}

function isCompactMailViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px), (hover: none) and (pointer: coarse)').matches;
}

function clampMailChromeProgress(progress: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
}

function easeOutQuart(progress: number): number {
  return 1 - (1 - progress) ** 4;
}

function getMobileMailChromePaddingVars(progress: number): MobileMailChromePaddingVars {
  const clamped = clampMailChromeProgress(progress);
  const expandedTop = 96;
  const collapsedTop = expandedTop;
  const expandedBottom = 74;
  const collapsedBottom = expandedBottom;
  const top = expandedTop + (collapsedTop - expandedTop) * clamped;
  const bottom = expandedBottom + (collapsedBottom - expandedBottom) * clamped;
  return {
    '--mobile-mail-viewport-top-pad': `${top.toFixed(2)}px`,
    '--mobile-mail-viewport-bottom-pad': `${bottom.toFixed(2)}px`,
  } as MobileMailChromePaddingVars;
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

function isBlockedPullRefreshTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return Boolean(target.closest('input, textarea, select, button, a, iframe, .mail-filter-menu, .modal-card, .mobile-mail-detail, [data-no-page-swipe="true"]'));
}

function isIntentionalRecipientCopyClick(press: PressPoint | null, event: MouseEvent<HTMLButtonElement>): boolean {
  if (!press) return true;
  return Math.hypot(event.clientX - press.x, event.clientY - press.y) <= RECIPIENT_COPY_DRAG_TOLERANCE;
}

function getRecipient(mail: AnyMail): string {
  if (isParsed(mail)) return mail.address || mail.to || '';
  return mail.to_mail || '';
}

const EMAIL_IN_TEXT_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const EXACT_EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/iu;

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

function getExactMailboxSearch(value: string): string {
  const trimmed = value.trim();
  return EXACT_EMAIL_RE.test(trimmed) ? trimmed : '';
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
  const bodyText = isParsed(mail)
    ? `${mail.to || ''} ${mail.address || ''} ${mail.text || ''}`
    : `${mail.address || ''} ${mail.from_mail || ''} ${mail.to_mail || ''} ${mail.content || ''}`;
  const value = normalizeSearch(`${getSender(mail)} ${getSenderAddress(mail)} ${getRecipient(mail)} ${mail.subject} ${mail.preview} ${bodyText}`);
  searchTextCache.set(mail, value);
  return value;
}

function getAddressSearchText(mail: AnyMail): string {
  return getSearchText(mail);
}

function compareMailForSearch(a: AnyMail, b: AnyMail): number {
  const aTime = Number(new Date((a as any).created_at || 0)) || 0;
  const bTime = Number(new Date((b as any).created_at || 0)) || 0;
  if (aTime !== bTime) return bTime - aTime;
  return Number(b.id) - Number(a.id);
}

function mergeMailLists(primary: AnyMail[], secondary: AnyMail[]): AnyMail[] {
  const seen = new Set<number>();
  const merged: AnyMail[] = [];
  for (const item of [...primary, ...secondary]) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged.sort(compareMailForSearch);
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
    const readByBulk = mail.id <= readAllBeforeValue(readAllBefore, mode);
    return { ...mail, isUnread: !(hasMailStateId(readIds, mode, mail.id) || readByBulk), isStarred: hasMailStateId(starredIds, mode, mail.id) };
  });
}

function mailStateStorageKey(baseKey: string, scope: string): string {
  return `${baseKey}.${scope || 'default'}`;
}

function getMailStateStorageKeys(scope: string): MailStateStorageKeys {
  return {
    readIds: mailStateStorageKey(STORAGE_KEYS.mailReadIds, scope),
    readAllBefore: mailStateStorageKey(STORAGE_KEYS.mailReadAllBefore, scope),
    starredIds: mailStateStorageKey(STORAGE_KEYS.mailStarredIds, scope),
  };
}

function readMailState(keys: MailStateStorageKeys) {
  return {
    readIds: new Set(readJsonStorage<string[]>(keys.readIds, [])),
    readAllBefore: readJsonStorage<Record<string, number>>(keys.readAllBefore, {}),
    starredIds: new Set(readJsonStorage<string[]>(keys.starredIds, [])),
  };
}

function notifyMailStateChanged(keys: MailStateStorageKeys) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MAIL_STATE_CHANGED_EVENT, {
    detail: { readIdsKey: keys.readIds, readAllBeforeKey: keys.readAllBefore, starredIdsKey: keys.starredIds },
  }));
}

function isSameMailStateScope(detail: unknown, keys: MailStateStorageKeys) {
  const record = detail && typeof detail === 'object' ? detail as Partial<Record<'readIdsKey' | 'readAllBeforeKey' | 'starredIdsKey', unknown>> : {};
  return record.readIdsKey === keys.readIds
    && record.readAllBeforeKey === keys.readAllBefore
    && record.starredIdsKey === keys.starredIds;
}

function mergeSets<T>(left: Set<T>, right: Iterable<T>) {
  const next = new Set(left);
  for (const item of right) next.add(item);
  return next;
}

function readAllBeforeValue(value: Record<string, number>, mode: MailMode) {
  const primary = mailStateMode(mode);
  const legacyInbound = primary === 'inbox' ? Number(value.unknown || 0) || 0 : 0;
  return Math.max(0, Number(value[primary] || 0) || 0, legacyInbound);
}

function withReadAllBeforeValue(value: Record<string, number>, mode: MailMode, nextValue: number) {
  const primary = mailStateMode(mode);
  const next = { ...value, [primary]: Math.max(0, Number(nextValue || 0) || 0) };
  if (primary === 'inbox') next.unknown = next[primary];
  return next;
}

function normalizeRemoteIds(ids: string[] | undefined, mode: MailMode) {
  return new Set((ids || []).map((id) => {
    const numeric = Number(String(id).split(':').pop() || 0);
    return Number.isInteger(numeric) && numeric > 0 ? storageId(mode, numeric) : '';
  }).filter(Boolean));
}

function normalizeRemoteMailState(remote: RemoteMailState | null | undefined, mode: MailMode) {
  return {
    readIds: normalizeRemoteIds(remote?.readIds, mode),
    starredIds: normalizeRemoteIds(remote?.starredIds, mode),
    readAllBefore: readAllBeforeValue(remote?.readAllBefore || {}, mode),
  };
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

export function MailWorkspace({ mode, active, visualActive = active, request, notify, ask, globalQuery, addressRequest, setActiveMenu, setComposeSeed, mailStateScope, theme = 'light' }: { mode: MailMode; active: boolean; visualActive?: boolean; request: Requester; notify: Notify; ask: ReturnType<typeof useConfirm>['ask']; globalQuery: string; addressRequest?: MailboxAddressRequest | null; setActiveMenu: (menu: MenuKey) => void; setComposeSeed: (seed: Partial<ComposePayload>) => void; mailStateScope: string; theme?: 'light' | 'dark' }) {
  const [mails, setMails] = useState<AnyMail[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(DEFAULT_PAGE_SIZE);
  const [count, setCount] = useState(0);
  const [mobileLoadedPages, setMobileLoadedPages] = useState(1);
  const [mobileLoadingMore, setMobileLoadingMore] = useState(false);
  const [mailListExhausted, setMailListExhausted] = useState(false);
  const [searchIndex, setSearchIndex] = useState<AnyMail[]>([]);
  const [searchIndexLoading, setSearchIndexLoading] = useState(false);
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
  const [detailClosed, setDetailClosed] = useState(false);
  const [pullRefreshOffset, setPullRefreshOffset] = useState(0);
  const [pullRefreshLabel, setPullRefreshLabel] = useState('');
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const mailStateKeys = useMemo(() => getMailStateStorageKeys(mailStateScope), [mailStateScope]);
  const [readIds, setReadIds] = useState<Set<string>>(() => readMailState(mailStateKeys).readIds);
  const [readAllBefore, setReadAllBefore] = useState<Record<string, number>>(() => readMailState(mailStateKeys).readAllBefore);
  const [starredIds, setStarredIds] = useState<Set<string>>(() => readMailState(mailStateKeys).starredIds);
  const [remoteStateReady, setRemoteStateReady] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoSeconds, setAutoSeconds] = useState(60);
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
  const mobileLoadMoreInFlightRef = useRef(false);
  const mobileLoadMoreRafRef = useRef<number | null>(null);
  const mobileListContextRef = useRef('');
  const mobileLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const mailWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const mailListPanelRef = useRef<HTMLDivElement | null>(null);
  const mailListViewportRef = useRef<HTMLDivElement | null>(null);
  const mobileChromeRef = useRef({ collapsed: false, lastScrollTop: 0, progress: 0 });
  const mobileChromeRafRef = useRef<number | null>(null);
  const mobileChromeSettleRafRef = useRef<number | null>(null);
  const mobileChromeSettleTimerRef = useRef<number | null>(null);
  const mobileChromePendingRef = useRef(0);
  const ownsMobileChromeRef = useRef(false);
  const searchIndexSeqRef = useRef(0);
  const searchIndexAbortRef = useRef<AbortController | null>(null);
  const searchIndexKeyRef = useRef('');
  const searchIndexCompleteRef = useRef(false);
  const searchIndexLoadingRef = useRef(false);
  const newIdsTimerRef = useRef<number | null>(null);
  const mobileDetailHistoryRef = useRef(false);
  const attachmentUrlsRef = useRef<Set<string>>(new Set());
  const mailSwipeRef = useRef<{ active: boolean; startX: number; startY: number; lastX: number; lastY: number }>({ active: false, startX: 0, startY: 0, lastX: 0, lastY: 0 });
  const pullRefreshRef = useRef({ active: false, pulling: false, lock: 'none' as PullRefreshLock, startX: 0, startY: 0, offset: 0 });
  const pullRefreshRafRef = useRef<number | null>(null);
  const pullRefreshResetTimerRef = useRef<number | null>(null);
  const pullRefreshVisualRef = useRef({ offset: 0, label: '' });
  const searchQuery = normalizeSearch(globalQuery);
  const deferredQuery = useDeferredValue(searchQuery);
  const mailSearchQuery = normalizeSearch(addressInput);
  const deferredAddressQuery = useDeferredValue(mailSearchQuery);
  const isSearchMode = Boolean(deferredQuery || deferredAddressQuery);
  const mobileListContext = useMemo(() => `${mode}|${pageSize}|${address.trim()}|${isSearchMode ? 'search' : 'list'}`, [address, isSearchMode, mode, pageSize]);
  const locale = getRuntimeLocale();
  const t: TranslateFn = (zh, en) => localeText(zh, en, locale);
  const title = mode === 'sent' ? t('发件箱', 'Sent') : mode === 'unknown' ? t('未知邮件', 'Unknown mail') : t('收件箱', 'Inbox');
  const immersiveMobileMail = mode === 'inbox' || mode === 'sent';
  const ownsMobileChrome = visualActive && immersiveMobileMail && compactViewport && !isMobileDetail;
  const currentListCacheKey = useMemo(() => mailListCacheKey(mode, page, pageSize, address), [address, mode, page, pageSize]);

  useEffect(() => {
    mobileListContextRef.current = mobileListContext;
    mobileLoadMoreSeqRef.current += 1;
    mobileLoadMoreInFlightRef.current = false;
    setMobileLoadingMore(false);
  }, [mobileListContext]);

  useEffect(() => {
    ownsMobileChromeRef.current = ownsMobileChrome;
  }, [ownsMobileChrome]);

  useEffect(() => {
    setFilterMenuOpen(false);
  }, [activeTab, mode]);
  useEffect(() => {
    setExpandedMailStacks(new Set());
  }, [activeTab, address, searchQuery, mode, page]);
  useEffect(() => {
    const next = readMailState(mailStateKeys);
    setReadIds(next.readIds);
    setReadAllBefore(next.readAllBefore);
    setStarredIds(next.starredIds);
    setRemoteStateReady(false);
    let cancelled = false;
    request<RemoteMailState>(`/api/mail-state${buildQuery({ mode })}`, {
      forceRefresh: true,
      skipCache: true,
      timeoutMs: 6500,
    })
      .then((remote) => {
        if (cancelled) return;
        const remoteState = normalizeRemoteMailState(remote, mode);
        const mergedReadIds = mergeSets(next.readIds, remoteState.readIds);
        const mergedStarredIds = mergeSets(next.starredIds, remoteState.starredIds);
        const mergedReadAllBefore = Math.max(readAllBeforeValue(next.readAllBefore, mode), remoteState.readAllBefore);
        const mergedReadAllBeforeRecord = withReadAllBeforeValue(next.readAllBefore, mode, mergedReadAllBefore);

        setReadIds(mergedReadIds);
        setStarredIds(mergedStarredIds);
        setReadAllBefore(mergedReadAllBeforeRecord);
        writeJsonStorage(mailStateKeys.readIds, [...mergedReadIds].slice(-MAIL_READ_HISTORY_MAX));
        writeJsonStorage(mailStateKeys.starredIds, [...mergedStarredIds].slice(-MAIL_READ_HISTORY_MAX));
        writeJsonStorage(mailStateKeys.readAllBefore, mergedReadAllBeforeRecord);
        notifyMailStateChanged(mailStateKeys);

        const localHasExtraRead = [...next.readIds].some((id) => !remoteState.readIds.has(id));
        const localHasExtraStar = [...next.starredIds].some((id) => !remoteState.starredIds.has(id));
        const localHasNewerBulk = readAllBeforeValue(next.readAllBefore, mode) > remoteState.readAllBefore;
        if (localHasExtraRead || localHasExtraStar || localHasNewerBulk) {
          void request<RemoteMailState>('/api/mail-state', {
            method: 'PATCH',
            body: {
              mode,
              readIds: [...mergedReadIds],
              starredIds: [...mergedStarredIds],
              readAllBefore: mergedReadAllBefore,
            },
            timeoutMs: 6500,
            invalidates: ['/api/mail-state'],
          }).catch((error) => console.warn('mail state backfill failed', error));
        }
      })
      .catch((error) => {
        console.warn('mail state sync failed', error);
      })
      .finally(() => {
        if (!cancelled) setRemoteStateReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mailStateKeys, mode, request]);

  const persistReadIds = useCallback((next: Set<string>) => {
    setReadIds(new Set(next));
    writeJsonStorage(mailStateKeys.readIds, [...next].slice(-MAIL_READ_HISTORY_MAX));
    notifyMailStateChanged(mailStateKeys);
  }, [mailStateKeys]);
  const persistReadAllBefore = useCallback((next: Record<string, number>) => {
    setReadAllBefore(next);
    writeJsonStorage(mailStateKeys.readAllBefore, next);
    notifyMailStateChanged(mailStateKeys);
  }, [mailStateKeys]);
  const persistStarredIds = useCallback((next: Set<string>) => {
    setStarredIds(new Set(next));
    writeJsonStorage(mailStateKeys.starredIds, [...next].slice(-MAIL_READ_HISTORY_MAX));
    notifyMailStateChanged(mailStateKeys);
  }, [mailStateKeys]);
  const patchRemoteMailState = useCallback((body: Record<string, unknown>) => {
    void request<RemoteMailState>('/api/mail-state', {
      method: 'PATCH',
      body: { mode, ...body },
      timeoutMs: 6500,
      invalidates: ['/api/mail-state'],
    }).catch((error) => console.warn('mail state persist failed', error));
  }, [mode, request]);
  useEffect(() => {
    const onMailStateChanged = (event: Event) => {
      if (!isSameMailStateScope((event as CustomEvent).detail, mailStateKeys)) return;
      const next = readMailState(mailStateKeys);
      setReadIds(next.readIds);
      setReadAllBefore(next.readAllBefore);
      setStarredIds(next.starredIds);
    };
    window.addEventListener(MAIL_STATE_CHANGED_EVENT, onMailStateChanged);
    return () => window.removeEventListener(MAIL_STATE_CHANGED_EVENT, onMailStateChanged);
  }, [mailStateKeys]);

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
    setMailListExhausted(cached.items.length < pageSize);
    return true;
  }, [mode, pageSize, readAllBefore, readIds, starredIds]);

  const loadPage = useCallback(async (offset: number, forceRefresh = false, targetAddress = address, signal?: AbortSignal, limitOverride = pageSize) => {
    const normalizedAddress = targetAddress.trim();
    if (mode === 'sent') {
      const res = await request<ListResponse<SendboxRecord>>(`/admin/sendbox${buildQuery({ limit: limitOverride, offset, address: normalizedAddress })}`, { forceRefresh, signal, cacheTtlMs: CACHE_TTL.shortList });
      return { results: (res.results || []).map(parseSendbox), count: res.count };
    }
    const endpoint = mode === 'unknown' ? '/admin/mails_unknow' : '/admin/mails';
    const res = await request<ListResponse<RawMailRecord>>(`${endpoint}${buildQuery({ limit: limitOverride, offset, address: mode === 'inbox' ? normalizedAddress : '' })}`, { forceRefresh, signal, cacheTtlMs: CACHE_TTL.shortList });
    return { results: (res.results || []).map(parseRawMailListItem), count: res.count };
  }, [mode, pageSize, request]);

  const loadSearchIndexPage = useCallback(async (offset: number, signal?: AbortSignal, targetAddress = '') => {
    return loadPage(offset, false, targetAddress, signal, MAIL_SEARCH_INDEX_PAGE_SIZE);
  }, [loadPage]);

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
      const reportedCount = typeof totalCount === 'number' ? totalCount : 0;
      const nextCount = Math.max(reportedCount, parsed.length, incremental ? currentMails.length : 0);
      setCount(nextCount);

      if (incremental && targetPage !== 1) {
        const addedCount = Math.max(0, nextCount - latestCountRef.current);
        if (addedCount > 0) notify('info', locale === 'en-US' ? `${addedCount} new message${addedCount === 1 ? '' : 's'} detected. Return to page 1 to view.` : `检测到 ${addedCount} 封新邮件，回到第一页可查看`);
        return;
      }

      if (!incremental) {
        setMobileLoadedPages(Math.max(1, targetPage));
        setMailListExhausted(parsed.length < pageSize);
      }

      if (incremental && currentMails.length > 0) {
        const existing = new Set(currentMails.map((mail) => mail.id));
        const added = parsed.filter((mail) => !existing.has(mail.id));
        const merged = mergeMailLists(parsed, currentMails);
        setMails(merged);
        const mergedCount = Math.max(nextCount, merged.length);
        setCount(mergedCount);
        saveListCache(merged, mergedCount, mailListCacheKey(mode, targetPage, pageSize, targetAddress));
        if (added.length) {
          setNewIds(new Set(added.map((mail) => mail.id)));
          if (newIdsTimerRef.current !== null) window.clearTimeout(newIdsTimerRef.current);
          newIdsTimerRef.current = window.setTimeout(() => { setNewIds(new Set()); newIdsTimerRef.current = null; }, NEW_MAIL_FLASH_MS);
          notify('success', locale === 'en-US' ? `${added.length} new message${added.length === 1 ? '' : 's'}` : `新增 ${added.length} 封邮件`);
        }
      } else {
        setMails(parsed);
        saveListCache(parsed, nextCount, mailListCacheKey(mode, targetPage, pageSize, targetAddress));
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (seq === fetchSeqRef.current) notify('error', error instanceof Error ? error.message : t('邮件加载失败', 'Failed to load mail'));
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
        setRefreshing(false);
        setRefreshCountdown(Math.max(15, autoSeconds));
        fetchInFlightRef.current = false;
        if (fetchAbortRef.current === abortController) fetchAbortRef.current = null;
      }
    }
  }, [address, autoSeconds, loadPage, locale, mode, notify, page, pageSize, readAllBefore, readIds, saveListCache, starredIds, t]);

  const loadSearchIndex = useCallback(async (forceRefresh = false) => {
    const normalizedAddress = address.trim();
    const normalizedAddressQuery = normalizeSearch(normalizedAddress);
    const shouldUseExactAddressIndex = mode !== 'unknown' && normalizedAddress.includes('@') && deferredAddressQuery === normalizedAddressQuery;
    const targetAddress = shouldUseExactAddressIndex ? normalizedAddress : '';
    const indexKey = `${mode}|${targetAddress}`;
    if (searchIndexKeyRef.current === indexKey && searchIndexCompleteRef.current && !forceRefresh) return;
    if (searchIndexKeyRef.current === indexKey && searchIndexLoadingRef.current && !forceRefresh) return;
    if (searchIndexKeyRef.current !== indexKey) {
      setSearchIndex(mergeMailLists(mails, []));
    }
    searchIndexKeyRef.current = indexKey;
    searchIndexCompleteRef.current = false;
    searchIndexAbortRef.current?.abort();
    const abortController = new AbortController();
    searchIndexAbortRef.current = abortController;
    const seq = ++searchIndexSeqRef.current;
    searchIndexLoadingRef.current = true;
    setSearchIndexLoading(true);
    try {
      const collected: AnyMail[] = [];
      let offset = 0;
      for (let index = 0; index < MAIL_SEARCH_INDEX_MAX_PAGES; index += 1) {
        if (abortController.signal.aborted || seq !== searchIndexSeqRef.current) return;
        const { results } = await loadSearchIndexPage(offset, abortController.signal, targetAddress);
        if (abortController.signal.aborted || seq !== searchIndexSeqRef.current) return;
        if (!results.length) break;
        const parsed = applyLocalState(results, mode, readIds, starredIds, readAllBefore);
        collected.push(...parsed);
        setSearchIndex((current) => mergeMailLists(current, parsed));
        offset += results.length;
      }
      if (seq === searchIndexSeqRef.current) {
        setSearchIndex((current) => mergeMailLists(current, collected));
        searchIndexCompleteRef.current = true;
      }
    } catch (error) {
      if (!abortController.signal.aborted) console.warn('mail search index load failed', error);
    } finally {
      if (seq === searchIndexSeqRef.current) {
        searchIndexLoadingRef.current = false;
        setSearchIndexLoading(false);
      }
    }
  }, [address, deferredAddressQuery, loadSearchIndexPage, mails, mode, readAllBefore, readIds, starredIds]);

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
    setSearchIndex((current) => mergeMailLists(current, mails));
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
    searchIndexAbortRef.current?.abort();
    if (pullRefreshRafRef.current !== null) window.cancelAnimationFrame(pullRefreshRafRef.current);
    if (pullRefreshResetTimerRef.current !== null) window.clearTimeout(pullRefreshResetTimerRef.current);
    if (mobileLoadMoreRafRef.current !== null) window.cancelAnimationFrame(mobileLoadMoreRafRef.current);
    attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    attachmentUrlsRef.current.clear();
  }, []);
  useEffect(() => {
    latestCountRef.current = count;
  }, [count]);
  useEffect(() => {
    const nextAddress = getExactMailboxSearch(addressInput);
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
    if (!remoteStateReady) return;
    const cached = readJsonStorage<MailListCache | null>(currentListCacheKey, null);
    if (!cached || cached.version !== MAIL_LIST_CACHE_VERSION || !Array.isArray(cached.items)) return;
    setMails(applyLocalState(cached.items, mode, readIds, starredIds, readAllBefore));
    setCount(cached.count || cached.items.length);
    setMailListExhausted(cached.items.length < pageSize);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentListCacheKey, mode, remoteStateReady]);
  useEffect(() => {
    if (!remoteStateReady) return;
    if (suppressNextFetchRef.current) {
      suppressNextFetchRef.current = false;
      return;
    }
    fetchData(false);
  }, [mode, page, pageSize, address, remoteStateReady]);
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
    if (!active) return;
    setAutoRefresh(readStorage(STORAGE_KEYS.mailAutoRefreshEnabled, 'true') !== 'false');
    setAutoSeconds(Math.max(15, Number(readStorage(STORAGE_KEYS.mailAutoRefreshSeconds, '60')) || 60));
  }, [active]);
  useEffect(() => {
    const onGlobalRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ menu?: string; source?: string }>).detail || {};
      const targetMenu = detail.menu;
      if (targetMenu === mode && detail.source === 'repeat-menu-click' && compactViewport) {
        setIsMobileDetail(false);
        setMobileDetailDragX(0);
        setDetailClosed(false);
        mobileDetailHistoryRef.current = false;
        const viewport = mailListViewportRef.current;
        if (viewport) {
          viewport.scrollTo({ top: 0, behavior: 'auto' });
          mobileChromeRef.current.lastScrollTop = 0;
        }
        return;
      }
      if (!targetMenu || targetMenu === mode) fetchData(true);
    };
    window.addEventListener('loven7-global-refresh', onGlobalRefresh);
    return () => window.removeEventListener('loven7-global-refresh', onGlobalRefresh);
  }, [compactViewport, fetchData, mode]);
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
    if (active && mails.length > 0 && !loading && !refreshing && !isSearchMode) fetchData(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, isSearchMode]);
  useEffect(() => {
    if (!active) return;
    if (!searchQuery && !deferredAddressQuery) {
      searchIndexCompleteRef.current = false;
      setSearchIndex((current) => mergeMailLists(current, mails));
      return;
    }
    if (compactViewport && !mails.length && !loading) return;
    void loadSearchIndex(false);
  }, [active, compactViewport, deferredAddressQuery, loadSearchIndex, loading, mails, searchQuery]);
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

  const setMobileMailChromeProgress = useCallback((progress: number, immediate = false) => {
    if (typeof document === 'undefined') return;
    const next = clampMailChromeProgress(progress);
    const collapsed = next >= 0.92;
    mobileChromeRef.current.progress = next;
    mobileChromeRef.current.collapsed = collapsed;
    mobileChromePendingRef.current = next;
    const applyProgress = () => {
      mobileChromeRafRef.current = null;
      const current = mobileChromePendingRef.current;
      const value = current.toFixed(3);
      const locallyCollapsed = current >= 0.92;
      const root = mailWorkspaceRef.current;
      root?.style.setProperty('--mobile-mail-chrome-progress', value);
      const paddingVars = getMobileMailChromePaddingVars(current);
      root?.style.setProperty('--mobile-mail-viewport-top-pad', String(paddingVars['--mobile-mail-viewport-top-pad']));
      root?.style.setProperty('--mobile-mail-viewport-bottom-pad', String(paddingVars['--mobile-mail-viewport-bottom-pad']));
      root?.classList.toggle('mobile-mail-chrome-collapsed-local', locallyCollapsed);
      document.documentElement.style.setProperty('--mobile-mail-preserved-chrome-progress', value);
      if (mode === 'inbox' || mode === 'sent') {
        document.documentElement.style.setProperty(`--mobile-mail-preserved-chrome-progress-${mode}`, value);
      }
      if (ownsMobileChromeRef.current) {
        document.body.style.setProperty('--mobile-mail-chrome-progress', value);
        document.body.classList.toggle('mobile-mail-chrome-collapsed', locallyCollapsed);
      }
    };
    if (immediate) {
      if (mobileChromeRafRef.current !== null) {
        window.cancelAnimationFrame(mobileChromeRafRef.current);
        mobileChromeRafRef.current = null;
      }
      applyProgress();
      return;
    }
    if (mobileChromeRafRef.current === null) {
      mobileChromeRafRef.current = window.requestAnimationFrame(applyProgress);
    }
  }, [mode]);

  const animateMobileMailChromeProgress = useCallback((target: number, duration = 190) => {
    if (typeof window === 'undefined') return;
    if (mobileChromeSettleRafRef.current !== null) {
      window.cancelAnimationFrame(mobileChromeSettleRafRef.current);
      mobileChromeSettleRafRef.current = null;
    }
    const from = mobileChromeRef.current.progress;
    const to = clampMailChromeProgress(target);
    if (Math.abs(to - from) < 0.012) {
      setMobileMailChromeProgress(to, true);
      return;
    }
    const start = window.performance.now();
    const tick = (now: number) => {
      const elapsed = Math.min(1, (now - start) / Math.max(duration, 1));
      const eased = easeOutQuart(elapsed);
      setMobileMailChromeProgress(from + (to - from) * eased, true);
      if (elapsed < 1) {
        mobileChromeSettleRafRef.current = window.requestAnimationFrame(tick);
      } else {
        mobileChromeSettleRafRef.current = null;
      }
    };
    mobileChromeSettleRafRef.current = window.requestAnimationFrame(tick);
  }, [setMobileMailChromeProgress]);

  useEffect(() => () => {
    if (mobileChromeRafRef.current !== null) window.cancelAnimationFrame(mobileChromeRafRef.current);
    if (mobileChromeSettleRafRef.current !== null) window.cancelAnimationFrame(mobileChromeSettleRafRef.current);
    if (mobileChromeSettleTimerRef.current !== null) window.clearTimeout(mobileChromeSettleTimerRef.current);
    if (ownsMobileChromeRef.current) {
      document.body.style.setProperty('--mobile-mail-chrome-progress', '0');
      document.body.classList.remove('mobile-mail-chrome-collapsed');
    }
  }, []);

  useEffect(() => {
    if (!immersiveMobileMail || !compactViewport || isMobileDetail) {
      setMobileMailChromeProgress(0, true);
      return undefined;
    }
    if (visualActive) setMobileMailChromeProgress(mobileChromeRef.current.progress, true);
    return undefined;
  }, [compactViewport, immersiveMobileMail, isMobileDetail, setMobileMailChromeProgress, visualActive]);

  const settleMobileMailChromeAfterScroll = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (mobileChromeSettleTimerRef.current !== null) window.clearTimeout(mobileChromeSettleTimerRef.current);
    mobileChromeSettleTimerRef.current = window.setTimeout(() => {
      mobileChromeSettleTimerRef.current = null;
      const current = mobileChromeRef.current.progress;
      if (current <= 0.18) animateMobileMailChromeProgress(0, 240);
      else if (current >= 0.82) animateMobileMailChromeProgress(1, 280);
    }, MOBILE_MAIL_CHROME_SETTLE_DELAY);
  }, [animateMobileMailChromeProgress]);

  const cancelMobileMailChromeSettle = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (mobileChromeSettleTimerRef.current !== null) {
      window.clearTimeout(mobileChromeSettleTimerRef.current);
      mobileChromeSettleTimerRef.current = null;
    }
    if (mobileChromeSettleRafRef.current !== null) {
      window.cancelAnimationFrame(mobileChromeSettleRafRef.current);
      mobileChromeSettleRafRef.current = null;
    }
  }, []);

  const handleMailListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (!active || !immersiveMobileMail || !compactViewport || isMobileDetail) return;
    cancelMobileMailChromeSettle();
    const scrollTop = event.currentTarget.scrollTop;
    const previous = mobileChromeRef.current.lastScrollTop;
    const delta = scrollTop - previous;
    mobileChromeRef.current.lastScrollTop = Math.max(0, scrollTop);
    if (scrollTop <= 10) {
      if (mobileChromeRef.current.progress !== 0) setMobileMailChromeProgress(0);
      return;
    }
    if (Math.abs(delta) < 0.75) return;
    const travel = delta > 0 ? MOBILE_MAIL_CHROME_COLLAPSE_TRAVEL : MOBILE_MAIL_CHROME_EXPAND_TRAVEL;
    const nextProgress = mobileChromeRef.current.progress + (delta / travel);
    setMobileMailChromeProgress(mobileChromeRef.current.progress + (nextProgress - mobileChromeRef.current.progress) * 0.72);
    settleMobileMailChromeAfterScroll();
  }, [active, cancelMobileMailChromeSettle, compactViewport, immersiveMobileMail, isMobileDetail, setMobileMailChromeProgress, settleMobileMailChromeAfterScroll]);

  const setPullRefreshVisual = useCallback((offset: number, label: string) => {
    pullRefreshVisualRef.current = { offset, label };
    if (pullRefreshRafRef.current !== null) return;
    pullRefreshRafRef.current = window.requestAnimationFrame(() => {
      pullRefreshRafRef.current = null;
      const next = pullRefreshVisualRef.current;
      setPullRefreshOffset(next.offset);
      setPullRefreshLabel(next.label);
    });
  }, []);

  const resetPullRefresh = useCallback((delay = 120) => {
    if (pullRefreshResetTimerRef.current !== null) window.clearTimeout(pullRefreshResetTimerRef.current);
    pullRefreshResetTimerRef.current = window.setTimeout(() => {
      pullRefreshResetTimerRef.current = null;
      pullRefreshRef.current = { active: false, pulling: false, lock: 'none', startX: 0, startY: 0, offset: 0 };
      setPullRefreshVisual(0, '');
    }, delay);
  }, [setPullRefreshVisual]);

  const runPullRefresh = useCallback(async () => {
    if (loading || refreshing || fetchInFlightRef.current) {
      resetPullRefresh();
      return;
    }
    setPullRefreshVisual(54, t('正在刷新…', 'Refreshing...'));
    if (page !== 1) {
      suppressNextFetchRef.current = true;
      setPage(1);
    }
    try {
      await fetchData(true, { pageOverride: 1, forceRefresh: true });
    } finally {
      resetPullRefresh(220);
    }
  }, [fetchData, loading, page, refreshing, resetPullRefresh, setPullRefreshVisual, t]);

  const handlePullRefreshStart = useCallback((event: globalThis.TouchEvent) => {
    if (!active || !compactViewport || isMobileDetail || event.touches.length !== 1) return;
    if (loading || refreshing || isBlockedPullRefreshTarget(event.target)) return;
    if (pullRefreshResetTimerRef.current !== null) {
      window.clearTimeout(pullRefreshResetTimerRef.current);
      pullRefreshResetTimerRef.current = null;
    }
    const panel = mailListPanelRef.current;
    const target = event.target;
    if (!panel || !(target instanceof Node) || !panel.contains(target)) return;
    const viewport = mailListViewportRef.current;
    if (!viewport || viewport.scrollTop > 2) {
      pullRefreshRef.current = { active: false, pulling: false, lock: 'none', startX: 0, startY: 0, offset: 0 };
      return;
    }
    const touch = event.touches[0];
    pullRefreshRef.current = { active: true, pulling: false, lock: 'none', startX: touch.clientX, startY: touch.clientY, offset: 0 };
  }, [active, compactViewport, isMobileDetail, loading, refreshing]);

  const handlePullRefreshMove = useCallback((event: globalThis.TouchEvent) => {
    const state = pullRefreshRef.current;
    if (!state.active || event.touches.length !== 1 || loading || refreshing) return;
    const viewport = mailListViewportRef.current;
    if (!viewport) return;
    const touch = event.touches[0];
    const dy = touch.clientY - state.startY;
    const dx = Math.abs(touch.clientX - state.startX);
    if (state.lock === 'none' && viewport.scrollTop > 2) {
      state.lock = 'scroll';
    }
    if (state.lock === 'none' && (Math.abs(dy) > 6 || dx > 6)) {
      state.lock = dy > 0 && dy > dx * 1.05 ? 'pull' : 'scroll';
    }
    if (state.lock !== 'pull' || dy <= 0) return;
    event.preventDefault();
    const offset = Math.min(PULL_REFRESH_MAX_OFFSET, Math.max(0, dy - 4) * .7);
    state.pulling = true;
    state.offset = offset;
    setPullRefreshVisual(offset, offset >= PULL_REFRESH_TRIGGER ? t('松开刷新', 'Release to refresh') : t('下拉刷新', 'Pull to refresh'));
  }, [loading, refreshing, setPullRefreshVisual, t]);

  const handlePullRefreshEnd = useCallback(() => {
    const state = pullRefreshRef.current;
    if (!state.active) return;
    if (state.pulling && state.offset >= PULL_REFRESH_TRIGGER) {
      void runPullRefresh();
      return;
    }
    resetPullRefresh(0);
  }, [resetPullRefresh, runPullRefresh]);

  useEffect(() => {
    if (!active || !compactViewport || isMobileDetail) return undefined;
    document.addEventListener('touchstart', handlePullRefreshStart, { capture: true, passive: true });
    document.addEventListener('touchmove', handlePullRefreshMove, { capture: true, passive: false });
    document.addEventListener('touchend', handlePullRefreshEnd, { capture: true, passive: true });
    document.addEventListener('touchcancel', handlePullRefreshEnd, { capture: true, passive: true });
    return () => {
      document.removeEventListener('touchstart', handlePullRefreshStart, { capture: true });
      document.removeEventListener('touchmove', handlePullRefreshMove, { capture: true });
      document.removeEventListener('touchend', handlePullRefreshEnd, { capture: true });
      document.removeEventListener('touchcancel', handlePullRefreshEnd, { capture: true });
    };
  }, [active, compactViewport, handlePullRefreshEnd, handlePullRefreshMove, handlePullRefreshStart, isMobileDetail]);

  useEffect(() => {
    if (!active || !compactViewport || !mailListViewportRef.current) return;
    const viewport = mailListViewportRef.current;
    if (!immersiveMobileMail || isMobileDetail) {
      setMobileMailChromeProgress(0, true);
      return;
    }
    mobileChromeRef.current.lastScrollTop = viewport.scrollTop;
    setMobileMailChromeProgress(mobileChromeRef.current.progress, true);
  }, [active, compactViewport, immersiveMobileMail, isMobileDetail, mode, setMobileMailChromeProgress]);

  const searchSource = useMemo(() => {
    if (!deferredQuery && !deferredAddressQuery) return mails;
    return mergeMailLists(searchIndex, mails);
  }, [deferredAddressQuery, deferredQuery, mails, searchIndex]);
  const filtered = useMemo(() => searchSource.filter((mail) => {
    const matchesQuery = !deferredQuery || getSearchText(mail).includes(deferredQuery);
    const matchesAddress = !deferredAddressQuery || getAddressSearchText(mail).includes(deferredAddressQuery);
    const matchesTab = activeTab === 'all' || (activeTab === 'attachments' && isParsed(mail) && mail.attachments.length > 0) || (activeTab === 'starred' && Boolean(mail.isStarred)) || (activeTab === 'unread' && Boolean(mail.isUnread)) || (activeTab === 'read' && !mail.isUnread);
    return matchesQuery && matchesAddress && matchesTab;
  }), [activeTab, deferredAddressQuery, deferredQuery, searchSource]);
  const mailListEntries = useMemo(() => groupConsecutiveSenderMails(filtered, mode !== 'sent'), [filtered, mode]);
  const selected = detailClosed ? null : filtered.find((mail) => mail.id === selectedId) || filtered[0] || null;
  const selectedIndex = selected ? filtered.findIndex((mail) => mail.id === selected.id) : -1;
  const detailPositionLabel = selectedIndex >= 0 ? `${selectedIndex + 1} of ${Math.max(filtered.length, 1)}` : `0 of ${Math.max(filtered.length, 1)}`;
  const unreadCount = useMemo(() => mails.filter((mail) => mail.isUnread).length, [mails]);
  const displayCount = isSearchMode ? filtered.length : (count || filtered.length);
  const tabOptions = mode === 'sent'
    ? [['all', t('全部', 'All')], ['starred', t('标注', 'Starred')], ['attachments', t('附件', 'Attachments')]]
    : [['all', t('全部', 'All')], ['unread', t('未读', 'Unread')], ['read', t('已读', 'Read')], ['starred', t('标注', 'Starred')], ['attachments', t('附件', 'Attachments')]];
  const activeTabLabel = tabOptions.find(([key]) => key === activeTab)?.[1] || t('全部', 'All');
  const mobileHasMore = !isSearchMode && !mailListExhausted;
  const toggleMailStack = useCallback((key: string) => {
    setExpandedMailStacks((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const loadMoreMobile = useCallback(async () => {
    if (mobileLoadMoreInFlightRef.current || loading || refreshing || !mobileHasMore) return;
    const requestContext = mobileListContextRef.current;
    const nextPage = mobileLoadedPages + 1;
    const nextOffset = latestMailsRef.current.length;
    const seq = ++mobileLoadMoreSeqRef.current;
    mobileLoadMoreInFlightRef.current = true;
    setMobileLoadingMore(true);
    try {
      const { results, count: totalCount } = await loadPage(nextOffset, false, address);
      if (seq !== mobileLoadMoreSeqRef.current) return;
      if (requestContext !== mobileListContextRef.current) return;
      const parsed = applyLocalState(results, mode, readIds, starredIds, readAllBefore);
      const existing = new Set(latestMailsRef.current.map((mail) => mail.id));
      const added = parsed.filter((mail) => !existing.has(mail.id));
      const merged = [...latestMailsRef.current, ...added];
      startTransition(() => {
        setMails(merged);
        setCount(Math.max(count, typeof totalCount === 'number' ? totalCount : 0, merged.length));
        setMailListExhausted(results.length < pageSize || added.length === 0);
        setMobileLoadedPages(nextPage);
      });
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('加载更多邮件失败', 'Failed to load more mail'));
    } finally {
      if (seq === mobileLoadMoreSeqRef.current) {
        mobileLoadMoreInFlightRef.current = false;
        setMobileLoadingMore(false);
      }
    }
  }, [address, count, loadPage, loading, mobileHasMore, mobileLoadedPages, mode, notify, pageSize, readAllBefore, readIds, refreshing, starredIds, t]);

  useEffect(() => {
    if (!mobileLoadMoreRef.current) return undefined;
    const target = mobileLoadMoreRef.current;
    const root = mailListViewportRef.current;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMoreMobile();
    }, { root, rootMargin: '900px 0px 900px 0px', threshold: 0.01 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadMoreMobile, filtered.length]);

  useEffect(() => {
    if (!active || !mailListViewportRef.current) return undefined;
    const viewport = mailListViewportRef.current;
    const checkNearBottom = () => {
      if (mobileLoadMoreRafRef.current !== null) return;
      mobileLoadMoreRafRef.current = window.requestAnimationFrame(() => {
        mobileLoadMoreRafRef.current = null;
        if (!mobileHasMore || mobileLoadMoreInFlightRef.current || loading || refreshing) return;
        const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        if (distance < 980) void loadMoreMobile();
      });
    };
    viewport.addEventListener('scroll', checkNearBottom, { passive: true });
    const timer = window.setTimeout(checkNearBottom, 90);
    return () => {
      viewport.removeEventListener('scroll', checkNearBottom);
      window.clearTimeout(timer);
      if (mobileLoadMoreRafRef.current !== null) {
        window.cancelAnimationFrame(mobileLoadMoreRafRef.current);
        mobileLoadMoreRafRef.current = null;
      }
    };
  }, [active, loadMoreMobile, loading, mobileHasMore, refreshing, mails.length, filtered.length]);

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
    setDetailClosed(false);
    const key = storageId(mode, mail.id);
    const next = new Set(readIds);
    next.add(key);
    persistReadIds(next);
    patchRemoteMailState({ readIdsToAdd: [key] });
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
  }, [compactViewport, mode, patchRemoteMailState, persistReadIds, readIds]);
  const navigateDetail = useCallback((offset: number) => {
    if (selectedIndex < 0) return;
    const next = filtered[selectedIndex + offset];
    if (next) markRead(next);
  }, [filtered, markRead, selectedIndex]);
  const settleMobileDetailOffset = useCallback((offset: number, after?: () => void) => {
    setMobileDetailSettling(true);
    setMobileDetailDragX(offset);
    window.setTimeout(() => {
      after?.();
      setMobileDetailDragX(0);
      window.setTimeout(() => setMobileDetailSettling(false), 30);
    }, 150);
  }, []);
  const closeMobileDetailWithMotion = useCallback((direction: 'left' | 'right' = 'right') => {
    const width = typeof window === 'undefined' ? 420 : Math.max(window.innerWidth, 360);
    settleMobileDetailOffset(direction === 'left' ? -width : width, closeMobileDetail);
  }, [closeMobileDetail, settleMobileDetailOffset]);
  const toggleStar = useCallback((mail: AnyMail) => {
    const key = storageId(mode, mail.id);
    const next = new Set<string>(starredIds);
    const remove = hasMailStateId(next, mode, mail.id);
    if (remove) deleteMailStateId(next, mode, mail.id);
    else next.add(key);
    persistStarredIds(next);
    patchRemoteMailState(remove ? { starredIdsToRemove: [key] } : { starredIdsToAdd: [key] });
  }, [mode, patchRemoteMailState, persistStarredIds, starredIds]);
  const markVisibleRead = () => {
    const targets = filtered.filter((mail) => mail.isUnread);
    if (!targets.length) {
      notify('info', t('当前视图没有未读邮件', 'No unread mail in this view'));
      return;
    }
    const next = new Set(readIds);
    targets.forEach((mail) => next.add(storageId(mode, mail.id)));
    persistReadIds(next);
    patchRemoteMailState({ readIdsToAdd: targets.map((mail) => storageId(mode, mail.id)) });
    notify('success', locale === 'en-US' ? `${targets.length} marked as read` : `已标记 ${targets.length} 封为已读`);
  };
  const markAllRead = () => {
    if (!mails.length) {
      notify('info', t('当前邮箱没有可标记邮件', 'No mail to mark in this mailbox'));
      return;
    }
    const maxId = Math.max(...mails.map((mail) => mail.id), readAllBeforeValue(readAllBefore, mode));
    persistReadAllBefore(withReadAllBeforeValue(readAllBefore, mode, maxId));
    patchRemoteMailState({ readAllBefore: maxId });
    notify('success', t('已将当前邮箱现有邮件全部标记为已读', 'All existing mail in this mailbox marked as read'));
  };
  const copyValue = useCallback(async (value: string, label = t('已复制', 'Copied'), key?: string) => {
    try {
      await copyText(value);
      const isListRecipientCopy = Boolean(key?.startsWith(`recipient-list-${mode}-`) || key?.startsWith(`recipient-stack-${mode}-`));
      if (key) {
        setCopiedKey(key);
        window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), COPY_HINT_MS);
      }
      if (!isListRecipientCopy) notify('success', label);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('复制失败，请手动复制', 'Copy failed. Please copy manually.'));
    }
  }, [mode, notify, t]);
  const deleteMail = (mail: AnyMail) => ask({ title: t(`删除邮件 #${mail.id}`, `Delete mail #${mail.id}`), body: mode === 'sent' ? t('将删除该发件箱记录。', 'This deletes the sent-mail record.') : t('将删除该原始邮件记录。', 'This deletes the raw mail record.'), actionLabel: t('删除', 'Delete'), onConfirm: async () => { await request(mode === 'sent' ? `/admin/sendbox/${mail.id}` : `/admin/mails/${mail.id}`, { method: 'DELETE' }); notify('success', t('邮件已删除', 'Mail deleted')); setSelectedId(null); setMails((current) => current.filter((item) => item.id !== mail.id)); await fetchData(true); } });
  const composeFromMail = (mail: AnyMail, kind: 'reply' | 'forward') => {
    if (isParsed(mail)) setComposeSeed({ from_mail: mail.address || '', to_mail: kind === 'reply' ? mail.senderAddress : '', to_name: kind === 'reply' ? mail.senderName : '', subject: `${kind === 'reply' ? 'Re' : 'Fwd'}: ${mail.subject}`, content: `\n\n---- ${t('原邮件', 'Original Message')} ----\n${mail.text || mail.preview}`, is_html: false });
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
      if (Math.abs(dx) > 10 && Math.abs(dx) > dy * .82) {
        event.preventDefault();
        setMobileDetailSettling(false);
        const width = typeof window === 'undefined' ? 420 : Math.max(window.innerWidth, 360);
        const limit = Math.min(width * .42, 180);
        setMobileDetailDragX(Math.max(-limit, Math.min(limit, dx)));
      }
    };
    const handleNativeEnd = (event: globalThis.TouchEvent) => {
      if (!mailSwipeRef.current.active || !isInsideDetail(event.target)) return;
      const swipe = mailSwipeRef.current;
      mailSwipeRef.current = { active: false, startX: 0, startY: 0, lastX: 0, lastY: 0 };
      const dx = swipe.lastX - swipe.startX;
      const dy = Math.abs(swipe.lastY - swipe.startY);
      if (Math.abs(dx) < 46 || Math.abs(dx) < dy * .82 || dy > 150) {
        settleMobileDetailOffset(0);
        return;
      }
      event.preventDefault();
      closeMobileDetailWithMotion(dx < 0 ? 'left' : 'right');
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
  }, [closeMobileDetailWithMotion, isMobileDetail, settleMobileDetailOffset]);

  useEffect(() => {
    if (!isMobileDetail) return undefined;
    const handleFrameSwipe = (event: MessageEvent) => {
      const data = event.data as { type?: string; direction?: 'left' | 'right'; dx?: number } | null;
      if (!data) return;
      if (data.type === 'loven7-mail-iframe-swipe-progress') {
        setMobileDetailSettling(false);
        const width = typeof window === 'undefined' ? 420 : Math.max(window.innerWidth, 360);
        const limit = Math.min(width * .42, 180);
        setMobileDetailDragX(Math.max(-limit, Math.min(limit, Number(data.dx || 0))));
        return;
      }
      if (data.type !== 'loven7-mail-iframe-swipe') return;
      if (data.direction === 'right') closeMobileDetailWithMotion('right');
      else if (data.direction === 'left') closeMobileDetailWithMotion('left');
    };
    window.addEventListener('message', handleFrameSwipe);
    return () => window.removeEventListener('message', handleFrameSwipe);
  }, [closeMobileDetailWithMotion, isMobileDetail]);

  const showListCopyToast = !compactViewport && Boolean(copiedKey?.startsWith(`recipient-list-${mode}-`) || copiedKey?.startsWith(`recipient-stack-${mode}-`));

  return (
    <div
      ref={mailWorkspaceRef}
      className={cls('mail-workspace flex h-full min-h-0 overflow-hidden bg-white', mobileChromeRef.current.collapsed && 'mobile-mail-chrome-collapsed-local')}
      style={{ '--mobile-mail-chrome-progress': mobileChromeRef.current.progress.toFixed(3), ...getMobileMailChromePaddingVars(mobileChromeRef.current.progress) } as CSSProperties}
    >
      <div ref={mailListPanelRef} className={cls('mail-list-panel relative flex h-full min-h-0 w-full shrink-0 flex-col border-r border-slate-100 lg:w-[430px] xl:w-[470px]', isMobileDetail ? 'hidden lg:flex' : 'flex')}>
        <div className={cls('mail-copy-toast', showListCopyToast && 'show')} aria-live="polite">{t('已复制', 'Copied')}</div>
        <div className="mail-list-header shrink-0 px-2.5 py-2 md:p-4 md:pb-2">
          <div className="mail-toolbar flex flex-wrap items-center gap-2">
            <div className="mr-auto min-w-0">
              <div className="mail-title-line flex items-center gap-2">
                <h2 className="mail-title-heading truncate text-[17px] font-bold text-slate-800 md:text-2xl">{title}</h2>
                <span className="mail-count-badge rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 md:text-sm">{locale === 'en-US' ? `${displayCount} mails` : `${displayCount} 封`}</span>
                {unreadCount > 0 && <span className="mail-count-badge unread rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-800">{locale === 'en-US' ? `${unreadCount} unread` : `${unreadCount} 未读`}</span>}
              </div>
              <div className="mail-auto-refresh-note mt-1 text-[11px] font-medium text-slate-500">{autoRefresh ? (locale === 'en-US' ? `Auto refresh on · sync in ${refreshCountdown}s` : `自动刷新开启 · ${refreshCountdown}s 后同步`) : t('自动刷新关闭', 'Auto refresh off')}</div>
            </div>
            <div className="mail-toolbar-actions" data-no-page-swipe="true">
              <div className="mail-filter-popover" data-no-page-swipe="true">
                <button
                  type="button"
                  className={cls('mail-filter-select mail-filter-trigger', filterMenuOpen && 'active')}
                  onClick={() => setFilterMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={filterMenuOpen}
                  aria-label={t('邮件筛选', 'Mail filter')}
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
                    {mode !== 'sent' && (
                      <>
                        <div className="mail-filter-menu-divider" role="presentation" />
                        <button
                          type="button"
                          role="menuitem"
                          className="mail-filter-menu-action"
                          onClick={() => { markAllRead(); setFilterMenuOpen(false); }}
                        >
                          <span><CheckCheck size={14} />{t('全部已读', 'All read')}</span>
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              <button className="mail-tool-btn mail-read-btn" onClick={markVisibleRead} title={t('将当前筛选结果标记为已读', 'Mark current filtered results as read')} aria-label={t('一键已读', 'Mark visible read')}><CheckCheck size={15} /><span className="mail-tool-text">{t('一键已读', 'Mark read')}</span></button>
              <button className="mail-tool-btn mail-read-btn" onClick={markAllRead} title={t('将当前邮箱已存在邮件全部标记为已读', 'Mark all existing mail in this mailbox as read')} aria-label={t('全部已读', 'Mark all read')}><CheckCheck size={15} /><span className="mail-tool-text">{t('全部已读', 'All read')}</span></button>
            </div>
          </div>
          <div className="mail-address-search-row mt-2" data-no-page-swipe="true">
            <div className="address-filter-wrap">
              <input
                value={addressInput}
                onChange={(e) => { setAddressInput(e.target.value); setPage(1); setSelectedId(null); }}
                onKeyDown={(event) => { if (event.key === 'Escape' && addressInput) clearAddressFilter(); }}
                className="form-input address-filter-input rounded-xl py-1.5 pr-9 text-[13px] md:rounded-2xl md:py-2 md:text-sm"
                placeholder={t('搜索邮箱、主题或正文', 'Search mailbox, subject, or body')}
                inputMode="text"
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
                  aria-label={t('清空邮件搜索', 'Clear mail search')}
                  title={t('清空邮件搜索', 'Clear mail search')}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <button className="mail-tool-btn primary mail-search-refresh" onClick={() => fetchData(true)} title={t('增量刷新', 'Refresh incrementally')} aria-label={t('增量刷新', 'Refresh incrementally')}><RefreshCw size={15} className={cls(refreshing && 'animate-spin')} /><span className="mail-tool-text">{t('刷新', 'Refresh')}</span></button>
          </div>
        </div>
        {compactViewport && (
          <div
            className={cls(
              'mobile-pull-refresh-indicator',
              pullRefreshOffset > 0 && 'show',
              (pullRefreshOffset >= PULL_REFRESH_TRIGGER || pullRefreshLabel.includes('松开') || pullRefreshLabel.includes('Release')) && 'active',
            )}
            style={{ '--pull-refresh-offset': `${pullRefreshOffset}px` } as CSSProperties}
            aria-hidden="true"
          >
            <RefreshCw size={15} className={cls(pullRefreshLabel.includes('正在') || pullRefreshLabel.includes('Refreshing') ? 'animate-spin' : '')} />
            <span>{pullRefreshLabel}</span>
          </div>
        )}
        <div
          ref={mailListViewportRef}
          onScroll={handleMailListScroll}
          className="mail-list-viewport flex-1 overflow-y-auto px-2 pb-2 md:px-4 md:pb-4"
        >
          {loading && mails.length === 0 ? <LoadingState /> : filtered.length === 0 ? <EmptyState title={isSearchMode ? t('没有匹配结果', 'No matches') : t('暂无邮件', 'No mail')} /> : mailListEntries.map((entry) => (
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
          {mails.length > 0 && !isSearchMode && (
            <div ref={mobileLoadMoreRef} className="mail-list-load-more mobile-mail-load-more" data-no-page-swipe="true">
              {mobileLoadingMore ? t('正在加载…', 'Loading...') : mobileHasMore ? '' : t('已全部加载', 'All loaded')}
            </div>
          )}
        </div>
      </div>
      <div className="mail-detail-pane hidden h-full min-w-0 flex-1 flex-col lg:flex">
        {!compactViewport && <MailDetail mail={selected} mode={mode} theme={theme} onDelete={deleteMail} onReply={(mail) => composeFromMail(mail, 'reply')} onForward={(mail) => composeFromMail(mail, 'forward')} onCopy={copyValue} onToggleStar={toggleStar} onClose={() => setDetailClosed(true)} onPrevious={() => navigateDetail(-1)} onNext={() => navigateDetail(1)} canPrevious={selectedIndex > 0} canNext={selectedIndex >= 0 && selectedIndex < filtered.length - 1} positionLabel={detailPositionLabel} />}
      </div>
      {isMobileDetail && (
        <div
          className={cls('mobile-mail-detail absolute inset-0 z-40 flex h-full min-h-0 flex-col bg-white lg:hidden', mobileDetailSettling && 'mobile-detail-settling')}
          style={{ transform: `translate3d(${mobileDetailDragX}px, 0, 0)` }}
        >
          <MailDetail mail={selected} mode={mode} theme={theme} onDelete={deleteMail} onReply={(mail) => composeFromMail(mail, 'reply')} onForward={(mail) => composeFromMail(mail, 'forward')} onCopy={copyValue} onToggleStar={toggleStar} onClose={() => { setDetailClosed(true); setIsMobileDetail(false); setMobileDetailDragX(0); }} onPrevious={() => navigateDetail(-1)} onNext={() => navigateDetail(1)} canPrevious={selectedIndex > 0} canNext={selectedIndex >= 0 && selectedIndex < filtered.length - 1} positionLabel={detailPositionLabel} mobile />
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
  const locale = getRuntimeLocale();
  const t: TranslateFn = (zh, en) => localeText(zh, en, locale);
  const senderAddress = getSenderAddress(mail);
  const senderName = getSenderName(mail);
  const recipientAddress = getRecipient(mail);
  const recipientCopyKey = `recipient-list-${mode}-${mail.id}`;
  const recipientPressRef = useRef<PressPoint | null>(null);
  return (
    <div
      onClick={() => onOpen(mail)}
      className={cls('mail-list-item group relative mb-1 w-full cursor-pointer px-3 py-1.5 text-left transition-all md:mb-1 md:px-3.5 md:py-2', selected ? 'mail-row-selected' : 'mail-row-idle', mail.isUnread && 'mail-row-unread', isNew && 'animate-mail-in')}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="mail-avatar-wrap">
          <BrandAvatar sender={senderAddress} senderName={senderName} size={32} className="mail-list-brand-avatar" />
        </div>
        <div className="min-w-0 flex-1">
      <div className="mb-0.5 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="mail-sender-line">
            <span className="mail-sender truncate text-[13px] font-normal text-slate-600 md:text-[14px]">{senderName || senderAddress || getSender(mail)}</span>
            {recipientAddress && (
              <button
                type="button"
                onPointerDown={(event) => { recipientPressRef.current = { x: event.clientX, y: event.clientY }; }}
                onPointerCancel={() => { recipientPressRef.current = null; }}
                onClick={(event) => {
                  event.stopPropagation();
                  const intentional = isIntentionalRecipientCopyClick(recipientPressRef.current, event);
                  recipientPressRef.current = null;
                  if (!intentional) return;
                  onCopy(recipientAddress, t('已复制收件地址', 'Recipient address copied'), recipientCopyKey);
                }}
                className="mail-list-recipient-inline"
                title={recipientAddress}
              >
                <span className="mail-list-recipient-text">{recipientAddress}</span>
              </button>
            )}
          </span>
          <div className="mt-0.5 flex items-center gap-2">
            <h4 className="mail-subject truncate text-[14px] font-semibold text-slate-900 md:text-[15px]">{mail.subject}</h4>
            {isParsed(mail) && mail.attachments.length > 0 && <Paperclip size={13} className="shrink-0 text-slate-400" />}
          </div>
        </div>
        <div className="mail-list-side flex shrink-0 flex-col items-end gap-1">
          <span className="mail-list-time-line">
            <span className="mail-time text-[12px] font-semibold text-slate-600">{formatShortDate(mail.created_at)}</span>
          </span>
          {mail.isUnread && <span className="mail-unread-dot" aria-hidden="true" />}
        </div>
      </div>
      <div className="flex items-center gap-2 md:gap-3">
        <p className="line-clamp-1 min-w-0 flex-1 text-[12px] leading-5 text-slate-500 md:text-xs">{mail.preview}</p>
        <span onClick={(event) => { event.stopPropagation(); onToggleStar(mail); }} title={t('收藏', 'Star')} className={cls('mail-star-toggle shrink-0 rounded-full p-1 transition', mail.isStarred ? 'text-slate-700' : 'text-slate-300 opacity-0 group-hover:opacity-100')}>
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
  const locale = getRuntimeLocale();
  const t: TranslateFn = (zh, en) => localeText(zh, en, locale);
  const mail = entry.latest;
  const senderAddress = getSenderAddress(mail);
  const senderName = getSenderName(mail);
  const recipientAddress = getRecipient(mail);
  const recipientCopyKey = `recipient-stack-${mode}-${mail.id}`;
  const selected = entry.mails.some((item) => item.id === selectedId);
  const recipientPressRef = useRef<PressPoint | null>(null);
  return (
    <div
      onClick={() => onOpen(mail)}
      className={cls('mail-list-item mail-stack-item group relative mb-1 w-full cursor-pointer px-3 py-1.5 text-left transition-all md:mb-1 md:px-3.5 md:py-2', selected ? 'mail-row-selected' : 'mail-row-idle', entry.unreadCount > 0 && 'mail-row-unread', isNew && 'animate-mail-in', expanded && 'mail-stack-expanded')}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="mail-avatar-wrap">
          <BrandAvatar sender={senderAddress} senderName={senderName} size={32} className="mail-list-brand-avatar" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <span className="mail-sender-line">
                <span className="mail-sender truncate text-[13px] font-normal text-slate-600 md:text-[14px]">{senderName || senderAddress || getSender(mail)}</span>
                {recipientAddress && (
                  <button
                    type="button"
                    onPointerDown={(event) => { recipientPressRef.current = { x: event.clientX, y: event.clientY }; }}
                    onPointerCancel={() => { recipientPressRef.current = null; }}
                    onClick={(event) => {
                      event.stopPropagation();
                      const intentional = isIntentionalRecipientCopyClick(recipientPressRef.current, event);
                      recipientPressRef.current = null;
                      if (!intentional) return;
                      onCopy(recipientAddress, t('已复制收件地址', 'Recipient address copied'), recipientCopyKey);
                    }}
                    className="mail-list-recipient-inline"
                    title={recipientAddress}
                  >
                    <span className="mail-list-recipient-text">{recipientAddress}</span>
                  </button>
                )}
              </span>
              <div className="mt-0.5 flex items-center gap-2">
                <h4 className="mail-subject truncate text-[14px] font-semibold text-slate-900 md:text-[15px]">{mail.subject}</h4>
                {isParsed(mail) && mail.attachments.length > 0 && <Paperclip size={13} className="shrink-0 text-slate-400" />}
              </div>
            </div>
            <div className="mail-list-side flex shrink-0 flex-col items-end gap-1">
              <span className="mail-list-time-line">
                <span className="mail-time text-[12px] font-semibold text-slate-600">{formatShortDate(mail.created_at)}</span>
              </span>
              {entry.unreadCount > 0 && <span className="mail-unread-dot" aria-hidden="true" />}
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
          <div className="flex items-center gap-2 md:gap-3">
            <p className="line-clamp-1 min-w-0 flex-1 text-[12px] leading-5 text-slate-500 md:text-xs">{mail.preview}</p>
            <span onClick={(event) => { event.stopPropagation(); onToggleStar(mail); }} title={t('收藏', 'Star')} className={cls('mail-star-toggle shrink-0 rounded-full p-1 transition', mail.isStarred ? 'text-slate-700' : 'text-slate-300 opacity-0 group-hover:opacity-100')}>
              <Star size={15} fill={mail.isStarred ? 'currentColor' : 'none'} />
            </span>
          </div>
          <div className={cls('mail-stack-children-shell', expanded && 'open')} aria-hidden={!expanded}>
            <div className="mail-stack-children" onClick={(event) => event.stopPropagation()}>
              {entry.mails.map((stackMail, index) => {
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
                      <small>{stackMail.preview || t('无内容预览', 'No preview')}</small>
                    </span>
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

function MailDetail({
  mail,
  mode,
  onDelete,
  onReply,
  onForward,
  onCopy,
  onToggleStar,
  onClose,
  onPrevious,
  onNext,
  canPrevious,
  canNext,
  positionLabel,
  mobile: _mobile = false,
}: {
  mail: AnyMail | null;
  mode: MailMode;
  theme: 'light' | 'dark';
  onDelete: (mail: AnyMail) => void;
  onReply: (mail: AnyMail) => void;
  onForward: (mail: AnyMail) => void;
  onCopy: (value: string, label?: string, key?: string) => void;
  onToggleStar: (mail: AnyMail) => void;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  canPrevious: boolean;
  canNext: boolean;
  positionLabel: string;
  mobile?: boolean;
}) {
  const locale = getRuntimeLocale();
  const t: TranslateFn = (zh, en) => localeText(zh, en, locale);
  useEffect(() => { if (mail) writeSessionMailDetail(mode, mail); }, [mail, mode]);
  const parsedForMemo = mail ? isParsed(mail) : false;
  const htmlForFrame = mail ? String(parsedForMemo ? mail.message : mail.is_html ? mail.content : '') : '';
  const rawForDownload = mail && parsedForMemo ? String(mail.raw || '') : '';
  const iframeDocument = useMemo(() => {
    return htmlForFrame ? buildMailHtmlDocument(parsedForMemo ? htmlForFrame : sanitizeMailHtml(htmlForFrame)) : '';
  }, [htmlForFrame, parsedForMemo]);
  const emlUrl = useMemo(() => (rawForDownload ? getDownloadEmlUrl(rawForDownload) : ''), [rawForDownload]);
  useEffect(() => () => { if (emlUrl) URL.revokeObjectURL(emlUrl); }, [emlUrl]);
  if (!mail) return <div className="p-8"><EmptyState title={t('请选择一封邮件', 'Select a message')} /></div>;
  const parsed = isParsed(mail);
  const text = parsed ? (looksLikeMimeSource(mail.text) ? '' : mail.text) : mail.content;
  const senderAddress = getSenderAddress(mail);
  const senderName = getSenderName(mail);
  const subtitle = parsed ? mail.senderAddress : t('发件记录', 'Sent record');
  const recipientAddress = getRecipient(mail);
  const recipientLabel = mode === 'sent'
    ? `${t('to', 'to')} ${recipientAddress || t('unknown', 'unknown')}`
    : t('to me', 'to me');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mail-detail-scroll min-h-0 flex-1 overflow-hidden p-1.5 sm:p-2.5 md:p-4 xl:p-5">
        <article className={cls('mail-detail-card mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col rounded-2xl border border-slate-100/80 bg-white p-2.5 shadow-sm sm:rounded-3xl sm:p-3.5 md:p-4 xl:p-5', _mobile && 'mail-detail-card-mobile')}>
          <div className="mail-detail-topbar shrink-0">
            <div className="mail-detail-topbar-actions">
              <button type="button" onClick={onClose} className="mail-detail-icon-action mail-detail-close" title={t('关闭', 'Close')} aria-label={t('关闭邮件详情', 'Close message detail')}><X size={18} /></button>
              <button type="button" onClick={() => onDelete(mail)} className="mail-detail-icon-action" title={t('删除', 'Delete')} aria-label={t('删除', 'Delete')}><Trash2 size={16} /></button>
              {parsed && mail.raw && emlUrl ? (
                <a className="mail-detail-icon-action" href={emlUrl} download={`${mail.id}.eml`} title={t('下载 EML', 'Download EML')} aria-label={t('下载 EML', 'Download EML')}><Archive size={16} /></a>
              ) : (
                <button type="button" className="mail-detail-icon-action" disabled title={t('无可下载原文', 'No raw message available')} aria-label={t('无可下载原文', 'No raw message available')}><Archive size={16} /></button>
              )}
              <button type="button" onClick={() => onForward(mail)} className="mail-detail-icon-action" title={t('更多', 'More')} aria-label={t('更多', 'More')}><MoreHorizontal size={17} /></button>
            </div>
            <div className="mail-detail-topbar-nav" aria-label={t('邮件导航', 'Message navigation')}>
              <span>{positionLabel}</span>
              <button type="button" onClick={onPrevious} disabled={!canPrevious} className="mail-detail-icon-action" title={t('上一封', 'Previous')} aria-label={t('上一封', 'Previous')}><ChevronLeft size={18} /></button>
              <button type="button" onClick={onNext} disabled={!canNext} className="mail-detail-icon-action" title={t('下一封', 'Next')} aria-label={t('下一封', 'Next')}><ChevronRight size={18} /></button>
            </div>
          </div>
          <header className={cls('mail-detail-header shrink-0', _mobile && 'is-mobile')}>
            <div className="mail-detail-subject-row flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="mail-detail-subject truncate text-[1.05rem] font-bold leading-snug text-slate-800 sm:text-[1.25rem] md:text-[1.45rem]">{mail.subject}</h1>
              </div>
              <button onClick={() => onToggleStar(mail)} className={cls('mail-detail-star rounded-full p-2 transition hover:bg-slate-100', mail.isStarred ? 'text-slate-800' : 'text-slate-300 hover:text-slate-600')} title={t('星星代表收藏/标记，点击后可在列表“标注”里筛选', 'Starred mail appears in the Starred filter')}><Star size={21} fill={mail.isStarred ? 'currentColor' : 'none'} /></button>
            </div>
            <div className="mail-detail-sender-row mt-2.5 flex gap-2.5 md:mt-3">
              <BrandAvatar sender={senderAddress} senderName={senderName} size={40} className="mail-detail-brand-avatar" />
              <div className="min-w-0 flex-1">
                <div className="mail-detail-sender-main flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-800">{parsed ? mail.senderName : mail.address}</span>
                  <span className="truncate text-sm text-slate-500">{subtitle}</span>
                </div>
                <button type="button" onClick={() => onCopy(recipientAddress, t('已复制收件地址', 'Recipient address copied'), `detail-recipient-${mode}-${mail.id}`)} className="mail-detail-to-line" title={recipientAddress || undefined}>{recipientLabel} <ChevronDown size={12} /></button>
              </div>
              <div className="mail-detail-sender-actions hidden shrink-0 lg:flex">
                <time className="mail-detail-inline-time">{formatShortDate(mail.created_at)}</time>
                <div className="mail-detail-action-row">
                  <button onClick={() => onReply(mail)} className="detail-action" title={t('回复', 'Reply')}><Reply size={16} /></button>
                  <button onClick={() => onToggleStar(mail)} className="detail-action" title={t('星标', 'Star')}><Star size={16} fill={mail.isStarred ? 'currentColor' : 'none'} /></button>
                  <button onClick={() => onForward(mail)} className="detail-action" title={t('更多', 'More')}><MoreHorizontal size={16} /></button>
                </div>
              </div>
            </div>
          </header>
          <div className="my-2 h-px shrink-0 bg-slate-100 md:my-2.5" />
          <div className="mail-detail-body min-h-0 flex-1 overflow-hidden">
            {iframeDocument ? <iframe title={`mail-${mail.id}`} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcDoc={iframeDocument} referrerPolicy="no-referrer" className="mail-frame" /> : <pre className="mail-text">{text || mail.preview || t('邮件正文仍在后台同步，请稍后刷新。', 'Message body is still syncing. Please refresh later.')}</pre>}
          </div>
          {parsed && mail.attachments.length > 0 && <div className="mt-2.5 shrink-0"><h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800"><Paperclip size={16} /> {t('附件', 'Attachments')} ({mail.attachments.length})</h4><div className="grid max-h-24 gap-2 overflow-y-auto sm:grid-cols-2">{mail.attachments.map((attachment) => <a key={attachment.id} href={attachment.url} download={attachment.filename} className="flex items-center justify-between rounded-2xl border border-slate-200 p-2 transition hover:bg-slate-50"><div className="flex min-w-0 items-center gap-2"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-[10px] font-bold uppercase text-slate-700">{attachment.filename.split('.').pop() || 'file'}</div><div className="min-w-0"><p className="truncate text-xs font-medium text-slate-700">{attachment.filename}</p><p className="text-[11px] text-slate-400">{attachment.size}</p></div></div><Download size={14} className="text-slate-400" /></a>)}</div></div>}
        </article>
      </div>
    </div>
  );
}
