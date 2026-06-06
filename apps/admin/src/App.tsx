import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { clearApiCache, createApiClient } from './lib/api';
import { API_BASE, STORAGE_KEYS, SWIPE } from './lib/constants';
import { readJwtFromQuery } from './lib/clipboard';
import { isLikelyJwt } from './lib/crypto';
import { forgetAuthBrowserStorage, normalizeAuthApiBase, purgeExpiredAuthStorage, readBoundAuth, readStorage, writeBoundAuth, writeLocalStorage } from './lib/storage';
import { cls } from './lib/format';
import { applyRuntimeLocale, getBackendLang, getRuntimeLocale, localeText, readInitialLocale, writeLocale, type AppLocale } from './lib/locale';
import type { AddressUserFilter, ComposePayload, OpenSettings, Statistics } from './types/api';
import { AuthPanel } from './components/AuthPanel';
import { NoticeToast, useConfirm, useNotice } from './components/Common';
import { Header, MobileNav, Sidebar, mobileSwipeMenus, type MenuKey } from './components/Shell';
import { AddressView } from './views/AddressView';
import { DashboardView, StatsView } from './views/DashboardView';
import { MailWorkspace } from './views/MailWorkspace';

const MemoDashboardView = memo(DashboardView);
const MemoStatsView = memo(StatsView);
const MemoAddressView = memo(AddressView);
const MemoMailWorkspace = memo(MailWorkspace);

const ComposeView = lazy(() => import('./views/ComposeView').then((mod) => ({ default: mod.ComposeView })));
const UsersView = lazy(() => import('./views/UsersView').then((mod) => ({ default: mod.UsersView })));
const SettingsView = lazy(() => import('./views/SettingsMaintenance').then((mod) => ({ default: mod.SettingsView })));
const MaintenanceView = lazy(() => import('./views/SettingsMaintenance').then((mod) => ({ default: mod.MaintenanceView })));

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const emptyStats: Statistics = { mailCount: 0, sendMailCount: 0, userCount: 0, addressCount: 0, activeAddressCount7days: 0, activeAddressCount30days: 0 };
const keepAliveMenus: MenuKey[] = ['dashboard', 'stats', 'address', 'users', 'inbox', 'sent', 'unknown', 'compose', 'settings', 'maintenance'];
type MailboxAddressRequest = { address: string; requestId: number };
type PageSwipeLock = 'none' | 'page' | 'scroll';
type PageSwipeDirection = 1 | -1 | 0;
type PageSwipeState = { active: boolean; lock: PageSwipeLock; direction: PageSwipeDirection; targetMenu: MenuKey | null; startX: number; startY: number; lastX: number; lastY: number; pendingX: number; rafId: number };

function preloadAdminViewChunks() {
  void import('./views/ComposeView');
  void import('./views/UsersView');
  void import('./views/SettingsMaintenance');
}

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px), (hover: none) and (pointer: coarse)').matches;
}

function shouldIgnorePageSwipe(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, iframe, .modal-card, .mobile-mail-detail, .mail-frame, .code-area, [data-no-page-swipe="true"]'));
}

function getCircularOffset(menu: MenuKey, activeMenu: MenuKey): number {
  const menuIndex = mobileSwipeMenus.indexOf(menu);
  const activeIndex = mobileSwipeMenus.indexOf(activeMenu);
  if (menuIndex < 0 || activeIndex < 0) return 0;
  const count = mobileSwipeMenus.length;
  let offset = menuIndex - activeIndex;
  if (offset > count / 2) offset -= count;
  if (offset < -count / 2) offset += count;
  return offset;
}

function getCircularMotionDirection(current: MenuKey, next: MenuKey): 1 | -1 {
  const currentIndex = mobileSwipeMenus.indexOf(current);
  const nextIndex = mobileSwipeMenus.indexOf(next);
  if (currentIndex < 0 || nextIndex < 0) return 1;
  const count = mobileSwipeMenus.length;
  const forwardDistance = (nextIndex - currentIndex + count) % count;
  const backDistance = (currentIndex - nextIndex + count) % count;
  return forwardDistance <= backDistance ? 1 : -1;
}

