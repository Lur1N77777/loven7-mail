import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Copy, Edit3, ExternalLink, Inbox, KeyRound, ListFilter, Lock, MailOpen, MoreHorizontal, Plus, RefreshCw, Save, Search, Send, Share2, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import { buildQuery, type Requester } from '../lib/api';
import { CACHE_TTL, DEFAULT_PAGE_SIZE, FRONTEND_LOGIN_BASE, STORAGE_KEYS } from '../lib/constants';
import { cls, formatDateTime, normalizeSearch } from '../lib/format';
import { sha256Hex } from '../lib/crypto';
import { getRuntimeLocale, localeText } from '../lib/locale';
import { buildAddressLoginUrl, copyText } from '../lib/clipboard';
import { readJsonStorage, readStorage, writeJsonStorage, writeLocalStorage } from '../lib/storage';
import { parseRawMailListItem } from '../lib/mailParser';
import type { AddressRecord, AddressUserFilter, BoundAddressRecord, ListResponse, OpenSettings, RawMailRecord, SenderAccessRecord, UserRecord } from '../types/api';
import { EmptyState, LoadingState, Modal, Pagination, PopoverSelect, type Notify, useConfirm } from '../components/Common';

type CachedList<T> = { version: number; count: number; savedAt: number; results: T[]; complete?: boolean };
type CachedUserOptions = { version: number; savedAt: number; count?: number; users: UserRecord[] };
type CachedNewAddressDraft = { version: number; savedAt: number; customPrefix?: string; domain?: string; enablePrefix?: boolean; enableRandomSubdomain?: boolean };
type DesktopAddressActionMenu = { row: AddressRecord; top: number; left: number; placement: 'up' | 'down' };
const LIST_CACHE_VERSION = 1;
const USER_OPTIONS_CACHE_VERSION = 1;
const NEW_ADDRESS_DRAFT_VERSION = 1;
const USER_OPTIONS_CACHE_KEY = `${STORAGE_KEYS.userListCachePrefix}address-filter-options`;
const RANDOM_DOMAIN_VALUE = '__random_domain__';
const SEPARATOR_SAFE_ADDRESS_REGEX = '[^a-z0-9._-]';
const USER_OPTIONS_PAGE_SIZE = 100;
const ADDRESS_INDEX_PAGE_SIZE = 500;
const BATCH_MAIL_SCAN_PAGE_SIZE = 50;
const BATCH_MAIL_SCAN_CONCURRENCY = 5;
const SHARE_LIST_CACHE_KEY = 'loven7.shareAdminListCache';

type DomainOption = { label: string; value: string };
type NewAddressForm = {
  name: string;
  customPrefix: string;
  domain: string;
  enablePrefix: boolean;
  enableRandomSubdomain: boolean;
};

type ShareExpiryOption = '1d' | '7d' | '30d' | 'forever';
type ShareStatus = 'active' | 'expired' | 'revoked';
type ShareStatusFilter = 'all' | 'active' | 'inactive';
type ShareMailVisibility = 'new' | 'all';
type SharePermissions = { hideMail: boolean };
type ShareAdminRecord = {
  token: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  status: ShareStatus;
  addressCount: number;
  hiddenAddressCount?: number;
  hiddenMailCount?: number;
  mailCount?: number;
  visibleMailCount?: number;
  totalMailCount?: number;
  mailVisibility?: ShareMailVisibility;
  permissions?: SharePermissions;
  addresses: Array<{ id: string; address: string; mailCount?: number; mail_count?: number; visibleMailCount?: number }>;
};
type ShareListResponse = {
  ok?: boolean;
  results?: ShareAdminRecord[];
  cursor?: string | null;
  hasMore?: boolean;
};

const ADDRESS_SORT_OPTIONS = [
  { value: 'id', label: 'ID' },
  { value: 'name', label: '地址' },
  { value: 'created_at', label: '创建时间' },
  { value: 'updated_at', label: '更新时间' },
  { value: 'mail_count', label: '收件数' },
  { value: 'send_count', label: '发件数' },
];

const SHARE_EXPIRY_OPTIONS: Array<{ value: ShareExpiryOption; label: string; description?: string }> = [
  { value: '1d', label: '1 天', description: '短期临时分享' },
  { value: '7d', label: '7 天', description: '一周内有效' },
  { value: '30d', label: '30 天', description: '默认推荐' },
  { value: 'forever', label: '永久有效', description: '不自动过期' },
];

const SHARE_STATUS_FILTER_OPTIONS: Array<{ value: ShareStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '有效' },
  { value: 'inactive', label: '失效' },
];

const SHARE_VISIBILITY_OPTIONS: Array<{ value: ShareMailVisibility; label: string; description?: string }> = [
  { value: 'new', label: '仅新增', description: '从现在开始' },
  { value: 'all', label: '包含历史', description: '显示已有邮件' },
];

const defaultNewAddress: NewAddressForm = { name: '', customPrefix: '', domain: '', enablePrefix: true, enableRandomSubdomain: false };

function shareLinkSuffix(row: ShareAdminRecord): string {
  try {
    const url = new URL(row.url);
    return url.pathname || `/${row.token}`;
  } catch {
    return row.token ? `/s/${row.token}` : '-';
  }
}

function effectiveShareStatus(row: ShareAdminRecord, now = Date.now()): ShareStatus {
  if (row.revokedAt || row.status === 'revoked') return 'revoked';
  const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : 0;
  if (row.status === 'expired' || (expiresAt > 0 && expiresAt <= now)) return 'expired';
  return 'active';
}

function shareSearchText(row: ShareAdminRecord): string {
  return normalizeSearch([
    row.token,
    shareLinkSuffix(row),
    row.url,
    row.status,
    row.mailVisibility,
    ...row.addresses.map((item) => `${item.id} ${item.address}`),
  ].join(' '));
}

function useLocaleCopy() {
  const locale = getRuntimeLocale();
  return {
    locale,
    t: (zh: string, en: string) => localeText(zh, en, locale),
  };
}

function findUserArray(raw: any, depth = 0): any[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object' || depth > 3) return [];
  const directKeys = ['results', 'users', 'data', 'list', 'items', 'records', 'rows'];
  for (const key of directKeys) {
    const found = findUserArray(raw[key], depth + 1);
    if (found.length) return found;
  }
  for (const value of Object.values(raw)) {
    const found = findUserArray(value, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function findUserCount(raw: any, fallback: number): number {
  if (!raw || typeof raw !== 'object') return fallback;
  const direct = Number(raw.count ?? raw.total ?? raw.total_count ?? raw.totalCount ?? raw.user_count ?? raw.userCount);
  if (Number.isFinite(direct) && direct >= 0) return Math.max(direct, fallback);
  for (const value of Object.values(raw)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = findUserCount(value, fallback);
      if (nested > fallback) return nested;
    }
  }
  return fallback;
}

function parseUserOptionsResponse(res: unknown): { users: UserRecord[]; count: number } {
  const raw = res as any;
  const source = findUserArray(raw);
  const users: UserRecord[] = source
    .map((user: Partial<UserRecord> & Record<string, unknown>) => ({
      ...user,
      id: Number(user.id || user.user_id || 0),
      user_email: String(user.user_email || user.email || user.userEmail || user.mail || ''),
      address_count: Number(user.address_count ?? user.addressCount ?? user.addresses_count ?? 0),
    }))
    .filter((user: UserRecord) => user.id > 0 && Boolean(user.user_email));
  const count = findUserCount(raw, users.length);
  return { users, count: Math.max(count || 0, users.length) };
}

async function loadAllUserOptions(request: Requester): Promise<{ users: UserRecord[]; count: number }> {
  const merged = new Map<number, UserRecord>();
  let expectedCount = 0;
  for (let offset = 0; offset < 1000; offset += USER_OPTIONS_PAGE_SIZE) {
    const res = await request<ListResponse<UserRecord> | UserRecord[]>(`/admin/users${buildQuery({ limit: USER_OPTIONS_PAGE_SIZE, offset })}`, {
      forceRefresh: offset === 0,
      cacheTtlMs: CACHE_TTL.userOptions,
    });
    const parsed = parseUserOptionsResponse(res);
    expectedCount = Math.max(expectedCount, parsed.count);
    parsed.users.forEach((user) => merged.set(user.id, user));
    if (parsed.users.length < USER_OPTIONS_PAGE_SIZE || merged.size >= expectedCount) break;
  }
  if (merged.size === 0 && expectedCount > 0) {
    const fallback = await request<ListResponse<UserRecord> | UserRecord[]>('/admin/users', {
      forceRefresh: true,
      cacheTtlMs: CACHE_TTL.userOptions,
    }).catch(() => null);
    if (fallback) {
      const parsed = parseUserOptionsResponse(fallback);
      expectedCount = Math.max(expectedCount, parsed.count);
      parsed.users.forEach((user) => merged.set(user.id, user));
    }
  }
  const users = Array.from(merged.values());
  return { users, count: Math.max(expectedCount, users.length) };
}

function cleanLocalPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/[._-]{2,}/g, (match) => match[0])
    .replace(/^[._-]+|[._-]+$/g, '');
}

function cleanCustomPrefix(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/[._-]{2,}/g, (match) => match[0])
    .replace(/^[._-]+/g, '');
}

function readStoredNewAddressDraft(): NewAddressForm {
  const cached = readJsonStorage<CachedNewAddressDraft | null>(STORAGE_KEYS.newAddressDraft, null);
  if (!cached || cached.version !== NEW_ADDRESS_DRAFT_VERSION) return defaultNewAddress;
  return {
    name: '',
    customPrefix: cleanCustomPrefix(String(cached.customPrefix || '')),
    domain: typeof cached.domain === 'string' ? cached.domain : '',
    enablePrefix: typeof cached.enablePrefix === 'boolean' ? cached.enablePrefix : true,
    enableRandomSubdomain: Boolean(cached.enableRandomSubdomain),
  };
}

function writeStoredNewAddressDraft(value: NewAddressForm) {
  writeJsonStorage(STORAGE_KEYS.newAddressDraft, {
    version: NEW_ADDRESS_DRAFT_VERSION,
    savedAt: Date.now(),
    customPrefix: cleanCustomPrefix(value.customPrefix),
    domain: value.domain || '',
    enablePrefix: Boolean(value.enablePrefix),
    enableRandomSubdomain: Boolean(value.enableRandomSubdomain),
  });
}

function addressRegexAllowsSeparators(value?: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const regex = new RegExp(value, 'g');
    return ['.', '_', '-'].every((char) => {
      regex.lastIndex = 0;
      return !regex.test(char);
    });
  } catch {
    return false;
  }
}

function normalizeDomainOptions(settings?: OpenSettings | null): DomainOption[] {
  const labels = Array.isArray(settings?.domainLabels) ? settings.domainLabels : [];
  const raw = Array.isArray(settings?.domains) ? settings.domains : [];
  return raw
    .map((domain, index) => {
      if (typeof domain === 'string') return { label: labels[index] || domain, value: domain };
      return { label: domain.label || domain.value, value: domain.value };
    })
    .filter((item) => item.value);
}

function getDefaultDomainValue(settings: OpenSettings | null | undefined, options: DomainOption[]): string {
  const defaults = Array.isArray(settings?.defaultDomains) ? settings.defaultDomains : [];
  return defaults.find((domain) => options.some((item) => item.value === domain)) || options[0]?.value || '';
}

function pickRandom<T>(items: T[]): T {
  return items[randomInt(0, Math.max(0, items.length - 1))];
}

function randomInt(min: number, max: number): number {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  if (high <= low) return low;
  const range = high - low + 1;
  const cryptoSource = globalThis.crypto;
  if (cryptoSource?.getRandomValues) {
    const values = new Uint32Array(1);
    cryptoSource.getRandomValues(values);
    return low + (values[0] % range);
  }
  return low + Math.floor(Math.random() * range);
}

function randomChar(chars: string): string {
  return chars[randomInt(0, chars.length - 1)];
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildReadableLetters(length: number): string {
  const vowels = 'aeiou';
  const consonants = 'bcdfghjklmnpqrstvwxyz';
  let useConsonant = randomInt(0, 1) === 1;
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += randomChar(useConsonant ? consonants : vowels);
    const shouldFlip = index === 0 || randomInt(0, 100) > 18;
    if (shouldFlip) useConsonant = !useConsonant;
  }
  return output;
}

function buildRandomTail(length: number): string {
  const digits = '0123456789';
  const minDigitCount = 2;
  const maxDigitCount = Math.max(minDigitCount, Math.min(5, length - 3));
  const digitCount = clampNumber(randomInt(minDigitCount, maxDigitCount), 1, Math.max(1, length - 2));
  const letterCount = Math.max(1, length - digitCount);
  const letters = buildReadableLetters(letterCount);
  const numberBlock = Array.from({ length: digitCount }, () => randomChar(digits)).join('');
  const mode = randomInt(0, 3);
  if (mode === 0) return `${letters}${numberBlock}`;
  if (mode === 1) return `${numberBlock}${letters}`;
  if (mode === 2) {
    const split = randomInt(1, Math.max(1, letters.length - 1));
    return `${letters.slice(0, split)}${numberBlock}${letters.slice(split)}`;
  }
  const chars = `${letters}${numberBlock}`.split('');
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index);
    [chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]];
  }
  return chars.join('');
}

function makeRealisticMailboxName(settings?: OpenSettings | null, customPrefix = ''): string {
  const prefix = cleanCustomPrefix(customPrefix);
  const min = Math.max(1, Number(settings?.minAddressLen || 1));
  const targetMin = Math.max(min, 10);
  const targetMax = Math.max(targetMin, 15);
  const tailLength = randomInt(targetMin, targetMax);
  const tail = buildRandomTail(tailLength);
  let name = cleanLocalPart(`${prefix}${tail}`);
  if (!/[a-z]/.test(name)) name = cleanLocalPart(`${name}a`);
  if (!/\d/.test(name)) name = cleanLocalPart(`${name}${randomInt(0, 9)}`);
  while (name.length < min) name = cleanLocalPart(`${name}${randomInt(0, 9)}`);
  return name || `mail${randomInt(1000, 9999)}`;
}

function makeRandomNameInput(settings: OpenSettings | null | undefined, customPrefix: string): string {
  const prefix = cleanCustomPrefix(customPrefix);
  const fullName = makeRealisticMailboxName(settings, prefix);
  return prefix && fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName;
}

function readStoredAddressUserFilter(fallback?: AddressUserFilter | null): AddressUserFilter | null {
  if (fallback && fallback.userId > 0) return fallback;
  const raw = readStorage(STORAGE_KEYS.addressUserFilter, '');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AddressUserFilter>;
    if (typeof parsed.userId === 'number' && parsed.userId > 0 && typeof parsed.userEmail === 'string') {
      return { userId: parsed.userId, userEmail: parsed.userEmail, requestId: Number(parsed.requestId || 0) };
    }
  } catch {
    // Legacy string filters are ignored because /admin/address cannot query reliably by user email.
  }
  return null;
}