function hashStorageScope(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getMailStateScope(apiBase: string, adminPassword: string, sitePassword: string, userAccessToken: string, addressJwt: string): string {
  const normalizedBase = normalizeAuthApiBase(apiBase) || 'same-origin';
  const authIdentity = addressJwt
    ? `address:${addressJwt}`
    : userAccessToken
      ? `user:${userAccessToken}`
      : adminPassword
        ? `admin:${adminPassword}`
        : sitePassword
          ? `site:${sitePassword}`
          : 'anonymous';
  return `${hashStorageScope(normalizedBase)}.${hashStorageScope(authIdentity)}`;
}

function getPageRenderOffset(menu: MenuKey, activeMenu: MenuKey, targetMenu: MenuKey | null, dragX: number): number {
  const offset = getCircularOffset(menu, activeMenu);
  if (!targetMenu || menu === activeMenu || dragX === 0) return offset;
  const side = dragX < 0 ? 1 : -1;
  if (menu === targetMenu) return side;
  if (offset === side) return side * 2;
  return offset;
}

function getPageDragX(value: number, width: number): number {
  const abs = Math.abs(value);
  if (abs <= width) return value;
  return Math.sign(value) * (width + (abs - width) * 0.18);
}

function getPageSettleMs(from: number, to: number, width: number): number {
  const distanceRatio = Math.min(1.4, Math.abs(to - from) / Math.max(width, 1));
  return Math.round(Math.min(300, Math.max(120, distanceRatio * 220)));
}

function getLockedSwipeDelta(deltaX: number, direction: PageSwipeDirection): number {
  if (direction === 1) return Math.min(0, deltaX);
  if (direction === -1) return Math.max(0, deltaX);
  return deltaX;
}

function createPageSwipeState(): PageSwipeState {
  return { active: false, lock: 'none', direction: 0, targetMenu: null, startX: 0, startY: 0, lastX: 0, lastY: 0, pendingX: 0, rafId: 0 };
}

function readInitialAddressUserFilter(): AddressUserFilter | null {
  const raw = readStorage(STORAGE_KEYS.addressUserFilter, '');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AddressUserFilter>;
    if (typeof parsed.userId === 'number' && parsed.userId > 0 && typeof parsed.userEmail === 'string') {
      return { userId: parsed.userId, userEmail: parsed.userEmail, requestId: Number(parsed.requestId || 0) };
    }
  } catch {
    // Ignore legacy string filters. User-id based filtering is the only reliable path.
  }
  return null;
}

function consumeAddressJwtFromUrl(): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  const jwt = readJwtFromQuery(url.search);
  if (!jwt) return '';
  url.searchParams.delete('JWT');
  url.searchParams.delete('jwt');
  const search = url.searchParams.toString();
  const cleanUrl = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
  window.history.replaceState(null, document.title, cleanUrl || '/');
  if (!isLikelyJwt(jwt)) return '';
  return jwt;
}

function ViewFallback() {
  const locale = getRuntimeLocale();
  return <div className="flex h-full items-center justify-center text-sm text-slate-400">{localeText('视图加载中...', 'Loading view...', locale)}</div>;
}

const INITIAL_AUTH_EXPIRY_CHECK = purgeExpiredAuthStorage();

function readInitialConnection() {
  const apiBase = normalizeAuthApiBase(readStorage(STORAGE_KEYS.apiBase, API_BASE));
  const storedAuth = readBoundAuth(apiBase);
  const fromUrl = consumeAddressJwtFromUrl();
  if (fromUrl) {
    const rememberedAt = storedAuth.rememberedAt || Date.now();
    const nextAuth = {
      ...storedAuth,
      addressJwt: fromUrl,
      rememberedAt,
    };
    writeBoundAuth(apiBase, nextAuth, rememberedAt);
    return { ...nextAuth, apiBase };
  }
  return {
    ...storedAuth,
    addressJwt: isLikelyJwt(storedAuth.addressJwt) ? storedAuth.addressJwt : '',
    apiBase,
  };
}

const INITIAL_CONNECTION = readInitialConnection();

export default function App() {
  const [activeMenu, setActiveMenu] = useState<MenuKey>('dashboard');
  const [pageMotion, setPageMotion] = useState<'forward' | 'back' | ''>('');
  const [pageDragX, setPageDragX] = useState(0);
  const [pageSettling, setPageSettling] = useState(false);
  const [pageSettleMs, setPageSettleMs] = useState(220);
  const [pageSwipeTargetMenu, setPageSwipeTargetMenu] = useState<MenuKey | null>(null);
  const [visitedMenus, setVisitedMenus] = useState<Set<MenuKey>>(() => new Set(['dashboard']));
  const [mobilePagesEnabled, setMobilePagesEnabled] = useState(() => isMobileViewport());
  const [globalQuery, setGlobalQuery] = useState('');
  const [apiBase, setApiBase] = useState(() => INITIAL_CONNECTION.apiBase);
  const [adminPassword, setAdminPassword] = useState(() => INITIAL_CONNECTION.adminPassword);
  const [sitePassword, setSitePassword] = useState(() => INITIAL_CONNECTION.sitePassword);
  const [userAccessToken, setUserAccessToken] = useState(() => INITIAL_CONNECTION.userAccessToken);
  const [addressJwt, setAddressJwt] = useState(() => INITIAL_CONNECTION.addressJwt);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (readStorage(STORAGE_KEYS.uiTheme, 'light') === 'dark' ? 'dark' : 'light'));
  const [locale, setLocale] = useState<AppLocale>(() => readInitialLocale());
  const [stats, setStats] = useState<Statistics>(emptyStats);
  const [statsLoading, setStatsLoading] = useState(false);
  const [openSettings, setOpenSettings] = useState<OpenSettings | null>(null);
  const [composeSeed, setComposeSeed] = useState<Partial<ComposePayload>>({});
  const [authExpiredNoticePending, setAuthExpiredNoticePending] = useState(() => INITIAL_AUTH_EXPIRY_CHECK.expired || Boolean(readStorage(STORAGE_KEYS.authExpiredNotice, '')));
  const [addressUserFilter, setAddressUserFilter] = useState<AddressUserFilter | null>(() => readInitialAddressUserFilter());
  const [mailboxAddressRequest, setMailboxAddressRequest] = useState<MailboxAddressRequest | null>(null);
  const pageSwipeRef = useRef<PageSwipeState>(createPageSwipeState());
  const pageSwipeTargetMenuRef = useRef<MenuKey | null>(null);
  const pageTransitionTimerRef = useRef<number | null>(null);
  const credentialFingerprintRef = useRef<string | null>(null);
  const authResetSeqRef = useRef(0);
  const { notice, push } = useNotice();
  const { ask, modal: confirmModal } = useConfirm();
  const client = useMemo(() => createApiClient(() => apiBase, () => ({ adminPassword, sitePassword, userAccessToken, addressJwt, lang: getBackendLang(locale) })), [addressJwt, adminPassword, apiBase, locale, sitePassword, userAccessToken]);
  const request = useCallback(<T,>(path: string, options?: Parameters<typeof client.request>[1]) => client.request<T>(path, options), [client]);
  const connected = Boolean(adminPassword || userAccessToken || addressJwt);
  const mailStateScope = useMemo(() => getMailStateScope(apiBase, adminPassword, sitePassword, userAccessToken, addressJwt), [addressJwt, adminPassword, apiBase, sitePassword, userAccessToken]);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const query = window.matchMedia('(max-width: 900px), (hover: none) and (pointer: coarse)');
    const update = () => setMobilePagesEnabled(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  const loadStats = useCallback(async (forceRefresh = false) => {
    const seq = authResetSeqRef.current;
    setStatsLoading(true);
    try {
      const res = await request<Statistics>('/admin/statistics', { forceRefresh, cacheTtlMs: 30_000 });
      if (seq === authResetSeqRef.current && (adminPassword || userAccessToken)) setStats({ ...emptyStats, ...res });
    } catch (error) {
      if (seq === authResetSeqRef.current && (adminPassword || userAccessToken)) push('error', error instanceof Error ? error.message : localeText('统计加载失败', 'Failed to load stats', locale));
    } finally {
      if (seq === authResetSeqRef.current) setStatsLoading(false);
    }
  }, [adminPassword, locale, push, request, userAccessToken]);
  const loadOpenSettings = useCallback(async (forceRefresh = false) => { try { const res = await request<OpenSettings>('/open_api/settings', { forceRefresh, cacheTtlMs: 120_000 }); setOpenSettings(res); } catch { /* open settings may require site auth */ } }, [request]);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const idleWindow = window as IdleWindow;
    const warmViews = () => preloadAdminViewChunks();
    if (idleWindow.requestIdleCallback) {
      const idleId = idleWindow.requestIdleCallback(warmViews, { timeout: 1500 });
      return () => idleWindow.cancelIdleCallback?.(idleId);
    }
    const timer = window.setTimeout(warmViews, 450);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => { loadOpenSettings(); }, [loadOpenSettings]);
  useEffect(() => { if (adminPassword || userAccessToken) loadStats(); }, [adminPassword, loadStats, userAccessToken]);
  useEffect(() => {
    const fingerprint = `${apiBase}|${adminPassword}|${sitePassword}|${userAccessToken}|${addressJwt}`;
    if (credentialFingerprintRef.current !== null && credentialFingerprintRef.current !== fingerprint) clearApiCache();
    credentialFingerprintRef.current = fingerprint;
  }, [addressJwt, adminPassword, apiBase, sitePassword, userAccessToken]);
  useEffect(() => { writeLocalStorage(STORAGE_KEYS.addressUserFilter, addressUserFilter ? JSON.stringify(addressUserFilter) : ''); }, [addressUserFilter]);
  useEffect(() => {
    setVisitedMenus((current) => {
      if (current.has(activeMenu)) return current;
      const next = new Set(current);
      next.add(activeMenu);
      return next;
    });
  }, [activeMenu]);
  useEffect(() => {
    writeLocalStorage(STORAGE_KEYS.uiTheme, theme);
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('theme-dark', theme === 'dark');
    document.body.classList.toggle('theme-dark', theme === 'dark');
  }, [theme]);
  useEffect(() => {
    writeLocale(locale);
    applyRuntimeLocale(locale);
  }, [locale]);
  useEffect(() => {
    if (!authExpiredNoticePending) return;
    push('info', localeText('已超过 7 天未重新认证，已自动退出并清理本机敏感凭据。请重新验证管理员凭据。', 'It has been more than 7 days since the last verification. Sensitive local credentials were cleared; please verify again.', locale));
    setAuthExpiredNoticePending(false);
    writeLocalStorage(STORAGE_KEYS.authExpiredNotice, '');
  }, [authExpiredNoticePending, locale, push]);
  const updateLocale = useCallback((nextLocale: AppLocale) => {
    applyRuntimeLocale(nextLocale);
    writeLocale(nextLocale);
    setLocale(nextLocale);
  }, []);
  const forgetCurrentBrowser = useCallback(() => {
    const currentLocale = getRuntimeLocale();
    ask({
      title: localeText('退出并忘记此浏览器', 'Sign out and forget this browser', currentLocale),
      body: localeText(
        '将清除本机保存的管理员密码、站点密码、用户 access token、地址登录 JWT 以及管理列表/邮件缓存；Worker 地址、主题、语言和界面偏好会保留。',
        'This clears saved admin password, site password, user access token, address JWT, and local admin list/mail caches on this browser. API base, theme, language, and UI preferences are kept.',
        currentLocale,
      ),
      actionLabel: localeText('退出并清理', 'Sign out and clear', currentLocale),
      onConfirm: () => {
        const preservedApiBase = apiBase.trim();
        authResetSeqRef.current += 1;
        forgetAuthBrowserStorage();
        if (preservedApiBase) writeLocalStorage(STORAGE_KEYS.apiBase, preservedApiBase);
        clearApiCache();
        setAdminPassword('');
        setSitePassword('');
        setUserAccessToken('');
        setAddressJwt('');
        setAddressUserFilter(null);
        setMailboxAddressRequest(null);
        setComposeSeed({});
        setGlobalQuery('');
        setStats(emptyStats);
        setStatsLoading(false);
        setVisitedMenus(new Set(['dashboard']));
        if (pageTransitionTimerRef.current !== null) {
          window.clearTimeout(pageTransitionTimerRef.current);
          pageTransitionTimerRef.current = null;
        }
        setActiveMenu('dashboard');
        setPageMotion('');
        setPageDragX(0);
        setPageSettling(false);
        setPageSettleMs(220);
        setPageSwipeTargetMenu(null);
        pageSwipeTargetMenuRef.current = null;
        credentialFingerprintRef.current = null;
        window.setTimeout(() => {
          const hasFreshAuth = Boolean(readStorage(STORAGE_KEYS.adminPassword, '') || readStorage(STORAGE_KEYS.sitePassword, '') || readStorage(STORAGE_KEYS.userAccessToken, '') || readStorage(STORAGE_KEYS.addressJwt, ''));
          if (!hasFreshAuth) forgetAuthBrowserStorage();
        }, 900);
        push('success', localeText('已退出，并清除本机保存的敏感凭据和管理缓存。', 'Signed out and cleared saved sensitive credentials plus admin caches on this browser.', currentLocale));
      },
    });
  }, [apiBase, ask, push]);
  const refreshCurrent = () => {
    clearApiCache();
    loadOpenSettings(true);
    loadStats(true);
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('loven7-global-refresh', { detail: { menu: activeMenu } }));
  };
  const navigateMenu = useCallback((menu: MenuKey) => {
    setActiveMenu((current) => {
      if (current === menu) return current;
      const currentIndex = mobileSwipeMenus.indexOf(current);
      const nextIndex = mobileSwipeMenus.indexOf(menu);
      if (currentIndex >= 0 && nextIndex >= 0 && mobilePagesEnabled && connected) {
        if (pageTransitionTimerRef.current !== null) {
          window.clearTimeout(pageTransitionTimerRef.current);
          pageTransitionTimerRef.current = null;
        }
        const width = typeof window === 'undefined' ? 390 : Math.max(window.innerWidth, 360);
        const offset = getCircularOffset(menu, current);
        const targetX = -offset * width;
        const duration = getPageSettleMs(0, targetX, width);
        const adjacentTarget = Math.abs(offset) === 1 ? menu : null;
        setPageSettleMs(duration);
        setPageSettling(true);
        setPageMotion('');
        pageSwipeTargetMenuRef.current = adjacentTarget;
        setPageSwipeTargetMenu(adjacentTarget);
        setVisitedMenus((visited) => {
          if (visited.has(menu)) return visited;
          const next = new Set(visited);
          next.add(menu);
          return next;
        });
        setPageDragX(targetX);
        pageTransitionTimerRef.current = window.setTimeout(() => {
          setActiveMenu(menu);
          setPageSettling(false);
          setPageDragX(0);
          setPageSwipeTargetMenu(null);
          pageSwipeTargetMenuRef.current = null;
          setPageMotion('');
          setPageSettleMs(220);
          pageTransitionTimerRef.current = null;
        }, duration);
        return current;
      } else if (currentIndex >= 0 && nextIndex >= 0) {
        setPageMotion(getCircularMotionDirection(current, menu) === 1 ? 'forward' : 'back');
        window.setTimeout(() => setPageMotion(''), 260);
      } else {
        setPageMotion('');
      }
      return menu;
    });
  }, [connected, mobilePagesEnabled]);
  const clearAddressUserFilter = useCallback(() => setAddressUserFilter(null), []);
  const openAddressInbox = useCallback((address: string) => {
    setMailboxAddressRequest((current) => ({ address, requestId: (current?.requestId || 0) + 1 }));
    navigateMenu('inbox');
  }, [navigateMenu]);
  const filterUserAddresses = useCallback((filter: { userId: number; userEmail: string }) => {
    setAddressUserFilter((current) => ({ userId: filter.userId, userEmail: filter.userEmail, requestId: (current?.requestId || 0) + 1 }));
    setGlobalQuery('');
    navigateMenu('address');
  }, [navigateMenu]);
  const renderContent = (menu: MenuKey) => {
    if (menu === 'dashboard') return <MemoDashboardView stats={stats} loading={statsLoading} openSettings={openSettings} refresh={refreshCurrent} setActiveMenu={navigateMenu} />;
    if (menu === 'stats') return <MemoStatsView stats={stats} loading={statsLoading} openSettings={openSettings} refresh={refreshCurrent} />;
    if (menu === 'address') return <MemoAddressView request={request} notify={push} ask={ask} globalQuery={globalQuery} openSettings={openSettings} userFilter={addressUserFilter} userTotal={stats.userCount} onClearUserFilter={clearAddressUserFilter} onOpenInbox={openAddressInbox} />;
    if (menu === 'users') return <UsersView request={request} notify={push} ask={ask} globalQuery={globalQuery} onFilterUserAddresses={filterUserAddresses} />;
    if (menu === 'inbox' || menu === 'sent' || menu === 'unknown') {
      const visualMenu = pageSwipeTargetMenu && Math.abs(pageDragX) > 2 ? pageSwipeTargetMenu : activeMenu;
      return (
        <div key={`${menu}:${mailStateScope}`} className="h-full min-h-0">
          <MemoMailWorkspace mode={menu} active={activeMenu === menu} visualActive={visualMenu === menu} request={request} notify={push} ask={ask} globalQuery={globalQuery} addressRequest={menu === 'inbox' ? mailboxAddressRequest : null} setActiveMenu={navigateMenu} setComposeSeed={setComposeSeed} mailStateScope={mailStateScope} />
        </div>
      );
    }
    if (menu === 'compose') return <ComposeView request={request} notify={push} seed={composeSeed} clearSeed={() => setComposeSeed({})} />;
    if (menu === 'settings') return <SettingsView request={request} notify={push} locale={locale} setLocale={updateLocale} authPanel={<AuthPanel {...authProps} initialOpen={false} />} />;
    return <MaintenanceView request={request} notify={push} />;
  };
  const schedulePageDragX = useCallback((value: number) => {
    pageSwipeRef.current.pendingX = value;
    if (pageSwipeRef.current.rafId) return;
    pageSwipeRef.current.rafId = window.requestAnimationFrame(() => {
      pageSwipeRef.current.rafId = 0;
      setPageDragX(pageSwipeRef.current.pendingX);
    });
  }, []);
  const resetPageSwipe = useCallback((clearTarget = true) => {
    if (pageSwipeRef.current.rafId) {
      window.cancelAnimationFrame(pageSwipeRef.current.rafId);
    }
    pageSwipeRef.current = createPageSwipeState();
    if (clearTarget) {
      pageSwipeTargetMenuRef.current = null;
      setPageSwipeTargetMenu(null);
    }
  }, []);
  const getMobileSwipeTarget = useCallback((direction: 1 | -1): MenuKey | null => {
    const currentIndex = mobileSwipeMenus.indexOf(activeMenu);
    if (currentIndex < 0) return null;
    return mobileSwipeMenus[(currentIndex + direction + mobileSwipeMenus.length) % mobileSwipeMenus.length];
  }, [activeMenu]);
  const setGestureTargetMenu = useCallback((menu: MenuKey | null) => {
    if (pageSwipeTargetMenuRef.current === menu) return;
    pageSwipeTargetMenuRef.current = menu;
    setPageSwipeTargetMenu(menu);
  }, []);
  const switchMobileMenuBySwipe = useCallback((direction: 1 | -1, targetOverride?: MenuKey | null, dragOverride?: number) => {
    const currentIndex = mobileSwipeMenus.indexOf(activeMenu);
    if (currentIndex < 0) return;
    const nextMenu = targetOverride || getMobileSwipeTarget(direction);
    if (!nextMenu) return;
    const width = typeof window === 'undefined' ? 390 : Math.max(window.innerWidth, 360);
    const currentDragX = dragOverride ?? getPageDragX(getLockedSwipeDelta(pageSwipeRef.current.lastX - pageSwipeRef.current.startX, direction), width);
    const targetX = direction === 1 ? -width : width;
    const duration = getPageSettleMs(currentDragX, targetX, width);
    if (pageTransitionTimerRef.current !== null) {
      window.clearTimeout(pageTransitionTimerRef.current);
      pageTransitionTimerRef.current = null;
    }
    setPageSettleMs(duration);
    setPageSettling(true);
    setGestureTargetMenu(nextMenu);
    setPageMotion('');
    setVisitedMenus((current) => {
      if (current.has(nextMenu)) return current;
      const next = new Set(current);
      next.add(nextMenu);
      return next;
    });
    setPageDragX(targetX);
    pageTransitionTimerRef.current = window.setTimeout(() => {
      setActiveMenu(nextMenu);
      setPageSettling(false);
      setPageDragX(0);
      setGestureTargetMenu(null);
      setPageMotion('');
      setPageSettleMs(220);
      pageTransitionTimerRef.current = null;
    }, duration);
  }, [activeMenu, getMobileSwipeTarget, setGestureTargetMenu]);
  useEffect(() => () => {
    if (pageTransitionTimerRef.current !== null) window.clearTimeout(pageTransitionTimerRef.current);
  }, []);
  useEffect(() => {
    const handleNativeTouchStart = (event: TouchEvent) => {
      if (pageSettling) return;
      if (!isMobileViewport() || event.touches.length !== 1 || shouldIgnorePageSwipe(event.target)) return;
      const touch = event.touches[0];
      if (pageSwipeRef.current.rafId) window.cancelAnimationFrame(pageSwipeRef.current.rafId);
      pageSwipeRef.current = { ...createPageSwipeState(), active: true, startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastY: touch.clientY };
    };
    const handleNativeTouchMove = (event: TouchEvent) => {
      const swipe = pageSwipeRef.current;
      if (!swipe.active || event.touches.length !== 1) return;
      const touch = event.touches[0];
      swipe.lastX = touch.clientX;
      swipe.lastY = touch.clientY;
      const dx = swipe.lastX - swipe.startX;
      const dy = Math.abs(swipe.lastY - swipe.startY);
      const absX = Math.abs(dx);
      if (swipe.lock === 'none' && (absX > SWIPE.startThreshold || dy > SWIPE.startThreshold)) {
        swipe.lock = absX > dy * SWIPE.ratio ? 'page' : 'scroll';
        if (swipe.lock === 'page') {
          swipe.direction = dx < 0 ? 1 : -1;
          swipe.targetMenu = getMobileSwipeTarget(swipe.direction);
          setGestureTargetMenu(swipe.targetMenu);
        }
      }
      if (swipe.lock === 'scroll') return;
      if (swipe.lock === 'page') {
        event.preventDefault();
        setPageSettling(false);
        const width = Math.max(window.innerWidth, 360);
        const visualDx = getLockedSwipeDelta(dx, swipe.direction);
        setGestureTargetMenu(Math.abs(visualDx) > 2 ? swipe.targetMenu : null);
        schedulePageDragX(getPageDragX(visualDx, width));
      }
    };
    const handleNativeTouchEnd = () => {
      const swipe = pageSwipeRef.current;
      resetPageSwipe(false);
      if (!swipe.active) return;
      if (swipe.lock !== 'page') return;
      const dx = swipe.lastX - swipe.startX;
      const dy = Math.abs(swipe.lastY - swipe.startY);
      const width = typeof window === 'undefined' ? 390 : Math.max(window.innerWidth, 360);
      const direction = swipe.direction || (dx < 0 ? 1 : -1);
      const lockedDx = getLockedSwipeDelta(dx, direction);
      const dragX = getPageDragX(lockedDx, width);
      if (Math.abs(lockedDx) < SWIPE.pageMinDistance || Math.abs(lockedDx) < dy * SWIPE.pageRatio || dy > SWIPE.pageMaxVertical) {
        const settleMs = getPageSettleMs(dragX, 0, width);
        setPageSettling(true);
        setPageSettleMs(settleMs);
        setPageDragX(0);
        window.setTimeout(() => {
          setPageSettling(false);
          setGestureTargetMenu(null);
          setPageSettleMs(220);
        }, settleMs);
        return;
      }
      switchMobileMenuBySwipe(direction, swipe.targetMenu, dragX);
    };
    const handleNativeTouchCancel = () => {
      resetPageSwipe(false);
      const settleMs = getPageSettleMs(pageDragX, 0, typeof window === 'undefined' ? 390 : Math.max(window.innerWidth, 360));
      setPageSettling(true);
      setPageSettleMs(settleMs);
      setPageDragX(0);
      window.setTimeout(() => {
        setPageSettling(false);
        setGestureTargetMenu(null);
        setPageSettleMs(220);
      }, settleMs);
    };
    document.addEventListener('touchstart', handleNativeTouchStart, { capture: true, passive: true });
    document.addEventListener('touchmove', handleNativeTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', handleNativeTouchEnd, { capture: true, passive: true });
    document.addEventListener('touchcancel', handleNativeTouchCancel, { capture: true, passive: true });
    return () => {
      document.removeEventListener('touchstart', handleNativeTouchStart, { capture: true });
      document.removeEventListener('touchmove', handleNativeTouchMove, { capture: true });
      document.removeEventListener('touchend', handleNativeTouchEnd, { capture: true });
      document.removeEventListener('touchcancel', handleNativeTouchCancel, { capture: true });
    };
  }, [getMobileSwipeTarget, pageDragX, pageSettling, resetPageSwipe, schedulePageDragX, setGestureTargetMenu, switchMobileMenuBySwipe]);
  const authProps = useMemo(() => ({
    apiBase,
    setApiBase,
    adminPassword,
    setAdminPassword,
    sitePassword,
    setSitePassword,
    userAccessToken,
    setUserAccessToken,
    addressJwt,
    setAddressJwt,
    turnstileSiteKey: typeof openSettings?.cfTurnstileSiteKey === 'string' ? openSettings.cfTurnstileSiteKey : '',
    turnstileRequired: Boolean(openSettings?.enableGlobalTurnstileCheck),
    request,
    notify: push,
    canForgetBrowser: Boolean(adminPassword || sitePassword || userAccessToken || addressJwt),
    onForgetBrowser: forgetCurrentBrowser,
  }), [addressJwt, adminPassword, apiBase, forgetCurrentBrowser, openSettings?.cfTurnstileSiteKey, openSettings?.enableGlobalTurnstileCheck, push, request, sitePassword, userAccessToken]);
  const activeSwipeIndex = mobileSwipeMenus.indexOf(activeMenu);
  const useMobileSwipeDeck = mobilePagesEnabled && connected && activeSwipeIndex >= 0;
  const renderLegacyMenus = !useMobileSwipeDeck;
  const isMailMenu = !useMobileSwipeDeck && (activeMenu === 'inbox' || activeMenu === 'sent');
  const visualActiveMenu = pageSwipeTargetMenu && Math.abs(pageDragX) > 2 ? pageSwipeTargetMenu : activeMenu;
  const swipeViewportWidth = typeof window === 'undefined' ? 390 : Math.max(window.innerWidth, 360);
  const navSwipeTargetMenu = useMobileSwipeDeck ? pageSwipeTargetMenu : null;
  const navSwipeProgress = navSwipeTargetMenu ? Math.min(1, Math.abs(pageDragX) / Math.max(swipeViewportWidth, 1)) : 0;
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (visualActiveMenu === 'inbox' || visualActiveMenu === 'sent') return;
    document.body.style.setProperty('--mobile-mail-chrome-progress', '0');
    document.body.classList.remove('mobile-mail-chrome-collapsed');
  }, [visualActiveMenu]);
  return (
    <div className={cls('h-[100dvh] w-full overflow-hidden bg-[var(--color-bg)] font-sans text-slate-800', theme === 'dark' && 'theme-dark')}>
      <div className="flex h-full w-full min-w-0 overflow-hidden bg-[var(--color-bg)]">
        <Sidebar activeMenu={activeMenu} setActiveMenu={navigateMenu} stats={stats} theme={theme} setTheme={setTheme} locale={locale} setLocale={updateLocale} refresh={refreshCurrent} apiBase={apiBase} connected={connected}>
          <AuthPanel {...authProps} initialOpen={!adminPassword && !userAccessToken} />
        </Sidebar>
        <main className={cls('mobile-page-swipe-zone relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-surface)]', isMailMenu && 'mobile-mail-shell')}>
          <Header activeMenu={visualActiveMenu} setActiveMenu={navigateMenu} query={globalQuery} setQuery={setGlobalQuery} refresh={refreshCurrent} apiBase={apiBase} locale={locale} />
          <div className={cls('min-h-0 min-w-0 flex-1 overflow-hidden md:pb-0', useMobileSwipeDeck ? 'mobile-swipe-stage pb-0' : 'pb-[calc(62px+env(safe-area-inset-bottom))]')}>
            {useMobileSwipeDeck && (
              <div className="mobile-swipe-cache h-full min-h-0 min-w-0">
                {mobileSwipeMenus.map((menu) => {
                  const offset = getPageRenderOffset(menu, activeMenu, pageSwipeTargetMenu, pageDragX);
                  const active = menu === activeMenu;
                  const isMailSwipeMenu = menu === 'inbox' || menu === 'sent';
                  const pageStyle = {
                    transform: `translate3d(calc(${offset * 100}% + ${pageDragX}px), 0, 0)`,
                    '--mobile-page-settle-ms': `${pageSettleMs}ms`,
                  } as CSSProperties;
                  return (
                    <section
                      key={menu}
                      data-menu={menu}
                      aria-hidden={!active}
                      className={cls('mobile-swipe-page h-full min-h-0 min-w-0', isMailSwipeMenu && 'mobile-mail-shell mobile-mail-swipe-page', active && 'mobile-page-current active', pageSettling && 'mobile-page-settling')}
                      style={pageStyle}
                    >
                      {renderContent(menu)}
                    </section>
                  );
                })}
              </div>
            )}
            {renderLegacyMenus && keepAliveMenus.filter((menu) => menu === activeMenu || visitedMenus.has(menu)).map((menu) => (
              <section
                key={menu}
                data-menu={menu}
                aria-hidden={menu !== activeMenu}
                className={cls('h-full min-h-0 min-w-0', menu === activeMenu ? 'block mobile-page-current' : 'hidden', menu === activeMenu && pageMotion === 'forward' && 'mobile-page-slide-forward', menu === activeMenu && pageMotion === 'back' && 'mobile-page-slide-back', menu === activeMenu && pageSettling && 'mobile-page-settling')}
                style={menu === activeMenu ? { transform: `translate3d(${pageDragX}px, 0, 0)` } : undefined}
              >
                <Suspense fallback={<ViewFallback />}>
                  {renderContent(menu)}
                </Suspense>
              </section>
            ))}
          </div>
          <MobileNav
            activeMenu={activeMenu}
            visualActiveMenu={visualActiveMenu}
            setActiveMenu={navigateMenu}
            locale={locale}
            swipeTargetMenu={navSwipeTargetMenu}
            swipeProgress={navSwipeProgress}
            settling={pageSettling}
            settleMs={pageSettleMs}
          />
        </main>
      </div>
      <NoticeToast notice={notice} />
      {confirmModal}
    </div>
  );
}