function boundToAddressRecord(row: BoundAddressRecord, filter: AddressUserFilter): AddressRecord {
  return { ...row, user_id: filter.userId, user_email: filter.userEmail };
}

function addressSortValue(row: AddressRecord, sortBy: string): string | number {
  if (sortBy === 'name') return row.name || '';
  if (sortBy === 'created_at') return row.created_at || '';
  if (sortBy === 'updated_at') return row.updated_at || row.created_at || '';
  if (sortBy === 'mail_count') return Number(row.mail_count || 0);
  if (sortBy === 'send_count') return Number(row.send_count || 0);
  return Number(row.id || 0);
}

function sortAddressRows(rows: AddressRecord[], sortBy: string, sortOrder: 'ascend' | 'descend'): AddressRecord[] {
  const direction = sortOrder === 'ascend' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = addressSortValue(a, sortBy);
    const right = addressSortValue(b, sortBy);
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction;
    return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' }) * direction;
  });
}

function normalizeBatchMailSearch(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function stringifyMailField(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildBatchMailHaystack(item: RawMailRecord): string {
  const parsed = parseRawMailListItem(item);
  const record = item as Record<string, unknown>;
  const directFields = [
    parsed.subject,
    parsed.preview,
    parsed.text,
    parsed.message,
    parsed.sender,
    parsed.to,
    record.subject,
    record.text,
    record.content,
    record.body,
    record.message,
    record.html,
    record.preview,
    record.snippet,
    record.metadata,
    record.raw,
    record.source,
    record.address,
  ];
  return normalizeBatchMailSearch(directFields.map(stringifyMailField).filter(Boolean).join(' '));
}

export function AddressView({ request, notify, ask, globalQuery, openSettings, userFilter, userTotal = 0, onClearUserFilter, onOpenInbox }: { request: Requester; notify: Notify; ask: ReturnType<typeof useConfirm>['ask']; globalQuery: string; openSettings?: OpenSettings | null; userFilter?: AddressUserFilter | null; userTotal?: number; onClearUserFilter?: () => void; onOpenInbox?: (address: string) => void }) {
  const { locale, t } = useLocaleCopy();
  const [data, setData] = useState<AddressRecord[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [query, setQuery] = useState('');
  const [selectedUserFilter, setSelectedUserFilter] = useState<AddressUserFilter | null>(() => readStoredAddressUserFilter(userFilter));
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [usersTotal, setUsersTotal] = useState(userTotal);
  const [usersLoading, setUsersLoading] = useState(false);
  const [sortBy, setSortBy] = useState('id');
  const [sortOrder, setSortOrder] = useState<'ascend' | 'descend'>('descend');
  const [loading, setLoading] = useState(false);
  const [allAddressRows, setAllAddressRows] = useState<AddressRecord[]>([]);
  const [allAddressIndexReady, setAllAddressIndexReady] = useState(false);
  const [allAddressIndexComplete, setAllAddressIndexComplete] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newAddress, setNewAddress] = useState<NewAddressForm>(() => readStoredNewAddressDraft());
  const [fallbackOpenSettings, setFallbackOpenSettings] = useState<OpenSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsAttempted, setSettingsAttempted] = useState(false);
  const [workerAddressRegex, setWorkerAddressRegex] = useState<string | null | undefined>(undefined);
  const [workerConfigAttempted, setWorkerConfigAttempted] = useState(false);
  const [credential, setCredential] = useState<{ address: string; jwt: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<AddressRecord | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [selectedAddressMap, setSelectedAddressMap] = useState<Record<number, AddressRecord>>({});
  const [shareOpen, setShareOpen] = useState(false);
  const [shareExpiry, setShareExpiry] = useState<ShareExpiryOption>('30d');
  const [shareMailVisibility, setShareMailVisibility] = useState<ShareMailVisibility>('new');
  const [shareAllowHideMail, setShareAllowHideMail] = useState(true);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareResult, setShareResult] = useState<{ url: string; expiresAt?: string | null; addresses?: Array<{ id: string; address: string }> } | null>(null);
  const [shareManageOpen, setShareManageOpen] = useState(false);
  const [shareList, setShareList] = useState<ShareAdminRecord[]>([]);
  const shareListCursorRef = useRef<string | null>(null);
  const [shareListHasMore, setShareListHasMore] = useState(false);
  const [shareListLoading, setShareListLoading] = useState(false);
  const [shareListQuery, setShareListQuery] = useState('');
  const [shareStatusFilter, setShareStatusFilter] = useState<ShareStatusFilter>('all');
  const [shareActionBusy, setShareActionBusy] = useState<string | null>(null);
  const [shareEditTarget, setShareEditTarget] = useState<ShareAdminRecord | null>(null);
  const [shareEditExpiry, setShareEditExpiry] = useState<ShareExpiryOption>('30d');
  const [shareEditVisibility, setShareEditVisibility] = useState<ShareMailVisibility>('new');
  const [selectedShareMap, setSelectedShareMap] = useState<Record<string, ShareAdminRecord>>({});
  const [shareStatusNow, setShareStatusNow] = useState(() => Date.now());
  const [batchKeyword, setBatchKeyword] = useState('');
  const [batchScanRunning, setBatchScanRunning] = useState(false);
  const [batchScanProgress, setBatchScanProgress] = useState({ done: 0, total: 0, matched: 0 });
  const [mobileBulkSearchOpen, setMobileBulkSearchOpen] = useState(false);
  const [mobileBulkMenuOpen, setMobileBulkMenuOpen] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [mobileActionMenuId, setMobileActionMenuId] = useState<number | null>(null);
  const [desktopActionMenuId, setDesktopActionMenuId] = useState<number | null>(null);
  const [desktopActionMenu, setDesktopActionMenu] = useState<DesktopAddressActionMenu | null>(null);
  const [closingMobileActionMenuId, setClosingMobileActionMenuId] = useState<number | null>(null);
  const [senderPanelOpen, setSenderPanelOpen] = useState(false);
  const userDropdownRef = useRef<HTMLDivElement | null>(null);
  const mobileMenuCloseTimerRef = useRef<number | null>(null);
  const requestSeqRef = useRef(0);
  const batchScanAbortRef = useRef<AbortController | null>(null);
  const allAddressRowsRef = useRef<AddressRecord[]>([]);
  const allAddressIndexLoadingRef = useRef(false);
  const allAddressIndexReadyRef = useRef(false);
  const allAddressIndexCompleteRef = useRef(false);
  const manualQuery = (query || globalQuery).trim();
  const effectiveUserFilter = selectedUserFilter && selectedUserFilter.userId > 0 ? selectedUserFilter : null;
  const effectiveUserId = effectiveUserFilter?.userId || 0;
  const effectiveUserEmail = effectiveUserFilter?.userEmail || '';
  const effectiveQuery = manualQuery;
  const effectiveSettings = openSettings || fallbackOpenSettings;
  const domainOptions = useMemo(() => normalizeDomainOptions(effectiveSettings), [effectiveSettings]);
  const domainSelectOptions = useMemo(() => [
    { value: RANDOM_DOMAIN_VALUE, label: t('随机域名', 'Random domain'), description: t('提交前自动挑选', 'Pick automatically before submit') },
    ...domainOptions.map((domain) => ({ value: domain.value, label: domain.label })),
  ], [domainOptions, t]);
  const randomSubdomainDomains = useMemo(() => new Set((effectiveSettings?.randomSubdomainDomains || []).filter(Boolean)), [effectiveSettings]);
  const defaultDomain = useMemo(() => getDefaultDomainValue(effectiveSettings, domainOptions), [domainOptions, effectiveSettings]);
  const currentDomainAllowsRandomSubdomain = newAddress.domain === RANDOM_DOMAIN_VALUE
    ? randomSubdomainDomains.size > 0
    : randomSubdomainDomains.has(newAddress.domain);
  const previewPrefix = cleanCustomPrefix(newAddress.customPrefix);
  const previewInputName = cleanLocalPart(newAddress.name);
  const previewName = previewInputName ? cleanLocalPart(`${previewPrefix}${previewInputName}`) : `${previewPrefix || ''}${t('随机英数名', 'random name')}`;
  const previewDomain = newAddress.domain === RANDOM_DOMAIN_VALUE ? t('随机域名', 'Random domain') : newAddress.domain || defaultDomain || t('未配置域名', 'No domain configured');
  const effectiveAddressRegex = typeof workerAddressRegex === 'string'
    ? workerAddressRegex
    : typeof effectiveSettings?.addressRegex === 'string'
      ? effectiveSettings.addressRegex
      : '';
  const customPrefixHasSeparator = /[._-]/.test(previewPrefix);
  const backendKeepsCustomPrefixSeparators = addressRegexAllowsSeparators(effectiveAddressRegex);
  const shouldWarnPrefixSeparatorStrip = customPrefixHasSeparator && !backendKeepsCustomPrefixSeparators;
  const usersForFilter = useMemo(() => {
    if (!effectiveUserFilter || users.some((user) => user.id === effectiveUserFilter.userId)) return users;
    return [{ id: effectiveUserFilter.userId, user_email: effectiveUserFilter.userEmail, address_count: count } as UserRecord, ...users];
  }, [count, effectiveUserFilter, users]);
  const selectedUserRecord = effectiveUserId ? usersForFilter.find((user) => user.id === effectiveUserId) : null;
  const displayedUserTotal = Math.max(usersTotal || 0, userTotal || 0, users.length);
  const userTotalLabel = usersLoading && displayedUserTotal === 0 ? t('加载中', 'Loading') : displayedUserTotal > 0 ? (locale === 'en-US' ? `${displayedUserTotal} users` : `${displayedUserTotal} 个用户`) : t('全部用户', 'All users');
  const addressSortOptions = useMemo(() => [
    { value: 'id', label: 'ID' },
    { value: 'name', label: t('地址', 'Address') },
    { value: 'created_at', label: t('创建时间', 'Created') },
    { value: 'updated_at', label: t('更新时间', 'Updated') },
    { value: 'mail_count', label: t('收件数', 'Inbox') },
    { value: 'send_count', label: t('发件数', 'Sent') },
  ], [t]);
  const shareExpiryOptions = useMemo<Array<{ value: ShareExpiryOption; label: string; description?: string }>>(() => [
    { value: '1d', label: t('1 天', '1 day'), description: t('短期临时分享', 'Short temporary share') },
    { value: '7d', label: t('7 天', '7 days'), description: t('一周内有效', 'Valid for one week') },
    { value: '30d', label: t('30 天', '30 days'), description: t('默认推荐', 'Recommended default') },
    { value: 'forever', label: t('永久有效', 'Never expires'), description: t('不自动过期', 'Does not expire automatically') },
  ], [t]);
  const shareStatusFilterOptions = useMemo<Array<{ value: ShareStatusFilter; label: string; description?: string }>>(() => [
    { value: 'all', label: t('全部状态', 'All statuses'), description: t('实时显示当前已加载列表', 'Filters the loaded list instantly') },
    { value: 'active', label: t('有效', 'Active'), description: t('仍可访问的共享链接', 'Links that are still accessible') },
    { value: 'inactive', label: t('失效', 'Inactive'), description: t('包含已撤销和已过期', 'Includes revoked and expired links') },
  ], [t]);
  const shareVisibilityOptions = useMemo<Array<{ value: ShareMailVisibility; label: string; description?: string }>>(() => [
    { value: 'new', label: t('仅新增', 'New only'), description: t('从现在开始', 'From now on') },
    { value: 'all', label: t('包含历史', 'Include history'), description: t('显示已有邮件', 'Show existing mail') },
  ], [t]);
  const shareStatusText = useCallback((status: ShareStatus) => {
    if (status === 'revoked') return t('已撤销', 'Revoked');
    if (status === 'expired') return t('已失效', 'Expired');
    return t('有效', 'Active');
  }, [t]);
  const shareExpiryText = useCallback((expiresAt: string | null) => (expiresAt ? formatDateTime(expiresAt) : t('永久有效', 'Never expires')), [t]);
  const shareRemainingText = useCallback((row: ShareAdminRecord) => {
    const status = effectiveShareStatus(row, shareStatusNow);
    if (status === 'revoked') return t('已撤销', 'Revoked');
    if (status === 'expired') return t('已失效', 'Expired');
    if (!row.expiresAt) return t('永久有效', 'Never expires');
    const diffMs = Date.parse(row.expiresAt) - shareStatusNow;
    if (!Number.isFinite(diffMs) || diffMs <= 0) return t('已失效', 'Expired');
    const minutes = Math.max(1, Math.ceil(diffMs / 60000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    if (days > 0) return locale === 'en-US' ? `${days}d left` : `剩余 ${days} 天`;
    if (hours > 0) return locale === 'en-US' ? `${hours}h left` : `剩余 ${hours} 小时`;
    return locale === 'en-US' ? `${minutes}m left` : `剩余 ${minutes} 分钟`;
  }, [locale, shareStatusNow, t]);
  const shareMailboxCountText = useCallback((row: ShareAdminRecord) => {
    return locale === 'en-US'
      ? `${row.addressCount} mailbox${row.addressCount === 1 ? '' : 'es'}`
      : `${row.addressCount} 个邮箱`;
  }, [locale]);
  const listCacheKey = useMemo(() => `${STORAGE_KEYS.addressListCachePrefix}${page}:${pageSize}:user:${effectiveUserId}:${encodeURIComponent(effectiveUserEmail)}:${encodeURIComponent(manualQuery)}:${sortBy}:${sortOrder}`, [effectiveUserEmail, effectiveUserId, manualQuery, page, pageSize, sortBy, sortOrder]);
  const addressIndexCacheKey = useMemo(() => `${STORAGE_KEYS.addressListCachePrefix}index:${sortBy}:${sortOrder}`, [sortBy, sortOrder]);

  const applyAddressIndexSearch = useCallback((rows: AddressRecord[], searchText: string, targetPage = page) => {
    const search = normalizeSearch(searchText);
    const filtered = rows.filter((row) => !search || normalizeSearch(`${row.name} ${row.source_meta || ''} ${row.user_email || row.owner || ''} #${row.id}`).includes(search));
    const sorted = sortAddressRows(filtered, sortBy, sortOrder);
    const nextCount = sorted.length;
    const results = sorted.slice((targetPage - 1) * pageSize, targetPage * pageSize);
    setData(results);
    setCount(nextCount);
    writeJsonStorage(listCacheKey, { version: LIST_CACHE_VERSION, count: nextCount, savedAt: Date.now(), results });
  }, [listCacheKey, page, pageSize, sortBy, sortOrder]);

  const loadAllAddressIndex = useCallback(async (forceRefresh = false) => {
    if (allAddressIndexLoadingRef.current) return;
    if (!forceRefresh && allAddressIndexCompleteRef.current && allAddressRowsRef.current.length > 0) return;
    allAddressIndexLoadingRef.current = true;
    try {
      const merged: AddressRecord[] = [];
      let expectedCount = 0;
      let complete = false;
      for (let offset = 0; ; offset += ADDRESS_INDEX_PAGE_SIZE) {
        const res = await request<ListResponse<AddressRecord>>(`/admin/address${buildQuery({ limit: ADDRESS_INDEX_PAGE_SIZE, offset, sort_by: sortBy, sort_order: sortOrder })}`, {
          forceRefresh: forceRefresh && offset === 0,
          cacheTtlMs: CACHE_TTL.list,
        });
        const results = res.results || [];
        merged.push(...results);
        expectedCount = typeof res.count === 'number' ? res.count : merged.length;
        if (results.length === 0 || results.length < ADDRESS_INDEX_PAGE_SIZE || (expectedCount > 0 && merged.length >= expectedCount)) {
          complete = true;
          break;
        }
      }
      allAddressRowsRef.current = merged;
      allAddressIndexReadyRef.current = true;
      allAddressIndexCompleteRef.current = complete;
      setAllAddressRows(merged);
      setAllAddressIndexReady(true);
      setAllAddressIndexComplete(complete);
      writeJsonStorage(addressIndexCacheKey, { version: LIST_CACHE_VERSION, count: expectedCount || merged.length, savedAt: Date.now(), results: merged, complete });
    } catch {
      allAddressIndexReadyRef.current = false;
      allAddressIndexCompleteRef.current = false;
      setAllAddressIndexReady(false);
      setAllAddressIndexComplete(false);
    } finally {
      allAddressIndexLoadingRef.current = false;
    }
  }, [addressIndexCacheKey, request, sortBy, sortOrder]);

  const fetchData = useCallback(async (forceRefresh = false) => {
    const seq = ++requestSeqRef.current;
    const canUseAddressIndex = !effectiveUserFilter && Boolean(effectiveQuery) && allAddressRowsRef.current.length > 0;
    if (canUseAddressIndex && !forceRefresh) {
      // 先用本地索引即时响应输入，但不要把本地索引当作最终真相：
      // 地址很多时，历史缓存或未完成索引可能漏掉很早创建的地址。
      // 官方后台搜索以 /admin/address?query=... 为准，因此这里继续向后端发起权威搜索。
      applyAddressIndexSearch(allAddressRowsRef.current, effectiveQuery, page);
      void loadAllAddressIndex(false);
    }
    setLoading(true);
    try {
      let results: AddressRecord[] = [];
      let nextCount = 0;
      if (effectiveUserFilter) {
        const res = await request<{ results: BoundAddressRecord[] }>(`/admin/users/bind_address/${effectiveUserFilter.userId}`, { forceRefresh, cacheTtlMs: CACHE_TTL.list });
        if (seq !== requestSeqRef.current) return;
        const search = normalizeSearch(manualQuery);
        const filtered = (res.results || [])
          .map((row) => boundToAddressRecord(row, effectiveUserFilter))
          .filter((row) => !search || normalizeSearch(`${row.name} ${row.source_meta || ''} ${row.user_email || row.owner || ''}`).includes(search));
        const sorted = sortAddressRows(filtered, sortBy, sortOrder);
        nextCount = sorted.length;
        results = sorted.slice((page - 1) * pageSize, page * pageSize);
      } else {
        const res = await request<ListResponse<AddressRecord>>(`/admin/address${buildQuery({ limit: pageSize, offset: (page - 1) * pageSize, query: effectiveQuery, sort_by: sortBy, sort_order: sortOrder })}`, {
          forceRefresh: forceRefresh || Boolean(effectiveQuery),
          cacheTtlMs: CACHE_TTL.shortList,
        });
        if (seq !== requestSeqRef.current) return;
        results = res.results || [];
        nextCount = typeof res.count === 'number' ? res.count : results.length;
        const indexed = allAddressRowsRef.current;
        const merged = new Map(indexed.map((row) => [row.id, row]));
        results.forEach((row) => merged.set(row.id, row));
        const nextIndex = Array.from(merged.values());
        allAddressRowsRef.current = nextIndex;
        setAllAddressRows(nextIndex);
      }
      setData(results);
      setCount(nextCount);
      writeJsonStorage(listCacheKey, { version: LIST_CACHE_VERSION, count: nextCount, savedAt: Date.now(), results });
    } catch (error) {
      if (seq === requestSeqRef.current) notify('error', error instanceof Error ? error.message : t('地址列表加载失败', 'Failed to load addresses'));
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [applyAddressIndexSearch, effectiveQuery, effectiveUserFilter, listCacheKey, loadAllAddressIndex, manualQuery, notify, page, pageSize, request, sortBy, sortOrder]);

  useEffect(() => {
    const cached = readJsonStorage<CachedList<AddressRecord> | null>(listCacheKey, null);
    if (!cached || cached.version !== LIST_CACHE_VERSION || !Array.isArray(cached.results)) return;
    setData(cached.results);
    setCount(cached.count || cached.results.length);
  }, [listCacheKey]);
  useEffect(() => {
    const cached = readJsonStorage<CachedList<AddressRecord> | null>(addressIndexCacheKey, null);
    if (cached?.version === LIST_CACHE_VERSION && Array.isArray(cached.results) && cached.results.length > 0) {
      allAddressRowsRef.current = cached.results;
      allAddressIndexReadyRef.current = true;
      allAddressIndexCompleteRef.current = Boolean(cached.complete);
      setAllAddressRows(cached.results);
      setAllAddressIndexReady(true);
      setAllAddressIndexComplete(Boolean(cached.complete));
    } else {
      allAddressRowsRef.current = [];
      allAddressIndexReadyRef.current = false;
      allAddressIndexCompleteRef.current = false;
      setAllAddressRows([]);
      setAllAddressIndexReady(false);
      setAllAddressIndexComplete(false);
    }
    void loadAllAddressIndex(false);
  }, [addressIndexCacheKey, loadAllAddressIndex]);
  useEffect(() => {
    if (effectiveUserFilter || !manualQuery || allAddressRows.length === 0) return;
    applyAddressIndexSearch(allAddressRows, manualQuery, page);
  }, [allAddressRows, applyAddressIndexSearch, effectiveUserFilter, manualQuery, page]);
  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    if (userFilter === undefined) return;
    setSelectedUserFilter(userFilter || null);
    setPage(1);
  }, [userFilter?.requestId, userFilter?.userEmail, userFilter?.userId]);
  useEffect(() => {
    writeLocalStorage(STORAGE_KEYS.addressUserFilter, selectedUserFilter ? JSON.stringify(selectedUserFilter) : '');
  }, [selectedUserFilter]);
  useEffect(() => {
    const onGlobalRefresh = (event: Event) => {
      const targetMenu = (event as CustomEvent<{ menu?: string }>).detail?.menu;
      if (!targetMenu || targetMenu === 'address') fetchData(true);
    };
    window.addEventListener('loven7-global-refresh', onGlobalRefresh);
    return () => window.removeEventListener('loven7-global-refresh', onGlobalRefresh);
  }, [fetchData]);
  useEffect(() => {
    if (userTotal > usersTotal) setUsersTotal(userTotal);
  }, [userTotal, usersTotal]);
  useEffect(() => {
    if (!userDropdownOpen) return undefined;
    const closeOnOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && userDropdownRef.current?.contains(target)) return;
      setUserDropdownOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('touchstart', closeOnOutside, { passive: true });
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('touchstart', closeOnOutside);
    };
  }, [userDropdownOpen]);
  const closeMobileActionMenu = useCallback(() => {
    if (mobileMenuCloseTimerRef.current !== null) window.clearTimeout(mobileMenuCloseTimerRef.current);
    setMobileActionMenuId((current) => {
      if (current === null) return current;
      setClosingMobileActionMenuId(current);
      mobileMenuCloseTimerRef.current = window.setTimeout(() => {
        setClosingMobileActionMenuId(null);
        mobileMenuCloseTimerRef.current = null;
      }, 150);
      return null;
    });
  }, []);
  const closeDesktopActionMenu = useCallback(() => {
    setDesktopActionMenuId(null);
    setDesktopActionMenu(null);
  }, []);
  const toggleDesktopActionMenu = useCallback((row: AddressRecord, button: HTMLElement) => {
    setDesktopActionMenu((current) => {
      if (current?.row.id === row.id) {
        setDesktopActionMenuId(null);
        return null;
      }
      const rect = button.getBoundingClientRect();
      const menuWidth = 220;
      const menuHeight = 230;
      const margin = 12;
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const left = Math.max(viewportLeft + margin, Math.min(viewportLeft + viewportWidth - menuWidth - margin, rect.right - menuWidth));
      const hasDownSpace = rect.bottom + menuHeight + margin <= viewportTop + viewportHeight;
      const top = hasDownSpace
        ? Math.min(viewportTop + viewportHeight - menuHeight - margin, rect.bottom + 8)
        : Math.max(viewportTop + margin, rect.top - menuHeight - 8);
      setDesktopActionMenuId(row.id);
      return { row, top, left, placement: hasDownSpace ? 'down' : 'up' };
    });
  }, []);
  useEffect(() => {
    if (mobileActionMenuId === null) return undefined;
    const closeOnOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.mobile-address-menu-root')) return;
      closeMobileActionMenu();
    };
    const closeOnKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMobileActionMenu();
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('touchstart', closeOnOutside, { passive: true });
    document.addEventListener('keydown', closeOnKey);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('touchstart', closeOnOutside);
      document.removeEventListener('keydown', closeOnKey);
    };
  }, [closeMobileActionMenu, mobileActionMenuId]);
  useEffect(() => {
    if (!desktopActionMenu) return undefined;
    const closeOnOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.address-desktop-actions-root') || target?.closest('.address-floating-action-menu')) return;
      closeDesktopActionMenu();
    };
    const closeOnKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeDesktopActionMenu();
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('touchstart', closeOnOutside, { passive: true });
    document.addEventListener('keydown', closeOnKey);
    window.addEventListener('resize', closeDesktopActionMenu);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('touchstart', closeOnOutside);
      document.removeEventListener('keydown', closeOnKey);
      window.removeEventListener('resize', closeDesktopActionMenu);
    };
  }, [closeDesktopActionMenu, desktopActionMenu]);
  useEffect(() => () => {
    if (mobileMenuCloseTimerRef.current !== null) window.clearTimeout(mobileMenuCloseTimerRef.current);
  }, []);
  useEffect(() => {
    const cached = readJsonStorage<CachedUserOptions | null>(USER_OPTIONS_CACHE_KEY, null);
    if (cached?.version === USER_OPTIONS_CACHE_VERSION && Array.isArray(cached.users)) {
      const cachedCount = Math.max(Number(cached.count || 0), cached.users.length);
      if (cached.users.length > 0 || cachedCount === 0) {
        setUsers(cached.users);
        setUsersTotal(cachedCount);
      } else {
        setUsersTotal((current) => Math.max(current, cachedCount));
      }
    }
    let cancelled = false;
    setUsersLoading(true);
    loadAllUserOptions(request)
      .then(({ users: nextUsers, count: nextCount }) => {
        if (cancelled) return;
        setUsers(nextUsers);
        setUsersTotal(Math.max(nextCount || 0, nextUsers.length));
        writeJsonStorage(USER_OPTIONS_CACHE_KEY, { version: USER_OPTIONS_CACHE_VERSION, savedAt: Date.now(), count: Math.max(nextCount || 0, nextUsers.length), users: nextUsers });
      })
      .catch((error) => {
        if (!cancelled) notify('error', error instanceof Error ? (locale === 'en-US' ? `Failed to load user filter list: ${error.message}` : `用户筛选列表加载失败：${error.message}`) : t('用户筛选列表加载失败', 'Failed to load user filter list'));
      })
      .finally(() => { if (!cancelled) setUsersLoading(false); });
    return () => { cancelled = true; };
  }, [notify, request]);
  useEffect(() => {
    if (openSettings || fallbackOpenSettings || settingsLoading || settingsAttempted) return;
    setSettingsAttempted(true);
    setSettingsLoading(true);
    request<OpenSettings>('/open_api/settings', { cacheTtlMs: CACHE_TTL.settings })
      .then(setFallbackOpenSettings)
      .catch(() => undefined)
      .finally(() => setSettingsLoading(false));
  }, [fallbackOpenSettings, openSettings, request, settingsAttempted, settingsLoading]);
  useEffect(() => {
    if (!createOpen) return;
    setNewAddress((current) => {
      const domainValid = Boolean(current.domain) && (current.domain === RANDOM_DOMAIN_VALUE || domainOptions.some((item) => item.value === current.domain));
      const nextDomain = domainValid ? current.domain : defaultDomain;
      const nextAllowsRandomSubdomain = nextDomain === RANDOM_DOMAIN_VALUE ? randomSubdomainDomains.size > 0 : randomSubdomainDomains.has(nextDomain);
      const nextEnableRandomSubdomain = Boolean(current.enableRandomSubdomain && nextAllowsRandomSubdomain);
      if (nextDomain === current.domain && nextEnableRandomSubdomain === current.enableRandomSubdomain) return current;
      return { ...current, domain: nextDomain, enableRandomSubdomain: nextEnableRandomSubdomain };
    });
  }, [createOpen, defaultDomain, domainOptions, randomSubdomainDomains]);
  useEffect(() => {
    writeStoredNewAddressDraft(newAddress);
  }, [newAddress.customPrefix, newAddress.domain, newAddress.enablePrefix, newAddress.enableRandomSubdomain]);
  useEffect(() => {
    if (!createOpen || workerConfigAttempted) return;
    setWorkerConfigAttempted(true);
    request<Record<string, unknown>>('/admin/worker/configs', { cacheTtlMs: CACHE_TTL.settings })
      .then((res) => setWorkerAddressRegex(typeof res.ADDRESS_REGEX === 'string' ? res.ADDRESS_REGEX : ''))
      .catch(() => setWorkerAddressRegex(null));
  }, [createOpen, request, workerConfigAttempted]);
  useEffect(() => {
    if (data.length === 0) return;
    setSelectedAddressMap((current) => {
      let changed = false;
      const next = { ...current };
      for (const row of data) {
        if (next[row.id]) {
          next[row.id] = row;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [data]);

  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const selectedRows = useMemo<AddressRecord[]>(() => Object.values(selectedAddressMap as Record<string, AddressRecord>).sort((a, b) => Number(a.id) - Number(b.id)), [selectedAddressMap]);
  const selectedIds = useMemo(() => new Set(selectedRows.map((row) => row.id)), [selectedRows]);
  const selectedShares = useMemo<ShareAdminRecord[]>(() => Object.values(selectedShareMap as Record<string, ShareAdminRecord>).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [selectedShareMap]);
  const selectedShareTokens = useMemo(() => new Set(selectedShares.map((row) => row.token)), [selectedShares]);
  const visibleShareList = useMemo(() => {
    const localQuery = normalizeSearch(shareListQuery);
    return shareList.filter((row) => {
      const status = effectiveShareStatus(row, shareStatusNow);
      if (shareStatusFilter === 'active' && status !== 'active') return false;
      if (shareStatusFilter === 'inactive' && status === 'active') return false;
      if (!localQuery) return true;
      return shareSearchText(row).includes(localQuery);
    });
  }, [shareList, shareListQuery, shareStatusFilter, shareStatusNow]);
  const allVisibleSharesSelected = visibleShareList.length > 0 && visibleShareList.every((row) => selectedShareTokens.has(row.token));
  const allVisibleSelected = data.length > 0 && data.every((row) => selectedIds.has(row.id));
  useEffect(() => {
    if (selectedRows.length > 0) return;
    setMobileBulkMenuOpen(false);
    setMobileBulkSearchOpen(false);
  }, [selectedRows.length]);
  const pickUserFilter = (user: UserRecord | null) => {
    setSelectedUserFilter(user ? { userId: user.id, userEmail: user.user_email, requestId: Date.now() } : null);
    if (!user) onClearUserFilter?.();
    setPage(1);
    setUserDropdownOpen(false);
  };
  const toggleSelected = (row: AddressRecord) => setSelectedAddressMap((current) => {
    const next = { ...current };
    if (next[row.id]) delete next[row.id];
    else next[row.id] = row;
    return next;
  });
  const toggleSelectAll = () => setSelectedAddressMap((current) => {
    const next = { ...current };
    if (data.every((row) => Boolean(next[row.id]))) data.forEach((row) => { delete next[row.id]; });
    else data.forEach((row) => { next[row.id] = row; });
    return next;
  });
  const frontendBase = () => {
    const stored = readStorage(STORAGE_KEYS.frontendLoginBase, '').trim().replace(/\/+$/, '');
    const currentOrigin = typeof window !== 'undefined' ? window.location.origin.replace(/\/+$/, '') : '';
    const isLocalAdmin = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(currentOrigin);
    if (FRONTEND_LOGIN_BASE) return FRONTEND_LOGIN_BASE;
    if (stored && (stored !== currentOrigin || isLocalAdmin)) return stored;
    return isLocalAdmin ? currentOrigin : '';
  };
  const copyLoginUrl = async (row: AddressRecord) => {
    try {
      const res = await request<{ jwt: string }>(`/admin/show_password/${row.id}`, { forceRefresh: true });
      await copyText(buildAddressLoginUrl(res.jwt, frontendBase()));
      notify('success', locale === 'en-US' ? `Login link for ${row.name} copied` : `已复制 ${row.name} 的登录链接`);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('复制登录链接失败', 'Failed to copy login link'));
    }
  };
  const copyMailboxPassword = async (row: AddressRecord) => {
    try {
      const res = await request<{ jwt?: string; password?: string; credential?: string }>(`/admin/show_password/${row.id}`, { forceRefresh: true });
      const secret = String(res.password || res.credential || res.jwt || '').trim();
      if (!secret) throw new Error(t('接口没有返回可复制的邮箱密码/JWT', 'The API did not return a mailbox password/JWT to copy'));
      await copyText(secret);
      notify('success', res.password ? (locale === 'en-US' ? `Mailbox password for ${row.name} copied` : `已复制 ${row.name} 的邮箱密码`) : (locale === 'en-US' ? `Mailbox password/JWT for ${row.name} copied` : `已复制 ${row.name} 的邮箱密码/JWT`));
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('复制邮箱密码失败', 'Failed to copy mailbox password'));
    }
  };
  const shareAdminRequest = useCallback(async <T,>(path: string, init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {}): Promise<T> => {
    const base = frontendBase().replace(/\/+$/, '');
    if (!base) throw new Error(t('请先在系统设置里配置前端登录链接前缀', 'Configure the frontend login link prefix in Settings first'));
    const adminPassword = readStorage(STORAGE_KEYS.adminPassword, '');
    if (!adminPassword) throw new Error(t('请先登录管理员后台', 'Sign in to the admin console first'));
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-admin-auth': adminPassword,
    };
    const sitePassword = readStorage(STORAGE_KEYS.sitePassword, '');
    if (sitePassword) headers['x-custom-auth'] = sitePassword;
    const response = await fetch(`${base}/api/share/admin${path}`, {
      method: init.method || 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (!response.ok) throw new Error(data?.error?.message || data?.message || t('共享链接管理请求失败', 'Share-link management request failed'));
    return data as T;
  }, []);
  const loadShareList = useCallback(async (reset = true) => {
    setShareListLoading(true);
    try {
      const queryString = buildQuery({
        limit: 80,
        cursor: reset ? undefined : shareListCursorRef.current || undefined,
      });
      const res = await shareAdminRequest<ShareListResponse>(`/list${queryString}`);
      const rows = Array.isArray(res.results) ? res.results : [];
      let nextList: ShareAdminRecord[] = rows;
      setShareList((current) => {
        if (reset) {
          nextList = rows;
          return rows;
        }
        const merged = new Map<string, ShareAdminRecord>();
        current.forEach((row) => merged.set(row.token, row));
        rows.forEach((row) => merged.set(row.token, row));
        nextList = Array.from(merged.values());
        return nextList;
      });
      setSelectedShareMap((current) => {
        const next: Record<string, ShareAdminRecord> = {};
        for (const row of nextList) if (current[row.token]) next[row.token] = row;
        return next;
      });
      writeJsonStorage(SHARE_LIST_CACHE_KEY, { version: LIST_CACHE_VERSION, savedAt: Date.now(), results: nextList, cursor: res.cursor || null, hasMore: Boolean(res.hasMore && res.cursor) });
      shareListCursorRef.current = res.cursor || null;
      setShareListHasMore(Boolean(res.hasMore && res.cursor));
      setShareStatusNow(Date.now());
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('共享链接列表加载失败', 'Failed to load share links'));
    } finally {
      setShareListLoading(false);
    }
  }, [notify, shareAdminRequest]);
  const hydrateShareListCache = () => {
    const cached = readJsonStorage<{ version: number; results?: ShareAdminRecord[]; cursor?: string | null; hasMore?: boolean } | null>(SHARE_LIST_CACHE_KEY, null);
    if (cached?.version === LIST_CACHE_VERSION && Array.isArray(cached.results)) {
      setShareList(cached.results);
      shareListCursorRef.current = cached.cursor || null;
      setShareListHasMore(Boolean(cached.hasMore));
    }
  };
  const openShareManager = () => {
    hydrateShareListCache();
    setShareStatusNow(Date.now());
    setShareManageOpen(true);
  };
  useEffect(() => {
    if (!shareManageOpen) return undefined;
    void loadShareList(true);
    const timer = window.setInterval(() => setShareStatusNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, [loadShareList, shareManageOpen]);
  const toggleShareSelected = (row: ShareAdminRecord) => setSelectedShareMap((current) => {
    const next = { ...current };
    if (next[row.token]) delete next[row.token];
    else next[row.token] = row;
    return next;
  });
  const toggleAllVisibleShares = () => setSelectedShareMap((current) => {
    const next = { ...current };
    if (allVisibleSharesSelected) visibleShareList.forEach((row) => { delete next[row.token]; });
    else visibleShareList.forEach((row) => { next[row.token] = row; });
    return next;
  });
  const copySelectedShareUrls = async () => {
    if (selectedShares.length === 0) return;
    await copyText(selectedShares.map((row) => row.url).join('\n'));
    notify('success', locale === 'en-US' ? `${selectedShares.length} share link${selectedShares.length === 1 ? '' : 's'} copied` : `已复制 ${selectedShares.length} 条共享链接`);
  };
  const runShareBatch = async (action: 'revoke' | 'restore' | 'update' | 'refresh-index', body: Record<string, unknown> = {}) => {
    if (selectedShares.length === 0) return;
    setShareActionBusy(`batch:${action}`);
    try {
      const res = await shareAdminRequest<{ results?: ShareAdminRecord[]; failures?: Array<{ token: string; message: string }> }>('/batch', {
        method: 'POST',
        body: { action, tokens: selectedShares.map((row) => row.token), ...body },
      });
      const rows = Array.isArray(res.results) ? res.results : [];
      if (rows.length) {
        setShareList((current) => current.map((row) => rows.find((item) => item.token === row.token) || row));
        setSelectedShareMap({});
      }
      const failures = Array.isArray(res.failures) ? res.failures : [];
      notify(failures.length ? 'error' : 'success', failures.length ? (locale === 'en-US' ? `Completed ${rows.length}, failed ${failures.length}` : `完成 ${rows.length} 条，失败 ${failures.length} 条`) : (locale === 'en-US' ? `Batch completed: ${rows.length}` : `批量操作完成：${rows.length} 条`));
      await loadShareList(true);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('批量操作失败', 'Batch operation failed'));
    } finally {
      setShareActionBusy(null);
    }
  };
  const copyShareUrl = async (url: string) => {
    try {
      await copyText(url);
      notify('success', t('已复制共享链接', 'Share link copied'));
    } catch {
      notify('error', t('复制失败', 'Copy failed'));
    }
  };
  const updateShareExpiry = async () => {
    if (!shareEditTarget) return;
    setShareActionBusy(`update:${shareEditTarget.token}`);
    try {
      const res = await shareAdminRequest<{ share?: ShareAdminRecord }>(`/${encodeURIComponent(shareEditTarget.token)}`, {
        method: 'PATCH',
        body: { expiresIn: shareEditExpiry, restore: shareEditTarget.status === 'revoked', mailVisibility: shareEditVisibility, resetSince: shareEditVisibility === 'new' },
      });
      if (res.share) {
        setShareList((current) => current.map((row) => (row.token === res.share?.token ? res.share : row)));
        setShareEditTarget(res.share);
        setShareEditVisibility(res.share.mailVisibility || 'all');
      }
      notify('success', t('共享链接有效期已更新', 'Share link settings updated'));
      setShareEditTarget(null);
      await loadShareList(true);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('更新共享链接失败', 'Failed to update share link'));
    } finally {
      setShareActionBusy(null);
    }
  };
  const revokeShareLink = (row: ShareAdminRecord) => ask({
    title: t('撤销共享链接', 'Revoke share link'),
    body: locale === 'en-US' ? `External users will no longer be able to access this share link, but the record stays in the management list. It contains ${row.addressCount} mailbox${row.addressCount === 1 ? '' : 'es'}.` : `撤销后外部用户将无法继续访问该共享链接，但管理列表会保留记录。包含 ${row.addressCount} 个邮箱。`,
    actionLabel: t('撤销', 'Revoke'),
    onConfirm: async () => {
      setShareActionBusy(`revoke:${row.token}`);
      try {
        const res = await shareAdminRequest<{ share?: ShareAdminRecord }>(`/${encodeURIComponent(row.token)}`, { method: 'DELETE' });
        if (res.share) setShareList((current) => current.map((item) => (item.token === res.share?.token ? res.share : item)));
        notify('success', t('共享链接已撤销', 'Share link revoked'));
      } catch (error) {
        notify('error', error instanceof Error ? error.message : t('撤销失败', 'Revoke failed'));
      } finally {
        setShareActionBusy(null);
      }
    },
  });
  const openShareDialog = () => {
    setShareResult(null);
    setShareExpiry('30d');
    setShareMailVisibility('new');
    setShareAllowHideMail(true);
    setShareOpen(true);
  };
  const createShareForRows = async (rows: AddressRecord[], expiresIn: ShareExpiryOption, busyKey = 'bulk', visibility: ShareMailVisibility = shareMailVisibility) => {
    if (rows.length === 0) {
      notify('error', t('请先勾选要共享的邮箱', 'Select mailboxes to share first'));
      return null;
    }
    const base = frontendBase().replace(/\/+$/, '');
    if (!base) {
      notify('error', t('请先在系统设置里配置前端登录链接前缀', 'Configure the frontend login link prefix in Settings first'));
      return null;
    }
    const adminPassword = readStorage(STORAGE_KEYS.adminPassword, '');
    if (!adminPassword) {
      notify('error', t('请先登录管理员后台，再创建共享链接', 'Sign in to the admin console before creating a share link'));
      return null;
    }
    if (busyKey === 'bulk') setShareBusy(true);
    else setShareActionBusy(busyKey);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-admin-auth': adminPassword,
      };
      const sitePassword = readStorage(STORAGE_KEYS.sitePassword, '');
      if (sitePassword) headers['x-custom-auth'] = sitePassword;
      const response = await fetch(`${base}/api/share`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ addressIds: rows.map((row) => row.id), expiresIn, mailVisibility: visibility, permissions: { hideMail: shareAllowHideMail } }),
      });
      const text = await response.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
      if (!response.ok) throw new Error(data?.error?.message || data?.message || t('创建共享链接失败', 'Failed to create share link'));
      const result = { url: String(data.url || ''), expiresAt: data.expiresAt ?? null, addresses: Array.isArray(data.addresses) ? data.addresses : [] };
      if (!result.url) throw new Error(t('共享接口没有返回链接', 'Share API did not return a link'));
      setShareResult(result);
      await copyText(result.url);
      notify('success', rows.length === 1 ? (locale === 'en-US' ? `Revocable share link for ${rows[0].name} created and copied` : `已创建并复制 ${rows[0].name} 的可撤回分享链接`) : (locale === 'en-US' ? `Share link created and copied, containing ${result.addresses.length || rows.length} mailboxes` : `共享链接已创建并复制，包含 ${result.addresses.length || rows.length} 个邮箱`));
      if (shareManageOpen) void loadShareList(true);
      return result;
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('创建共享链接失败', 'Failed to create share link'));
      return null;
    } finally {
      if (busyKey === 'bulk') setShareBusy(false);
      else setShareActionBusy(null);
    }
  };
  const createShareLink = async () => {
    await createShareForRows(selectedRows, shareExpiry, 'bulk');
  };
  const createSingleShareLink = async (row: AddressRecord) => {
    await createShareForRows([row], '30d', `create:${row.id}`, 'new');
  };
  const runBatch = async (label: string, urlOf: (row: AddressRecord) => string) => {
    let ok = 0;
    const failures: string[] = [];
    for (const row of selectedRows) {
      try {
        await request(urlOf(row), { method: 'DELETE' });
        ok += 1;
      } catch (error) {
        failures.push(`${row.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length === 0) notify('success', locale === 'en-US' ? `${label}: ${ok} completed` : `${label}：${ok} 个全部完成`);
    else notify('error', locale === 'en-US' ? `${label}: ${ok} succeeded, ${failures.length} failed — ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '…' : ''}` : `${label}：成功 ${ok}、失败 ${failures.length} — ${failures.slice(0, 3).join('；')}${failures.length > 3 ? '…' : ''}`);
    setSelectedAddressMap({});
    await fetchData();
  };
  const batchClearInbox = () => ask({ title: locale === 'en-US' ? `Clear inbox for ${selectedRows.length} addresses` : `清空 ${selectedRows.length} 个地址的收件箱`, body: t('将对已勾选地址逐个执行清空收件箱。', 'This clears the inbox for each selected address.'), actionLabel: t('清空收件', 'Clear inbox'), onConfirm: () => runBatch(t('清空收件箱', 'Clear inbox'), (row) => `/admin/clear_inbox/${row.id}`) });
  const batchClearSent = () => ask({ title: locale === 'en-US' ? `Clear sent mail for ${selectedRows.length} addresses` : `清空 ${selectedRows.length} 个地址的发件箱`, body: t('将对已勾选地址逐个执行清空发件箱。', 'This clears sent mail for each selected address.'), actionLabel: t('清空发件', 'Clear sent'), onConfirm: () => runBatch(t('清空发件箱', 'Clear sent'), (row) => `/admin/clear_sent_items/${row.id}`) });
  const batchDelete = () => ask({ title: locale === 'en-US' ? `Delete ${selectedRows.length} addresses` : `删除 ${selectedRows.length} 个地址`, body: t('会删除勾选地址及关联邮件、发件权限和用户绑定。', 'This deletes selected addresses and their related mail, sender access, and user bindings.'), actionLabel: t('删除', 'Delete'), onConfirm: () => runBatch(t('批量删除', 'Batch delete'), (row) => `/admin/delete_address/${row.id}`) });
  const addressHasMailKeyword = async (row: AddressRecord, normalizedKeyword: string, signal: AbortSignal): Promise<boolean> => {
    let offset = 0;
    let expectedCount = Number(row.mail_count || 0);
    while (!signal.aborted) {
      const res = await request<ListResponse<RawMailRecord>>(`/admin/mails${buildQuery({ limit: BATCH_MAIL_SCAN_PAGE_SIZE, offset, address: row.name })}`, {
        forceRefresh: true,
        skipCache: true,
        signal,
        timeoutMs: 35_000,
      });
      const results = res.results || [];
      if (typeof res.count === 'number' && res.count >= 0) expectedCount = Math.max(expectedCount, res.count);
      if (results.some((item) => buildBatchMailHaystack(item).includes(normalizedKeyword))) return true;
      if (results.length < BATCH_MAIL_SCAN_PAGE_SIZE) return false;
      offset += results.length;
      if (expectedCount > 0 && offset >= expectedCount) return false;
    }
    return false;
  };
  const cancelBatchScan = () => {
    batchScanAbortRef.current?.abort();
    batchScanAbortRef.current = null;
    setBatchScanRunning(false);
    notify('info', t('已取消批量检测', 'Batch detection cancelled'));
  };
  const batchFilterSelectedByMailKeyword = async () => {
    const normalizedKeyword = normalizeBatchMailSearch(batchKeyword);
    if (!normalizedKeyword) {
      notify('error', t('请先输入要检测的邮件关键词', 'Enter a mail keyword to detect first'));
      return;
    }
    if (selectedRows.length === 0 || batchScanRunning) return;
    const scanRows = [...selectedRows];
    const abortController = new AbortController();
    batchScanAbortRef.current = abortController;
    setBatchScanRunning(true);
    setBatchScanProgress({ done: 0, total: scanRows.length, matched: 0 });
    const matchedRows: AddressRecord[] = [];
    const failures: string[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < scanRows.length && !abortController.signal.aborted) {
        const row = scanRows[cursor];
        cursor += 1;
        try {
          const matched = await addressHasMailKeyword(row, normalizedKeyword, abortController.signal);
          if (matched) matchedRows.push(row);
        } catch (error) {
          if (!abortController.signal.aborted) failures.push(`${row.name}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setBatchScanProgress((current) => ({
            done: Math.min(current.done + 1, scanRows.length),
            total: scanRows.length,
            matched: matchedRows.length,
          }));
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(BATCH_MAIL_SCAN_CONCURRENCY, scanRows.length) }, () => worker()));
      if (abortController.signal.aborted) return;
      const nextMap: Record<number, AddressRecord> = {};
      matchedRows.forEach((row) => { nextMap[row.id] = row; });
      setSelectedAddressMap(nextMap);
      if (matchedRows.length === 0) notify('info', locale === 'en-US' ? `Scan complete: no matches in ${scanRows.length} addresses; selection cleared` : `检测完成：${scanRows.length} 个地址中没有匹配，已清空选择`);
      else if (failures.length > 0) notify('error', locale === 'en-US' ? `Scan complete and reselected ${matchedRows.length}; ${failures.length} failed: ${failures.slice(0, 2).join('; ')}${failures.length > 2 ? '…' : ''}` : `检测完成并已重选 ${matchedRows.length} 个；另有 ${failures.length} 个检测失败：${failures.slice(0, 2).join('；')}${failures.length > 2 ? '…' : ''}`);
      else notify('success', locale === 'en-US' ? `Scan complete: ${matchedRows.length} of ${scanRows.length} matched and reselected` : `检测完成：${scanRows.length} 个中匹配 ${matchedRows.length} 个，已自动重选`);
    } finally {
      if (batchScanAbortRef.current === abortController) batchScanAbortRef.current = null;
      if (!abortController.signal.aborted) setBatchScanRunning(false);
    }
  };
  const pickCreateDomain = (enableRandomSubdomain: boolean): string => {
    if (newAddress.domain && newAddress.domain !== RANDOM_DOMAIN_VALUE) return newAddress.domain;
    const available = domainOptions.map((item) => item.value);
    const pool = enableRandomSubdomain ? available.filter((domain) => randomSubdomainDomains.has(domain)) : available;
    return pickRandom(pool.length ? pool : available);
  };
  const createAddress = async () => {
    const requestedRandomSubdomain = Boolean(newAddress.enableRandomSubdomain && currentDomainAllowsRandomSubdomain);
    const selectedDomain = pickCreateDomain(requestedRandomSubdomain);
    if (!selectedDomain) {
      notify('error', t('没有可用域名，请检查 /open_api/settings 的 domains 配置', 'No domains are available. Check the domains config from /open_api/settings.'));
      return;
    }
    const typedName = cleanLocalPart(newAddress.name);
    const manualName = typedName ? cleanLocalPart(`${newAddress.customPrefix}${typedName}`) : '';
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const name = attempt === 0 && manualName ? manualName : makeRealisticMailboxName(effectiveSettings, newAddress.customPrefix);
      try {
        const res = await request<{ address: string; jwt: string; address_id: number }>('/admin/new_address', {
          method: 'POST',
          body: {
            name,
            domain: selectedDomain,
            enablePrefix: newAddress.enablePrefix,
            enableRandomSubdomain: requestedRandomSubdomain,
          },
        });
        notify('success', locale === 'en-US' ? `Created ${res.address}` : `已创建 ${res.address}`);
        setCredential({ address: res.address, jwt: res.jwt });
        setCreateOpen(false);
        setNewAddress((current) => ({ ...current, name: '' }));
        await fetchData();
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const duplicate = /already|exists|unique|重复|存在|已被/i.test(message);
        if (!duplicate || attempt === 2) break;
      }
    }
    notify('error', lastError instanceof Error ? lastError.message : t('创建失败', 'Create failed'));
  };
  const showJwt = async (row: AddressRecord) => {
    try {
      const res = await request<{ jwt: string }>(`/admin/show_password/${row.id}`);
      setCredential({ address: row.name, jwt: res.jwt });
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('获取 JWT 失败', 'Failed to get JWT'));
    }
  };
  const actionDelete = (row: AddressRecord) => ask({ title: locale === 'en-US' ? `Delete address ${row.name}` : `删除地址 ${row.name}`, body: t('会同时删除该地址关联邮件、发件权限和用户绑定。', 'This also deletes related mail, sender access, and user bindings for this address.'), actionLabel: t('删除', 'Delete'), onConfirm: async () => { await request(`/admin/delete_address/${row.id}`, { method: 'DELETE' }); notify('success', t('地址已删除', 'Address deleted')); await fetchData(); } });
  const actionClearInbox = (row: AddressRecord) => ask({ title: locale === 'en-US' ? `Clear inbox for ${row.name}` : `清空 ${row.name} 收件箱`, body: t('将删除该地址全部收件。', 'This deletes all inbox mail for this address.'), actionLabel: t('清空', 'Clear'), onConfirm: async () => { await request(`/admin/clear_inbox/${row.id}`, { method: 'DELETE' }); notify('success', t('收件箱已清空', 'Inbox cleared')); await fetchData(); } });
  const actionClearSent = (row: AddressRecord) => ask({ title: locale === 'en-US' ? `Clear sent mail for ${row.name}` : `清空 ${row.name} 发件箱`, body: t('将删除该地址全部发件记录。', 'This deletes all sent-mail records for this address.'), actionLabel: t('清空', 'Clear'), onConfirm: async () => { await request(`/admin/clear_sent_items/${row.id}`, { method: 'DELETE' }); notify('success', t('发件箱已清空', 'Sent mail cleared')); await fetchData(); } });
  const copyAddressValue = async (value: string, label: string) => {
    try {
      await copyText(value);
      notify('success', label);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('复制失败，请手动复制', 'Copy failed. Please copy manually.'));
    }
  };
  const renderMobileAddressCard = (row: AddressRecord) => {
    const menuOpen = mobileActionMenuId === row.id;
    const menuClosing = closingMobileActionMenuId === row.id;
    const menuVisible = menuOpen || menuClosing;
    const runMobileAction = (action: () => void | Promise<void>) => {
      closeMobileActionMenu();
      void action();
    };
    return (
      <article key={row.id} className="mobile-address-card">
        <div className="mobile-address-head">
          <div className="min-w-0">
            <button className="address-strong block max-w-full truncate text-left" onClick={() => copyAddressValue(row.name, t("已复制邮箱地址", "Mailbox address copied"))} title={t("点击复制邮箱地址", "Copy mailbox address")}>{row.name}</button>
            <p className="mobile-address-meta">
              <span>#{row.id}</span>
              {(row.user_email || row.owner) && <span>{row.user_email || row.owner}</span>}
              {row.source_meta && <span>{row.source_meta}</span>}
            </p>
          </div>
          <div className="mobile-address-menu-root">
            <input className="row-check" type="checkbox" checked={selectedIds.has(row.id)} onChange={() => toggleSelected(row)} aria-label={locale === 'en-US' ? `Select ${row.name}` : `选择 ${row.name}`} />
            <button
              type="button"
              className={cls('mobile-address-more', menuOpen && 'active')}
              onClick={(event) => {
                event.stopPropagation();
                if (menuOpen) closeMobileActionMenu();
                else {
                  if (mobileMenuCloseTimerRef.current !== null) window.clearTimeout(mobileMenuCloseTimerRef.current);
                  setClosingMobileActionMenuId(null);
                  setMobileActionMenuId(row.id);
                }
              }}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t(`${row.name} 更多操作`, `${row.name} more actions`)}
              title={t("更多操作", "More actions")}
            >
              <MoreHorizontal size={18} />
            </button>
            {menuVisible && (
              <div className={cls('mobile-address-action-menu', menuClosing && 'is-closing')} role="menu">
                <button role="menuitem" onClick={() => runMobileAction(() => copyLoginUrl(row))}><Copy size={15} />{t("复制登录链接", "Copy login link")}</button>
                <button role="menuitem" onClick={() => runMobileAction(() => copyMailboxPassword(row))}><KeyRound size={15} />{t("复制邮箱密码/JWT", "Copy mailbox password/JWT")}</button>
                <button role="menuitem" onClick={() => runMobileAction(() => onOpenInbox?.(row.name))}><MailOpen size={15} />{t("查看收件箱", "View inbox")}</button>
                <button role="menuitem" disabled={shareActionBusy === `create:${row.id}`} onClick={() => runMobileAction(() => createSingleShareLink(row))}><Share2 size={15} className={cls(shareActionBusy === `create:${row.id}` && 'animate-pulse')} />{t("创建分享", "Create share")}</button>
                <button role="menuitem" onClick={() => runMobileAction(() => { setResetTarget(row); setResetPassword(''); })}><Lock size={15} />{t("重置密码", "Reset password")}</button>
                <button role="menuitem" onClick={() => runMobileAction(() => actionClearInbox(row))}><Inbox size={15} />{t("清空收件", "Clear inbox")}</button>
                <button role="menuitem" onClick={() => runMobileAction(() => actionClearSent(row))}><Send size={15} />{t("清空发件", "Clear sent")}</button>
                <button role="menuitem" className="danger" onClick={() => runMobileAction(() => actionDelete(row))}><Trash2 size={15} />{t("删除地址", "Delete address")}</button>
              </div>
            )}
          </div>
        </div>
        <div className="mobile-address-stats">
          <span>{t("收件", "In")} <strong>{row.mail_count ?? 0}</strong></span>
          <span>{t("发件", "Out")} <strong>{row.send_count ?? 0}</strong></span>
          <span className="truncate">{formatDateTime(row.updated_at || row.created_at)}</span>
        </div>
      </article>
    );
  };

  const credentialLoginUrl = credential ? buildAddressLoginUrl(credential.jwt, frontendBase()) : '';

  return (
    <div className="address-view-shell h-full space-y-4 overflow-y-auto p-3 md:p-4 xl:p-6" onScrollCapture={() => { closeMobileActionMenu(); closeDesktopActionMenu(); }}>
      <div className="address-page-head flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div className="address-page-title">
          <h2 className="text-2xl font-bold text-slate-800">{t("地址管理", "Address management")}</h2>
          <p className="mt-1 text-sm text-slate-400">{t("创建、搜索、复制登录链接、批量管理收件箱/发件箱和删除地址。", "Create, search, copy login links, batch-manage inbox/sent, and delete addresses.")}</p>
          {effectiveUserFilter && <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600">{t('正在筛选用户：', 'Filtering user: ')}{effectiveUserEmail}<button onClick={() => { setSelectedUserFilter(null); onClearUserFilter?.(); setPage(1); }} className="text-slate-400 hover:text-slate-900">{t('清除', 'Clear')}</button></div>}
        </div>
        <div className="address-page-actions flex flex-wrap gap-2"><button className="btn-primary" onClick={() => { setNewAddress((current) => ({ ...current, domain: current.domain || defaultDomain })); setCreateOpen(true); }}><Plus size={16} /> <span>{t("新建地址", "New address")}</span></button><button className="btn-secondary" onClick={openShareManager}><Share2 size={16} /> <span>{t("共享链接管理", "Share links")}</span></button><button className="btn-secondary" onClick={() => fetchData(true)}><RefreshCw size={15} className={cls(loading && data.length > 0 && 'animate-spin')} /> <span>{t("刷新", "Refresh")}</span></button></div>
      </div>

      <div className={cls('panel overflow-hidden', desktopActionMenuId !== null && 'address-panel-menu-open')}>
        <div className="address-toolbar">
          <div className="user-filter-dropdown" ref={userDropdownRef}>
            <button
              type="button"
              className={cls('toolbar-field user-filter-trigger', userDropdownOpen && 'is-open')}
              onClick={() => setUserDropdownOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={userDropdownOpen}
              title={t("按用户筛选地址", "Filter addresses by user")}
            >
              <UserRound size={15} className="toolbar-icon" />
              <span className="user-filter-copy">
                <span className="user-filter-label">{selectedUserRecord?.user_email || effectiveUserEmail || t('全部用户', 'All users')}</span>
                <span className="user-filter-count">{effectiveUserFilter ? locale === 'en-US' ? `${selectedUserRecord?.address_count ?? count ?? 0} addresses` : `${selectedUserRecord?.address_count ?? count ?? 0} 个地址` : userTotalLabel}</span>
              </span>
              <ChevronDown size={15} className={cls('user-filter-chevron', userDropdownOpen && 'rotate-180')} />
            </button>
            {effectiveUserFilter && (
              <button type="button" className="user-filter-clear" onClick={() => pickUserFilter(null)} aria-label={t("清除用户筛选", "Clear user filter")} title={t("清除用户筛选", "Clear user filter")}>
                <X size={13} />
              </button>
            )}
            {userDropdownOpen && (
              <div className="user-filter-menu" role="listbox">
                <button type="button" className={cls('user-filter-option', !effectiveUserId && 'active')} onClick={() => pickUserFilter(null)}>
                  <span className="user-filter-option-main">
                    <strong>{t("全部用户", "All users")}</strong>
                    <small>{t("显示所有地址", "Show all addresses")}</small>
                  </span>
                  <span className="user-filter-option-count">{userTotalLabel}</span>
                </button>
                {usersLoading && usersForFilter.length === 0 ? (
                  <div className="user-filter-empty">{t("正在加载用户...", "Loading users...")}</div>
                ) : usersForFilter.length === 0 ? (
                  <div className="user-filter-empty">{t("暂无用户", "No users")}</div>
                ) : usersForFilter.map((user) => (
                  <button key={user.id || user.user_email} type="button" className={cls('user-filter-option', effectiveUserId === user.id && 'active')} onClick={() => pickUserFilter(user)} role="option" aria-selected={effectiveUserId === user.id}>
                    <span className="user-filter-option-main">
                      <strong>{user.user_email}</strong>
                      <small>{t("用户 ID", "User ID")} #{user.id}</small>
                    </span>
                    <span className="user-filter-option-count">{locale === 'en-US' ? `${Number(user.address_count ?? 0)} addresses` : `${Number(user.address_count ?? 0)} 个地址`}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <label className="toolbar-field address-search-field" aria-label={t("搜索地址", "Search addresses")}>
            <Search size={15} className="toolbar-icon" />
            <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder={t("搜索地址", "Search addresses")} />
            {query && (
              <button
                type="button"
                className="address-search-clear"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { setQuery(''); setPage(1); }}
                aria-label={t("清空地址搜索", "Clear address search")}
                title={t("清空地址搜索", "Clear address search")}
              >
                <X size={13} />
              </button>
            )}
          </label>
          <PopoverSelect className="address-sort-select" ariaLabel={t("地址排序字段", "Address sort field")} value={sortBy} options={addressSortOptions} onChange={setSortBy} />
          <button className="btn-secondary compact toolbar-action sort-order-action" title={sortOrder === 'ascend' ? t('当前升序，点击切换', 'Currently ascending. Click to toggle.') : t('当前降序，点击切换', 'Currently descending. Click to toggle.')} onClick={() => setSortOrder(sortOrder === 'ascend' ? 'descend' : 'ascend')}><ListFilter size={15} /> <span>{sortOrder === 'ascend' ? t('升序', 'Asc') : t('降序', 'Desc')}</span></button>
          <button className="btn-secondary compact toolbar-action address-toolbar-refresh" title={t("刷新地址列表", "Refresh address list")} aria-label={t("刷新地址列表", "Refresh address list")} onClick={() => fetchData(true)}><RefreshCw size={15} className={cls((loading || usersLoading) && data.length > 0 && 'animate-spin')} /> <span>{t("刷新", "Refresh")}</span></button>
        </div>
        {selectedRows.length > 0 && (
          <div className={cls('address-bulk-bar', mobileBulkMenuOpen && 'mobile-expanded')}>
            <button
              type="button"
              className="mobile-bulk-fab"
              onClick={() => setMobileBulkMenuOpen((open) => !open)}
              aria-expanded={mobileBulkMenuOpen}
              aria-label={locale === 'en-US' ? `${selectedRows.length} addresses selected, expand batch actions` : `已选择 ${selectedRows.length} 个地址，展开批量操作`}
            >
              <span className="mobile-bulk-count">{selectedRows.length}</span>
              <MoreHorizontal size={17} />
            </button>
            <div className="address-bulk-menu-surface">
              <div className="address-bulk-summary">
                <strong>{locale === 'en-US' ? `${selectedRows.length} addresses selected` : `已选择 ${selectedRows.length} 个地址`}</strong>
                <span>{t('在已选地址内自动分页检测收件主题/正文，命中后自动重选。', 'Scan selected mailboxes by subject/body and reselect matches automatically.')}</span>
              </div>
              <button type="button" className="mobile-bulk-search-toggle" onClick={() => setMobileBulkSearchOpen((open) => !open)}>
                <Search size={14} /> {mobileBulkSearchOpen || batchKeyword ? t('收起检测', 'Hide scan') : t('搜索检测', 'Search scan')}
              </button>
              <label className={cls('address-bulk-search', mobileBulkSearchOpen && 'is-open', batchKeyword && 'has-value')} aria-label={t('检测已选地址中的邮件关键词', 'Detect mail keywords in selected addresses')}>
                <Search size={14} />
                <input
                  value={batchKeyword}
                  onChange={(event) => setBatchKeyword(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') batchFilterSelectedByMailKeyword(); }}
                  placeholder={t('搜索已选邮箱的主题 / 正文', 'Search selected mailboxes by subject / body')}
                  disabled={batchScanRunning}
                />
                {batchKeyword && !batchScanRunning && <button type="button" onClick={() => setBatchKeyword('')} aria-label={t('清空关键词', 'Clear keyword')}><X size={13} /></button>}
              </label>
              {batchScanRunning && (
                <span className="address-bulk-progress">
                  {locale === 'en-US' ? `Scanning ${batchScanProgress.done}/${batchScanProgress.total} · ${batchScanProgress.matched} matched` : `检测中 ${batchScanProgress.done}/${batchScanProgress.total} · 命中 ${batchScanProgress.matched}`}
                </span>
              )}
              <div className="address-bulk-actions">
                <button className="btn-secondary compact" disabled={batchScanRunning || !batchKeyword.trim()} onClick={batchFilterSelectedByMailKeyword}>
                  <Search size={15} /> {t('检测并重选', 'Scan and reselect')}
                </button>
                {batchScanRunning && <button className="btn-secondary compact" onClick={cancelBatchScan}><X size={15} /> {t('取消', 'Cancel')}</button>}
                <button className="btn-secondary compact" disabled={batchScanRunning} onClick={openShareDialog}><Share2 size={15} /> {t('创建共享链接', 'Create share link')}</button>
                <button className="btn-secondary compact" disabled={batchScanRunning} onClick={openShareManager}><ListFilter size={15} /> {t('管理共享', 'Manage shares')}</button>
                <button className="btn-secondary compact" disabled={batchScanRunning} onClick={batchClearInbox}><Inbox size={15} /> {t('清空收件', 'Clear inbox')}</button>
                <button className="btn-secondary compact" disabled={batchScanRunning} onClick={batchClearSent}><Send size={15} /> {t('清空发件', 'Clear sent')}</button>
                <button className="btn-danger compact" disabled={batchScanRunning} onClick={batchDelete}><Trash2 size={15} /> {t('删除', 'Delete')}</button>
                <button className="btn-secondary compact mobile-bulk-clear" disabled={batchScanRunning} onClick={() => { setSelectedAddressMap({}); setMobileBulkMenuOpen(false); setMobileBulkSearchOpen(false); }}><X size={15} /> {t('清除选择', 'Clear selection')}</button>
              </div>
            </div>
          </div>
        )}
        {loading && data.length === 0 ? <LoadingState /> : data.length === 0 ? <div className="p-4 md:p-6"><EmptyState title={t("暂无地址", "No addresses")} body={t("可以通过右上角新建地址。", "Use New address in the top-right to create one.")} /></div> : (
          <>
          <div className="space-y-2 p-3 md:hidden">
            {data.map(renderMobileAddressCard)}
          </div>
          <div className="address-table-wrap hidden overflow-auto md:block">
            <table className="data-table action-table">
              <thead><tr><th><input className="row-check" type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} aria-label={t("全选地址", "Select all addresses")} /></th><th>ID</th><th>{t("地址", "Address")}</th><th>{t("来源", "Source")}</th><th>{t("收件", "Inbox")}</th><th>{t("发件", "Sent")}</th><th>{t("更新时间", "Updated")}</th><th className="address-actions-th text-right">{t("操作", "Actions")}</th></tr></thead>
              <tbody>{data.map((row) => <tr key={row.id}>
                <td><input className="row-check" type="checkbox" checked={selectedIds.has(row.id)} onChange={() => toggleSelected(row)} aria-label={locale === 'en-US' ? `Select ${row.name}` : `选择 ${row.name}`} /></td>
                <td className="font-mono text-xs text-slate-400">#{row.id}</td>
                <td><button className="address-strong" onClick={() => copyAddressValue(row.name, t("已复制邮箱地址", "Mailbox address copied"))} title={t("点击复制邮箱地址", "Copy mailbox address")}>{row.name}</button>{(row.user_email || row.owner) && <p className="mt-1 text-xs text-slate-400">{row.user_email || row.owner}</p>}</td>
                <td>{row.source_meta || '-'}</td>
                <td>{row.mail_count ?? 0}</td>
                <td>{row.send_count ?? 0}</td>
                <td>{formatDateTime(row.updated_at || row.created_at)}</td>
                <td className="address-actions-cell">
                  <div className="address-desktop-actions-root">
                    <div className="address-desktop-actions">
                      <button className="table-action" onClick={() => copyLoginUrl(row)} title={t("一键复制登录链接", "Copy login link")}><Copy size={15} /></button>
                      <button className="table-action" disabled={shareActionBusy === `create:${row.id}`} onClick={() => createSingleShareLink(row)} title={t("创建可撤回分享链接", "Create revocable share link")}><Share2 size={15} className={cls(shareActionBusy === `create:${row.id}` && 'animate-pulse')} /></button>
                      <button className="table-action" onClick={() => onOpenInbox?.(row.name)} title={t("查看收件箱", "View inbox")}><MailOpen size={15} /></button>
                      <button className={cls('table-action', desktopActionMenuId === row.id && 'active')} onClick={(event) => toggleDesktopActionMenu(row, event.currentTarget)} title={t("更多操作", "More actions")} aria-haspopup="menu" aria-expanded={desktopActionMenuId === row.id}><MoreHorizontal size={16} /></button>
                    </div>
                  </div>
                </td>
              </tr>)}</tbody>
            </table>
          </div>
          </>
        )}
        <Pagination page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} count={count} />
      </div>

      <div className="panel sender-access-shell overflow-hidden">
        <button type="button" className="sender-access-toggle" onClick={() => setSenderPanelOpen((open) => !open)} aria-expanded={senderPanelOpen}>
          <span className="flex min-w-0 items-center gap-2">
            <ShieldCheck size={17} className="text-slate-600" />
            <span className="min-w-0">
              <strong className="block text-left text-sm text-slate-800">{t('发件权限', 'Sender access')}</strong>
              <small className="block truncate text-left text-xs text-slate-400">{t('默认收起，只有需要管理发信额度时再打开。', 'Collapsed by default; open only when managing send quota.')}</small>
            </span>
          </span>
          <ChevronDown size={16} className={cls('shrink-0 text-slate-400 transition', senderPanelOpen && 'rotate-180')} />
        </button>
        {senderPanelOpen && <SenderAccessPanel request={request} notify={notify} ask={ask} embedded />}
      </div>

      {desktopActionMenu && typeof document !== 'undefined' && createPortal(
        <div
          className={cls('address-floating-action-menu', desktopActionMenu.placement === 'up' && 'open-up')}
          role="menu"
          style={{ top: desktopActionMenu.top, left: desktopActionMenu.left }}
        >
          <button type="button" role="menuitem" onClick={() => { const row = desktopActionMenu.row; closeDesktopActionMenu(); copyMailboxPassword(row); }}><KeyRound size={15} />{t("复制邮箱密码/JWT", "Copy mailbox password/JWT")}</button>
          <button type="button" role="menuitem" onClick={() => { const row = desktopActionMenu.row; closeDesktopActionMenu(); setResetTarget(row); setResetPassword(''); }}><Lock size={15} />{t("重置密码", "Reset password")}</button>
          <button type="button" role="menuitem" onClick={() => { const row = desktopActionMenu.row; closeDesktopActionMenu(); actionClearInbox(row); }}><Inbox size={15} />{t('清空收件箱', 'Clear inbox')}</button>
          <button type="button" role="menuitem" onClick={() => { const row = desktopActionMenu.row; closeDesktopActionMenu(); actionClearSent(row); }}><Send size={15} />{t('清空发件箱', 'Clear sent')}</button>
          <button type="button" role="menuitem" className="danger" onClick={() => { const row = desktopActionMenu.row; closeDesktopActionMenu(); actionDelete(row); }}><Trash2 size={15} />{t('删除', 'Delete')}</button>
        </div>
      , document.body)}

      {createOpen && <Modal title={t('新建邮箱地址', 'New mailbox address')} onClose={() => setCreateOpen(false)}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
            <div>
              <label className="form-label">{t('自定义前缀', 'Custom prefix')}</label>
              <input className="form-input compact-control" value={newAddress.customPrefix} onChange={(e) => setNewAddress({ ...newAddress, customPrefix: cleanCustomPrefix(e.target.value) })} placeholder={t('如 bg. / app_', 'e.g. bg. / app_')} />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="form-label mb-0">{t('邮箱名称', 'Mailbox name')}</label>
                <button className="text-xs font-semibold text-slate-500 hover:text-slate-900" type="button" onClick={() => setNewAddress({ ...newAddress, name: makeRandomNameInput(effectiveSettings, newAddress.customPrefix) })}>{t('生成一个', 'Generate')}</button>
              </div>
              <input className="form-input compact-control" value={newAddress.name} onChange={(e) => setNewAddress({ ...newAddress, name: cleanLocalPart(e.target.value) })} placeholder={t('留空自动生成 10–15 位英数名', 'Leave empty to auto-generate 10–15 alphanumeric chars')} />
            </div>
          </div>
          <div>
            <label className="form-label">{t('邮箱域名', 'Mailbox domain')}</label>
            <PopoverSelect
              ariaLabel={t('邮箱域名', 'Mailbox domain')}
              value={newAddress.domain || defaultDomain || RANDOM_DOMAIN_VALUE}
              disabled={settingsLoading || domainOptions.length === 0}
              options={domainSelectOptions}
              onChange={(value) => setNewAddress({ ...newAddress, domain: value, enableRandomSubdomain: value === RANDOM_DOMAIN_VALUE ? newAddress.enableRandomSubdomain : newAddress.enableRandomSubdomain && randomSubdomainDomains.has(value) })}
            />
          </div>
          <div className="rounded-2xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
            {t('预览：', 'Preview: ')}<span className="font-semibold text-slate-800">{previewName}@{previewDomain}</span>
            <span className="ml-2 text-slate-400">{t('长度只计算 @ 前名称', 'Length counts only the name before @')}</span>
          </div>
          {shouldWarnPrefixSeparatorStrip && (
            <p className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
              {t('当前 Worker 的 ADDRESS_REGEX 会清理', 'The current Worker ADDRESS_REGEX will strip')} <code>.</code> / <code>_</code> / <code>-</code>{t('，创建结果可能丢失前缀符号。建议设置为', ', so the created address may lose prefix symbols. Recommended value:')} <code>{SEPARATOR_SAFE_ADDRESS_REGEX}</code>{t(' 后再创建。', ' before creating.')}
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="check-row rounded-xl bg-slate-50 px-3 py-2"><input type="checkbox" checked={newAddress.enablePrefix} onChange={(e) => setNewAddress({ ...newAddress, enablePrefix: e.target.checked })} />{t('启用 Worker 前缀', 'Enable Worker prefix')}{effectiveSettings?.prefix ? ` (${effectiveSettings.prefix})` : ''}</label>
            <label className={cls('check-row rounded-xl bg-slate-50 px-3 py-2', !currentDomainAllowsRandomSubdomain && 'opacity-50')}><input type="checkbox" disabled={!currentDomainAllowsRandomSubdomain} checked={newAddress.enableRandomSubdomain && currentDomainAllowsRandomSubdomain} onChange={(e) => setNewAddress({ ...newAddress, enableRandomSubdomain: e.target.checked })} />{t('随机二级域名', 'Random subdomain')}</label>
          </div>
          {domainOptions.length === 0 && <p className="text-xs text-rose-500">{t('没有从 API 解析到域名，请检查 Worker 的 DOMAINS / DEFAULT_DOMAINS。', 'No domains were parsed from the API. Check Worker DOMAINS / DEFAULT_DOMAINS.')}</p>}
          <button className="btn-primary w-full" disabled={domainOptions.length === 0} onClick={createAddress}><Plus size={16} /> {t('创建', 'Create')}</button>
        </div>
      </Modal>}
      {shareOpen && <Modal title={locale === 'en-US' ? `Create revocable share link (${selectedRows.length})` : `创建可撤回共享链接（${selectedRows.length} 个）`} onClose={() => setShareOpen(false)}>
        <div className="space-y-4">
          <p className="text-sm leading-6 text-slate-500">
            {t('系统会把已选邮箱的 JWT 加密保存到单邮箱前端的 Cloudflare KV。单邮箱和多邮箱共享都会进入管理列表，后续可以随时撤销。', 'Selected mailbox JWTs are encrypted into the webmail Cloudflare KV. Single and multi-mailbox shares both appear in this list and can be revoked later.')}
          </p>
          <div>
            <label className="form-label">{t('有效期', 'Expiry')}</label>
            <PopoverSelect ariaLabel={t('共享链接有效期', 'Share link expiry')} value={shareExpiry} options={shareExpiryOptions} onChange={(value) => setShareExpiry(value as ShareExpiryOption)} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={cls('share-choice-card', shareMailVisibility === 'new' && 'active')}>
              <input type="radio" name="shareMailVisibility" checked={shareMailVisibility === 'new'} onChange={() => setShareMailVisibility('new')} />
              <span><strong>{t('仅新增邮件', 'New mail only')}</strong><small>{t('默认打开为空，只显示分享后收到的新邮件。', 'Opens empty by default and only shows mail received after sharing.')}</small></span>
            </label>
            <label className={cls('share-choice-card', shareMailVisibility === 'all' && 'active')}>
              <input type="radio" name="shareMailVisibility" checked={shareMailVisibility === 'all'} onChange={() => setShareMailVisibility('all')} />
              <span><strong>{t('包含历史邮件', 'Include history')}</strong><small>{t('对方可以看到当前已有历史邮件。', 'Recipients can see existing mail history.')}</small></span>
            </label>
          </div>
          <label className="check-row rounded-xl bg-slate-50 px-3 py-2"><input type="checkbox" checked={shareAllowHideMail} onChange={(event) => setShareAllowHideMail(event.target.checked)} />{t('允许访客从分享页移除邮件（只影响此链接，不删除后台真实邮件）', 'Allow visitors to remove mail from the share view only; real admin mail is not deleted.')}</label>
          <div className="max-h-36 overflow-y-auto rounded-2xl bg-slate-50 p-3 text-xs text-slate-500">
            {selectedRows.map((row) => <div key={row.id} className="truncate py-0.5">#{row.id} · {row.name}</div>)}
          </div>
          <button className="btn-primary w-full" disabled={shareBusy || selectedRows.length === 0} onClick={createShareLink}>
            <Share2 size={16} /> {shareBusy ? t('正在创建…', 'Creating...') : t('创建并复制共享链接', 'Create and copy share link')}
          </button>
          {shareResult && (
            <div className="space-y-3 rounded-2xl bg-slate-50 p-3">
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-600">{t('共享链接', 'Share link')}</p>
                <code className="block overflow-hidden text-ellipsis whitespace-nowrap rounded-xl bg-white px-3 py-2 text-xs text-slate-500">{shareResult.url}</code>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary compact" onClick={() => copyAddressValue(shareResult.url, t('已复制共享链接', 'Share link copied'))}><Copy size={15} /> {t('复制', 'Copy')}</button>
                <a className="btn-secondary compact" href={shareResult.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> {t('打开测试', 'Open test')}</a>
              </div>
              <p className="text-xs text-slate-400">
                {locale === 'en-US' ? `Contains ${shareResult.addresses?.length || selectedRows.length} mailboxes` : `包含 ${shareResult.addresses?.length || selectedRows.length} 个邮箱`}
                {shareResult.expiresAt ? (locale === 'en-US' ? `, expires: ${formatDateTime(shareResult.expiresAt)}` : `，到期：${formatDateTime(shareResult.expiresAt)}`) : (locale === 'en-US' ? ', never expires' : '，永久有效')}
              </p>
            </div>
          )}
        </div>
      </Modal>}
      {shareManageOpen && <Modal title={t('共享链接管理', 'Share link management')} onClose={() => setShareManageOpen(false)} wide>
        <div className="space-y-4">
          <div className="rounded-2xl bg-slate-50 p-3 text-sm leading-6 text-slate-500">
            {t('输入会立即匹配当前已加载的邮箱地址和链接后缀；刷新按钮只负责同步最新共享记录。', 'Typing filters the loaded mailboxes and link suffixes instantly; Refresh only syncs the latest share records.')}
          </div>
          <div className="grid gap-2 md:grid-cols-[1fr_150px_auto] md:items-center">
            <label className="toolbar-field address-search-field min-w-0" aria-label={t('搜索当前共享列表', 'Search current share list')}>
              <Search size={15} className="toolbar-icon" />
              <input
                value={shareListQuery}
                onChange={(event) => setShareListQuery(event.target.value)}
                placeholder={t('实时搜索邮箱 / 链接后缀', 'Search mailbox / link suffix')}
              />
            </label>
            <PopoverSelect ariaLabel={t('共享链接状态筛选', 'Share link status filter')} value={shareStatusFilter} options={shareStatusFilterOptions} onChange={(value) => { setShareStatusFilter(value as ShareStatusFilter); setShareStatusNow(Date.now()); }} />
            <button className="btn-secondary compact" disabled={shareListLoading} onClick={() => loadShareList(true)}>
              <RefreshCw size={15} className={cls(shareListLoading && 'animate-spin')} /> {t('刷新', 'Refresh')}
            </button>
          </div>
          {selectedShares.length > 0 && (
            <div className="share-bulk-bar">
              <strong>{locale === 'en-US' ? `${selectedShares.length} share links selected` : `已选择 ${selectedShares.length} 条共享链接`}</strong>
              <button className="btn-secondary compact" onClick={copySelectedShareUrls}><Copy size={14} /> {t('复制链接', 'Copy links')}</button>
              <button className="btn-secondary compact" disabled={shareActionBusy === 'batch:update'} onClick={() => runShareBatch('update', { expiresIn: '30d', mailVisibility: 'new' })}>{t('切到仅新增', 'Set new-only')}</button>
              <button className="btn-secondary compact" disabled={shareActionBusy === 'batch:restore'} onClick={() => runShareBatch('restore', { expiresIn: '30d' })}>{t('恢复/续期', 'Restore/extend')}</button>
              <button className="btn-danger compact" disabled={shareActionBusy === 'batch:revoke'} onClick={() => runShareBatch('revoke')}><Trash2 size={14} /> {t('批量撤销', 'Revoke selected')}</button>
              <button className="text-xs font-semibold text-slate-400 hover:text-slate-700" onClick={() => setSelectedShareMap({})}>{t('清空选择', 'Clear selection')}</button>
            </div>
          )}
          {shareListLoading && shareList.length === 0 ? <LoadingState label={t('正在加载共享链接...', 'Loading share links...')} /> : shareList.length === 0 ? (
            <EmptyState icon={Share2} title={t('暂无共享链接', 'No share links')} body={t('勾选地址后创建共享链接，记录会显示在这里。', 'Create share links from selected addresses and records will appear here.')} />
          ) : visibleShareList.length === 0 ? (
            <EmptyState icon={Search} title={t('没有匹配结果', 'No matches')} body={t('当前已加载列表中没有匹配的邮箱地址或链接后缀。', 'No loaded mailbox address or link suffix matches this search.')} />
          ) : (
            <div className="space-y-3">
              <div className="space-y-3 md:hidden">
                {visibleShareList.map((row) => (
                  <article key={row.token} className={cls("rounded-2xl border border-slate-100 bg-white p-3 shadow-sm", effectiveShareStatus(row, shareStatusNow) !== 'active' && "share-row-revoked")}>
                    <div className="flex items-start gap-3">
                      <input className="row-check mt-1" type="checkbox" checked={selectedShareTokens.has(row.token)} onChange={() => toggleShareSelected(row)} aria-label={locale === 'en-US' ? `Select share link ${row.token}` : `选择共享链接 ${row.token}`} />
                      <div className="min-w-0 flex-1">
                        <div className="share-mobile-title">
                          <div className="share-mobile-addresses">
                            {row.addresses.map((item) => <p key={item.id} className="truncate">{item.address}</p>)}
                          </div>
                          <span className={cls('share-status-inline', `is-${effectiveShareStatus(row, shareStatusNow)}`)} title={`${shareStatusText(effectiveShareStatus(row, shareStatusNow))} · ${shareRemainingText(row)} · ${t('创建', 'Created')} ${formatDateTime(row.createdAt)}`}>
                            <i aria-hidden="true" />
                            <span>{shareStatusText(effectiveShareStatus(row, shareStatusNow))}</span>
                            {effectiveShareStatus(row, shareStatusNow) === 'active' && <small>{shareRemainingText(row)}</small>}
                            <b>{t('创建', 'Created')} {formatDateTime(row.createdAt)}</b>
                          </span>
                        </div>
                        <p className="share-range-summary mt-2">
                          <em>{shareMailboxCountText(row)}</em>
                        </p>
                      </div>
                    </div>
                    <p className="mt-2 truncate font-mono text-[11px] text-slate-400">{shareLinkSuffix(row)}</p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button className="btn-secondary compact" onClick={() => copyShareUrl(row.url)}><Copy size={14} /> {t('复制', 'Copy')}</button>
                      <a className="btn-secondary compact" href={row.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> {t('打开', 'Open')}</a>
                      <button className="btn-secondary compact" onClick={() => { setShareEditTarget(row); setShareEditExpiry('30d'); setShareEditVisibility(row.mailVisibility || 'all'); }}><Save size={14} /> {t('改期限', 'Edit expiry')}</button>
                      <button className="btn-danger compact" disabled={effectiveShareStatus(row, shareStatusNow) === 'revoked' || shareActionBusy === `revoke:${row.token}`} onClick={() => revokeShareLink(row)}><Trash2 size={14} /> {t('撤销', 'Revoke')}</button>
                    </div>
                  </article>
                ))}
              </div>
              <div className="share-manager-table-wrap hidden overflow-auto rounded-2xl border border-slate-100 md:block">
                <table className="data-table action-table share-admin-table">
                  <colgroup>
                    <col className="share-col-check" />
                    <col className="share-col-mailbox" />
                    <col className="share-col-range" />
                    <col className="share-col-actions" />
                  </colgroup>
                  <thead><tr><th><input className="row-check" type="checkbox" checked={allVisibleSharesSelected} onChange={toggleAllVisibleShares} aria-label={t('全选共享链接', 'Select all share links')} /></th><th>{t('邮箱地址 / 状态', 'Mailbox / status')}</th><th>{t('范围', 'Range')}</th><th className="text-right">{t('操作', 'Actions')}</th></tr></thead>
                  <tbody>{visibleShareList.map((row) => (
                    <tr key={row.token} className={cls(effectiveShareStatus(row, shareStatusNow) !== 'active' && 'share-row-revoked')}>
                      <td><input className="row-check" type="checkbox" checked={selectedShareTokens.has(row.token)} onChange={() => toggleShareSelected(row)} aria-label={locale === 'en-US' ? `Select share link ${row.token}` : `选择共享链接 ${row.token}`} /></td>
                      <td className="share-mailbox-cell">
                        <div className="share-mailbox-cell-grid">
                          <div className="share-mailbox-list" title={row.addresses.map((item) => item.address).join('\n')}>
                            {row.addresses.map((item) => <span key={item.id} className="share-mailbox-line">{item.address}</span>)}
                          </div>
                          <span className={cls('share-status-inline', `is-${effectiveShareStatus(row, shareStatusNow)}`)} title={`${shareStatusText(effectiveShareStatus(row, shareStatusNow))} · ${shareRemainingText(row)} · ${t('创建', 'Created')} ${formatDateTime(row.createdAt)}`}>
                            <i aria-hidden="true" />
                            <span>{shareStatusText(effectiveShareStatus(row, shareStatusNow))}</span>
                            {effectiveShareStatus(row, shareStatusNow) === 'active' && <small>{shareRemainingText(row)}</small>}
                            <b>{t('创建', 'Created')} {formatDateTime(row.createdAt)}</b>
                          </span>
                        </div>
                      </td>
                      <td className="share-range-cell">
                        <p className="share-range-summary share-range-main"><em>{shareMailboxCountText(row)}</em></p>
                      </td>
                      <td className="share-actions-cell">
                        <div className="share-row-actions">
                          <button className="table-action" onClick={() => copyShareUrl(row.url)} title={t('复制链接', 'Copy link')}><Copy size={15} /></button>
                          <a className="table-action" href={row.url} target="_blank" rel="noreferrer" title={t('打开测试', 'Open test')}><ExternalLink size={15} /></a>
                          <button className="table-action" onClick={() => { setShareEditTarget(row); setShareEditExpiry('30d'); setShareEditVisibility(row.mailVisibility || 'all'); }} title={t('修改有效期', 'Edit expiry')}><Save size={15} /></button>
                          <button className="table-action danger" disabled={effectiveShareStatus(row, shareStatusNow) === 'revoked' || shareActionBusy === `revoke:${row.token}`} onClick={() => revokeShareLink(row)} title={t('撤销链接', 'Revoke link')}><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {shareListHasMore && (
                <button className="btn-secondary w-full" disabled={shareListLoading} onClick={() => loadShareList(false)}>
                  <RefreshCw size={15} className={cls(shareListLoading && 'animate-spin')} /> {t('加载更多共享链接', 'Load more share links')}
                </button>
              )}
            </div>
          )}
        </div>
      </Modal>}
      {shareEditTarget && <Modal title={t('修改共享链接有效期', 'Edit share link expiry')} onClose={() => setShareEditTarget(null)}>
        <div className="space-y-4">
          <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500">
            <p className="font-medium text-slate-700">{locale === 'en-US' ? `${shareEditTarget.addressCount} mailboxes` : `${shareEditTarget.addressCount} 个邮箱`}</p>
            <p className="mt-1 truncate font-mono text-xs">{shareEditTarget.url}</p>
            <p className="mt-2 text-xs">{t('当前到期：', 'Current expiry: ')}{shareExpiryText(shareEditTarget.expiresAt)}; {t('状态：', 'Status: ')}{shareStatusText(effectiveShareStatus(shareEditTarget, shareStatusNow))}</p>
          </div>
          <div>
            <label className="form-label">{t('新的有效期', 'New expiry')}</label>
            <PopoverSelect ariaLabel={t('新的共享链接有效期', 'New share link expiry')} value={shareEditExpiry} options={shareExpiryOptions.map((item) => ({ ...item, label: item.value === 'forever' ? t('永久有效', 'Never expires') : (locale === 'en-US' ? `From now: ${item.label}` : `从现在起 ${item.label}`) }))} onChange={(value) => setShareEditExpiry(value as ShareExpiryOption)} />
          </div>
          <div>
            <label className="form-label">{t('邮件范围', 'Mail range')}</label>
            <PopoverSelect ariaLabel={t('共享邮件范围', 'Shared mail range')} value={shareEditVisibility} options={shareVisibilityOptions} onChange={(value) => setShareEditVisibility(value as ShareMailVisibility)} />
            <p className="mt-1 text-xs text-slate-400">{t('切换为仅新增会以当前时刻重新记录 cutoff。', 'Switching to new-only records a fresh cutoff from now.')}</p>
          </div>
          {shareEditTarget.status === 'revoked' && <p className="rounded-2xl bg-amber-50 px-3 py-2 text-xs text-amber-700">{t('保存后会同时恢复这个已撤销的共享链接。', 'Saving will also restore this revoked share link.')}</p>}
          <button className="btn-primary w-full" disabled={shareActionBusy === `update:${shareEditTarget.token}`} onClick={updateShareExpiry}>
            <Save size={16} /> {shareActionBusy === `update:${shareEditTarget.token}` ? t('保存中...', 'Saving...') : t('保存有效期', 'Save expiry')}
          </button>
        </div>
      </Modal>}
      {credential && <Modal title={locale === 'en-US' ? `Address credentials: ${credential.address}` : `地址凭据：${credential.address}`} onClose={() => setCredential(null)} wide>
        <div className="space-y-4">
          <p className="text-sm text-slate-500">{t('该 JWT 可作为地址密码，用于访问', 'This JWT works as the address password for')} <code>/api/*</code>{t(' 或发送邮件。', ' or sending mail.')}</p>
          <textarea readOnly className="code-area h-48" value={credential.jwt} />
          <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500">
            <p className="mb-2 font-medium text-slate-700">{t('一键登录链接', 'One-click login link')}</p>
            <code className="block overflow-hidden text-ellipsis whitespace-nowrap rounded-xl bg-white px-3 py-2 text-xs text-slate-500">{credentialLoginUrl}</code>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="btn-primary" onClick={() => copyAddressValue(credential.jwt, t('已复制 JWT', 'JWT copied'))}><KeyRound size={16} /> {t('复制 JWT', 'Copy JWT')}</button>
            <a className="btn-secondary" href={credentialLoginUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /> {t('一键登录该地址', 'Login to this address')}</a>
            <button className="btn-secondary" onClick={() => copyAddressValue(credentialLoginUrl, t('已复制登录地址链接', 'Login link copied'))}><Copy size={16} /> {t('一键复制登录地址链接', 'Copy login link')}</button>
          </div>
        </div>
      </Modal>}
      {resetTarget && <Modal title={locale === 'en-US' ? `Reset address password: ${resetTarget.name}` : `重置地址密码：${resetTarget.name}`} onClose={() => setResetTarget(null)}>
        <div className="space-y-4">
          <input className="form-input" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} type="password" placeholder={t('新密码（会 SHA-256 后提交）', 'New password (submitted after SHA-256)')} />
          <button className="btn-primary w-full" onClick={async () => {
            const trimmed = resetPassword.trim();
            if (trimmed.length < 6) { notify('error', t('请填写至少 6 位新密码', 'Enter at least 6 characters for the new password')); return; }
            try { await request(`/admin/address/${resetTarget.id}/reset_password`, { method: 'POST', body: { password: await sha256Hex(trimmed) } }); notify('success', t('地址密码已重置', 'Address password reset')); setResetTarget(null); }
            catch (error) { notify('error', error instanceof Error ? error.message : t('重置失败', 'Reset failed')); }
          }}><Save size={16} /> {t('保存', 'Save')}</button>
        </div>
      </Modal>}
    </div>
  );
}

function SenderAccessPanel({ request, notify, ask, embedded = false }: { request: Requester; notify: Notify; ask: ReturnType<typeof useConfirm>['ask']; embedded?: boolean }) {
  const { locale, t } = useLocaleCopy();
  const [data, setData] = useState<SenderAccessRecord[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [editTarget, setEditTarget] = useState<SenderAccessRecord | null>(null);
  const [balance, setBalance] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const listCacheKey = useMemo(() => `${STORAGE_KEYS.senderAccessListCachePrefix}${page}:${pageSize}:${encodeURIComponent(address.trim())}`, [address, page, pageSize]);

  const fetchData = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    try {
      const res = await request<ListResponse<SenderAccessRecord>>(`/admin/address_sender${buildQuery({ limit: pageSize, offset: (page - 1) * pageSize, address: address.trim() })}`, { forceRefresh, cacheTtlMs: CACHE_TTL.senderAccess });
      const results = res.results || [];
      const nextCount = typeof res.count === 'number' ? res.count : results.length;
      setData(results);
      setCount(nextCount);
      writeJsonStorage(listCacheKey, { version: LIST_CACHE_VERSION, count: nextCount, savedAt: Date.now(), results });
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('发件权限加载失败', 'Failed to load sender access'));
    } finally {
      setLoading(false);
    }
  }, [address, listCacheKey, notify, page, pageSize, request]);

  useEffect(() => {
    const cached = readJsonStorage<CachedList<SenderAccessRecord> | null>(listCacheKey, null);
    if (!cached || cached.version !== LIST_CACHE_VERSION || !Array.isArray(cached.results)) return;
    setData(cached.results);
    setCount(cached.count || cached.results.length);
  }, [listCacheKey]);
  useEffect(() => { fetchData(); }, [fetchData]);
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const openEdit = (row: SenderAccessRecord) => {
    setEditTarget(row);
    setBalance(Number(row.balance || 0));
    setEnabled(Boolean(row.enabled));
  };
  const save = async () => {
    if (!editTarget) return;
    try {
      await request('/admin/address_sender', { method: 'POST', body: { address: editTarget.address, address_id: editTarget.id, balance, enabled: enabled ? 1 : 0 } });
      notify('success', t('发件权限已更新', 'Sender access updated'));
      setEditTarget(null);
      await fetchData();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('更新失败', 'Update failed'));
    }
  };
  const remove = (row: SenderAccessRecord) => ask({ title: locale === 'en-US' ? `Delete sender access for ${row.address}` : `删除 ${row.address} 的发件权限`, body: t('将删除 address_sender 记录；如需恢复需由 Worker 逻辑重新创建或配置。', 'This deletes the address_sender record. Restore it through Worker logic or configuration if needed.'), actionLabel: t('删除', 'Delete'), onConfirm: async () => { await request(`/admin/address_sender/${row.id}`, { method: 'DELETE' }); notify('success', t('发件权限已删除', 'Sender access deleted')); await fetchData(); } });

  return <div className={cls('sender-access-panel overflow-hidden', !embedded && 'panel')}>
    <div className="flex flex-col justify-between gap-3 border-b border-slate-100 p-3 md:flex-row md:items-center">
      <div>
        <h3 className="panel-title"><ShieldCheck className="mr-2 inline h-5 w-5 text-slate-600" />{t('发件权限', 'Sender access')}</h3>
        <p className="panel-subtitle">{t('官方', 'Official')} <code>/admin/address_sender</code>{t('：控制地址是否允许发信与剩余额度。', ': controls whether addresses can send mail and their remaining quota.')}</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className="form-input py-2 text-sm" value={address} onChange={(e) => { setAddress(e.target.value); setPage(1); }} placeholder={t('按地址筛选', 'Filter by address')} />
        <button className="btn-secondary" onClick={() => fetchData(true)}><RefreshCw size={15} className={cls(loading && data.length > 0 && 'animate-spin')} /> {t('刷新', 'Refresh')}</button>
      </div>
    </div>
    {loading && data.length === 0 ? <LoadingState /> : data.length === 0 ? <div className="p-4 md:p-6"><EmptyState icon={ShieldCheck} title={t('暂无发件权限记录', 'No sender access records')} body={t('发件权限记录通常在地址申请发件能力或余额配置后出现。', 'Sender access records usually appear after an address requests send capability or quota configuration.')} /></div> : <>
      <div className="space-y-2 p-3 md:hidden">{data.map((row) => <article key={row.id} className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{row.address}</p><p className="mt-1 text-[11px] text-slate-400">#{row.id}</p></div><span className={cls('status-pill', Boolean(row.enabled) && 'enabled')}>{Boolean(row.enabled) ? t('已启用', 'Enabled') : t('已禁用', 'Disabled')}</span></div><div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500"><div className="rounded-xl bg-slate-50 px-2.5 py-2"><span className="block text-[10px] text-slate-400">{t('余额', 'Balance')}</span><span className="mt-0.5 block font-medium text-slate-700">{row.balance ?? 0}</span></div><div className="rounded-xl bg-slate-50 px-2.5 py-2"><span className="block text-[10px] text-slate-400">{t('更新时间', 'Updated')}</span><span className="mt-0.5 block truncate">{formatDateTime(row.updated_at || row.created_at)}</span></div></div><div className="mt-3 grid grid-cols-2 gap-2"><button className="btn-secondary compact" onClick={() => openEdit(row)}><Edit3 size={14} /> {t('编辑', 'Edit')}</button><button className="btn-danger compact" onClick={() => remove(row)}><Trash2 size={14} /> {t('删除', 'Delete')}</button></div></article>)}</div>
      <div className="hidden overflow-auto md:block"><table className="data-table action-table"><thead><tr><th>ID</th><th>{t("地址", "Address")}</th><th>{t('余额', 'Balance')}</th><th>{t('状态', 'Status')}</th><th>{t("更新时间", "Updated")}</th><th className="text-right">{t('操作', 'Actions')}</th></tr></thead><tbody>{data.map((row) => <tr key={row.id}><td className="font-mono text-xs text-slate-400">#{row.id}</td><td className="font-medium text-slate-800">{row.address}</td><td>{row.balance ?? 0}</td><td><span className={cls('status-pill', Boolean(row.enabled) && 'enabled')}>{Boolean(row.enabled) ? t('已启用', 'Enabled') : t('已禁用', 'Disabled')}</span></td><td>{formatDateTime(row.updated_at || row.created_at)}</td><td><div className="flex justify-end gap-2"><button className="table-action" onClick={() => openEdit(row)} title={t('编辑', 'Edit')}><Edit3 size={15} /></button><button className="table-action danger" onClick={() => remove(row)} title={t('删除', 'Delete')}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div>
    </>}
    <Pagination page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} count={count} />
    {editTarget && <Modal title={locale === 'en-US' ? `Sender access: ${editTarget.address}` : `发件权限：${editTarget.address}`} onClose={() => setEditTarget(null)}><div className="space-y-4"><label className="check-row"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{t('启用发件', 'Enable sending')}</label><div><label className="form-label">{t('发件余额', 'Send balance')}</label><input className="form-input" type="number" min={0} max={1000} value={balance} onChange={(e) => setBalance(Number(e.target.value))} /></div><button className="btn-primary w-full" onClick={save}><Save size={16} /> {t('保存', 'Save')}</button></div></Modal>}
  </div>;
}
