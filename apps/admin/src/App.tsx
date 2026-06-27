import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { clearApiCache, createApiClient } from './lib/api';
import { API_BASE, STORAGE_KEYS, SWIPE } from './lib/constants';
import { readJwtFromQuery } from './lib/clipboard';
import { decodeJwtPayload, isLikelyJwt } from './lib/crypto';
import { forgetAuthBrowserStorage, normalizeAuthApiBase, purgeExpiredAuthStorage, readAccountUserToken, readBoundAuth, readStorage, writeAccountUserToken, writeBoundAuth, writeLocalStorage, writeSessionStorage } from './lib/storage';
import { cls } from './lib/format';
import { applyRuntimeLocale, getBackendLang, getRuntimeLocale, localeText, readInitialLocale, writeLocale, type AppLocale } from './lib/locale';
import type { AddressUserFilter, ComposePayload, OpenSettings, Statistics } from './types/api';
import { createAdminPreviewRequest, isAdminPreviewAvailable, isAdminPreviewEnabled } from './lib/adminPreview';
import { AuthPanel } from './components/AuthPanel';
import { BackendLogin } from './components/BackendLogin';
import { NoticeToast, useConfirm, useNotice } from './components/Common';
import { Header, Logo, MobileNav, Sidebar, mobileSwipeMenus, type MenuKey } from './components/Shell';
import { AccountConsole, DirectMailboxConsole } from './views/AccountConsole';
import { AddressView } from './views/AddressView';
import { DashboardView, StatsView } from './views/DashboardView';
import { MailWorkspace } from './views/MailWorkspace';
import { fetchUserProfile, isAdminRoleValue, type AccountUserProfile } from './lib/userAuth';

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
type AdminAccessProfile = { userEmail: string; userId: number; username: string; roleLabel: string; isAdmin: boolean };
type DirectAddressSession = { jwt: string; address: string };

function preloadAdminViewChunks() {
  void import('./views/ComposeView');
  void import('./views/UsersView');
  void import('./views/SettingsMaintenance');
}

function normalizeThemePreference(value: string | null): 'light' | 'dark' | null {
  return value === 'dark' || value === 'light' ? value : null;
}

function readThemePreference(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  try {
    const localTheme = normalizeThemePreference(window.localStorage.getItem(STORAGE_KEYS.uiTheme));
    if (localTheme) return localTheme;
    const sessionTheme = normalizeThemePreference(window.sessionStorage.getItem(STORAGE_KEYS.uiTheme));
    if (sessionTheme) return sessionTheme;
  } catch {
    // Fall back to the shared storage reader in restricted browser modes.
  }
  return readStorage(STORAGE_KEYS.uiTheme, 'light') === 'dark' ? 'dark' : 'light';
}

function writeThemePreference(theme: 'light' | 'dark'): void {
  writeLocalStorage(STORAGE_KEYS.uiTheme, theme);
  writeSessionStorage(STORAGE_KEYS.uiTheme, theme);
}

function redirectUserOAuthCallbackToAdminRoot(): boolean {
  if (typeof window === 'undefined') return false;
  const pathname = window.location.pathname.replace(/\/+$/, '');
  if (pathname !== '/user/oauth2/callback') return false;
  const source = new URL(window.location.href);
  const target = new URL('/', window.location.origin);
  const code = source.searchParams.get('code') || '';
  const state = source.searchParams.get('state') || '';
  const error = source.searchParams.get('error') || '';
  if (code) target.searchParams.set('oauth_code', code);
  if (state) target.searchParams.set('oauth_state', state);
  if (error) target.searchParams.set('oauth_error', error);
  window.location.replace(target.toString());
  return true;
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

function getAdjacentSwipeMenus(menu: MenuKey): MenuKey[] {
  const index = mobileSwipeMenus.indexOf(menu);
  if (index < 0) return [menu];
  const count = mobileSwipeMenus.length;
  return [
    mobileSwipeMenus[(index - 1 + count) % count],
    menu,
    mobileSwipeMenus[(index + 1) % count],
  ];
}

function hashStorageScope(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getMailStateScope(apiBase: string, stableAccountIdentity: string, adminPassword: string, sitePassword: string, userAccessToken: string, addressJwt: string): string {
  const normalizedBase = normalizeAuthApiBase(apiBase) || 'same-origin';
  const authIdentity = addressJwt
    ? `address:${addressJwt}`
    : stableAccountIdentity
      ? `account:${stableAccountIdentity}`
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
  return Math.round(Math.min(430, Math.max(190, 160 + distanceRatio * 250)));
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

function decodeAdminAccessProfile(token: string): AdminAccessProfile | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const userRole = payload.user_role as Record<string, unknown> | undefined;
  const roleKey = String(
    payload.role_key
      || payload.roleKey
      || payload.role
      || payload.role_text
      || userRole?.role
      || userRole?.role_text
      || userRole?.label
      || ''
  ).trim().toLowerCase();
  const profile = {
    userEmail: String(payload.user_email || payload.userEmail || payload.email || ''),
    userId: Number(payload.user_id || payload.userId || 0),
    username: String(payload.username || payload.user_name || payload.name || payload.preferred_username || ''),
    roleLabel: String(userRole?.label || userRole?.role || payload.roleLabel || roleKey || ''),
    isAdmin: Boolean(payload.is_admin || payload.isAdmin) || isAdminRoleValue(roleKey),
  };
  return profile.isAdmin ? profile : null;
}

function consumeUserAccessTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const hashParams = hashSearchParams(url.hash);
  const tokenKeys = ['access_token', 'user_access_token', 'userAccessToken'];
  const hasQueryToken = tokenKeys.some((key) => url.searchParams.has(key));
  const hasHashToken = tokenKeys.some((key) => hashParams.has(key));
  const hasToken = hasQueryToken || hasHashToken;
  if (!hasToken) return;
  tokenKeys.forEach((key) => url.searchParams.delete(key));
  if (hasHashToken) url.hash = '';
  const search = url.searchParams.toString();
  const cleanUrl = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
  window.history.replaceState(null, document.title, cleanUrl || '/');
}

function hashSearchParams(hash: string): URLSearchParams {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return new URLSearchParams();
  const query = raw.startsWith('?') ? raw.slice(1) : raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw;
  return new URLSearchParams(query);
}

function safeUrlSecret(value: string, maxLength = 512): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\r\n\0]/.test(trimmed)) return '';
  return trimmed;
}

function safeUrlApiBase(value: string): string {
  const normalized = normalizeAuthApiBase(value);
  if (!normalized || normalized.length > 300 || /[\r\n\0]/.test(normalized)) return '';
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return '';
    return normalized;
  } catch {
    return '';
  }
}

function consumeAdminConnectionFromUrl(): { adminPassword: string; apiBase: string } {
  if (typeof window === 'undefined') return { adminPassword: '', apiBase: '' };
  const url = new URL(window.location.href);
  const hashParams = hashSearchParams(url.hash);
  const adminKeys = ['admin_password', 'adminPassword', 'api_base', 'apiBase'];
  const hasQueryAdminConnection = adminKeys.some((key) => url.searchParams.has(key));
  const hasHashAdminConnection = adminKeys.some((key) => hashParams.has(key));
  const adminPassword = safeUrlSecret(
    hashParams.get('admin_password')
      || hashParams.get('adminPassword')
      || url.searchParams.get('admin_password')
      || url.searchParams.get('adminPassword')
      || ''
  );
  const apiBase = safeUrlApiBase(
    hashParams.get('api_base')
      || hashParams.get('apiBase')
      || url.searchParams.get('api_base')
      || url.searchParams.get('apiBase')
      || ''
  );
  if (hasQueryAdminConnection || hasHashAdminConnection) {
    url.searchParams.delete('admin_password');
    url.searchParams.delete('adminPassword');
    url.searchParams.delete('api_base');
    url.searchParams.delete('apiBase');
    if (hasHashAdminConnection) url.hash = '';
    const search = url.searchParams.toString();
    const cleanUrl = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
    window.history.replaceState(null, document.title, cleanUrl || '/');
  }
  return { adminPassword, apiBase };
}

function ViewFallback() {
  const locale = getRuntimeLocale();
  return <div className="view-fallback flex h-full items-center justify-center text-sm text-slate-400">{localeText('视图加载中...', 'Loading view...', locale)}</div>;
}

function AdminAccessGate({ locale, theme, hasRejectedToken }: { locale: AppLocale; theme: 'light' | 'dark'; hasRejectedToken: boolean }) {
  const loginHref = '/';
  return (
    <div className={cls('flex h-[100dvh] w-full items-center justify-center bg-[var(--color-bg)] px-5 font-sans text-slate-800', theme === 'dark' && 'theme-dark')}>
      <section className="panel w-full max-w-md p-5 md:p-6">
        <div className="mb-5 flex items-center gap-3">
          <Logo />
          <div>
            <h1 className="brand-wordmark text-xl font-semibold text-slate-950">Loven7-Mail</h1>
            <p className="text-xs text-slate-400">{localeText('管理员后台', 'Admin console', locale)}</p>
          </div>
        </div>
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">{localeText('请使用管理员账号登录', 'Sign in with an admin account', locale)}</h2>
          <p className="text-sm leading-6 text-slate-500">
            {hasRejectedToken
              ? localeText('当前登录凭据不是管理员身份或已经失效。', 'The current credential is not an admin identity or has expired.', locale)
              : localeText('请返回登录页并使用管理员账号。', 'Return to the sign-in page and use an admin account.', locale)}
          </p>
          <a className="btn-primary compact w-full justify-center" href={loginHref}>{localeText('返回登录页', 'Back to sign in', locale)}</a>
        </div>
      </section>
    </div>
  );
}

const USER_OAUTH_CALLBACK_REDIRECTING = redirectUserOAuthCallbackToAdminRoot();
const INITIAL_AUTH_EXPIRY_CHECK = purgeExpiredAuthStorage();

function readInitialConnection() {
  const apiBase = normalizeAuthApiBase(API_BASE);
  consumeAdminConnectionFromUrl();
  const storedAuth = readBoundAuth(apiBase);
  consumeAddressJwtFromUrl();
  consumeUserAccessTokenFromUrl();
  return {
    ...storedAuth,
    adminPassword: '',
    sitePassword: '',
    addressJwt: '',
    apiBase,
  };
}

const INITIAL_CONNECTION = readInitialConnection();

export default function App() {
  if (USER_OAUTH_CALLBACK_REDIRECTING) {
    return <div className="flex h-[100dvh] w-full items-center justify-center bg-[var(--color-bg)] text-sm text-slate-500">正在跳转登录...</div>;
  }

  const adminPreviewMode = isAdminPreviewEnabled();
  const adminPreviewAvailable = isAdminPreviewAvailable();
  const [activeMenu, setActiveMenu] = useState<MenuKey>(() => (adminPreviewMode ? 'inbox' : 'dashboard'));
  const [pageMotion, setPageMotion] = useState<'forward' | 'back' | ''>('');
  const [pageDragX, setPageDragX] = useState(0);
  const [pageSettling, setPageSettling] = useState(false);
  const [pageSettleMs, setPageSettleMs] = useState(220);
  const [pageSwipeTargetMenu, setPageSwipeTargetMenu] = useState<MenuKey | null>(null);
  const [mobileTransitionMenu, setMobileTransitionMenu] = useState<MenuKey | null>(null);
  const [visitedMenus, setVisitedMenus] = useState<Set<MenuKey>>(() => new Set(['dashboard']));
  const [mobilePagesEnabled, setMobilePagesEnabled] = useState(() => isMobileViewport());
  const [globalQuery, setGlobalQuery] = useState('');
  const [apiBase, setApiBase] = useState(() => INITIAL_CONNECTION.apiBase);
  const [adminPassword, setAdminPassword] = useState(() => INITIAL_CONNECTION.adminPassword);
  const [sitePassword, setSitePassword] = useState(() => INITIAL_CONNECTION.sitePassword);
  const [userAccessToken, setUserAccessToken] = useState(() => INITIAL_CONNECTION.userAccessToken);
  const [addressJwt, setAddressJwt] = useState(() => INITIAL_CONNECTION.addressJwt);
  const [directAddress, setDirectAddress] = useState('');
  const [accountUserToken, setAccountUserToken] = useState(() => readAccountUserToken());
  const [accountProfile, setAccountProfile] = useState<AccountUserProfile | null>(null);
  const [accountBooting, setAccountBooting] = useState(() => Boolean(readAccountUserToken()));
  const [theme, setThemeState] = useState<'light' | 'dark'>(() => readThemePreference());
  const [locale, setLocale] = useState<AppLocale>(() => readInitialLocale());
  const [stats, setStats] = useState<Statistics>(emptyStats);
  const [statsLoading, setStatsLoading] = useState(false);
  const [openSettings, setOpenSettings] = useState<OpenSettings | null>(null);
  const [composeSeed, setComposeSeed] = useState<Partial<ComposePayload>>({});
  const [authExpiredNoticePending, setAuthExpiredNoticePending] = useState(() => INITIAL_AUTH_EXPIRY_CHECK.expired || Boolean(readStorage(STORAGE_KEYS.authExpiredNotice, '')));
  const [addressUserFilter, setAddressUserFilter] = useState<AddressUserFilter | null>(() => readInitialAddressUserFilter());
  const [mailboxAddressRequest, setMailboxAddressRequest] = useState<MailboxAddressRequest | null>(null);
  const pageSwipeRef = useRef<PageSwipeState>(createPageSwipeState());
  const activeMenuRef = useRef<MenuKey>('dashboard');
  const pageSwipeTargetMenuRef = useRef<MenuKey | null>(null);
  const mobileSwipeCacheRef = useRef<HTMLDivElement | null>(null);
  const mobilePageRefs = useRef<Map<MenuKey, HTMLElement>>(new Map());
  const swipeViewportWidthRef = useRef(390);
  const pageDragXValueRef = useRef(0);
  const pageDragXStateRef = useRef(0);
  const pageDragXStateAtRef = useRef(0);
  const pageAnimationFrameRef = useRef<number | null>(null);
  const pageAnimationSecondFrameRef = useRef<number | null>(null);
  const pageTransitionTimerRef = useRef<number | null>(null);
  const themeTransitionTimerRef = useRef<number | null>(null);
  const pageTransitionSeqRef = useRef(0);
  const mobileTransitionMenuRef = useRef<MenuKey | null>(null);
  const credentialFingerprintRef = useRef<string | null>(null);
  const authResetSeqRef = useRef(0);
  const { notice, push } = useNotice();
  const { ask, modal: confirmModal } = useConfirm();
  const getSwipeViewportWidth = useCallback(() => {
    const width = mobileSwipeCacheRef.current?.clientWidth || (typeof window === 'undefined' ? 390 : window.innerWidth);
    swipeViewportWidthRef.current = Math.max(width, 360);
    return swipeViewportWidthRef.current;
  }, []);
  const applyMobilePageTransforms = useCallback((value = pageDragXValueRef.current) => {
    const width = getSwipeViewportWidth();
    const currentMenu = activeMenuRef.current;
    const targetMenu = pageSwipeTargetMenuRef.current;
    mobilePageRefs.current.forEach((node, menu) => {
      const offset = getPageRenderOffset(menu, currentMenu, targetMenu, value);
      node.style.transform = `translate3d(${Math.round((offset * width + value) * 100) / 100}px, 0, 0)`;
    });
  }, [getSwipeViewportWidth]);
  const commitPageDragX = useCallback((value: number, forceState = false) => {
    pageDragXValueRef.current = value;
    if (mobileSwipeCacheRef.current) {
      mobileSwipeCacheRef.current.style.setProperty('--mobile-page-drag-x', `${value}px`);
    }
    applyMobilePageTransforms(value);
    if (typeof document !== 'undefined') {
      const width = getSwipeViewportWidth();
      document.documentElement.style.setProperty('--mobile-nav-live-progress', `${Math.min(1, Math.abs(value) / width).toFixed(4)}`);
    }
    if (!forceState) return;
    pageDragXStateRef.current = value;
    pageDragXStateAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
    setPageDragX(value);
  }, [applyMobilePageTransforms, getSwipeViewportWidth]);
  const cancelPendingPageAnimation = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (pageAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(pageAnimationFrameRef.current);
      pageAnimationFrameRef.current = null;
    }
    if (pageAnimationSecondFrameRef.current !== null) {
      window.cancelAnimationFrame(pageAnimationSecondFrameRef.current);
      pageAnimationSecondFrameRef.current = null;
    }
  }, []);
  const updateMobileTransitionMenu = useCallback((menu: MenuKey | null) => {
    mobileTransitionMenuRef.current = menu;
    setMobileTransitionMenu(menu);
  }, []);
  const applyPreservedMobileMailChrome = useCallback((menu: MenuKey | null) => {
    if (typeof document === 'undefined') return false;
    if (menu !== 'inbox' && menu !== 'sent') return false;
    const root = document.documentElement;
    const preservedForMenu = root.style.getPropertyValue(`--mobile-mail-preserved-chrome-progress-${menu}`).trim();
    const preserved = preservedForMenu || root.style.getPropertyValue('--mobile-mail-preserved-chrome-progress').trim();
    const progress = preserved ? Math.max(0, Math.min(1, Number.parseFloat(preserved) || 0)) : 0;
    document.body.style.setProperty('--mobile-mail-chrome-progress', progress.toFixed(3));
    document.body.classList.toggle('mobile-mail-chrome-collapsed', progress >= 0.92);
    return true;
  }, []);
  const syncMobileChromeForMenu = useCallback((menu: MenuKey | null) => {
    if (applyPreservedMobileMailChrome(menu)) return;
    if (typeof document === 'undefined') return;
    document.body.style.setProperty('--mobile-mail-chrome-progress', '0');
    document.body.classList.remove('mobile-mail-chrome-collapsed');
  }, [applyPreservedMobileMailChrome]);
  const settleMobilePageAt = useCallback((menu: MenuKey) => {
    cancelPendingPageAnimation();
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--mobile-nav-live-progress', '0');
    }
    activeMenuRef.current = menu;
    syncMobileChromeForMenu(menu);
    pageSwipeTargetMenuRef.current = null;
    setActiveMenu(menu);
    setPageSettling(false);
    setPageSwipeTargetMenu(null);
    updateMobileTransitionMenu(null);
    commitPageDragX(0, true);
    setPageMotion('');
    setPageSettleMs(220);
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        activeMenuRef.current = menu;
        pageSwipeTargetMenuRef.current = null;
        commitPageDragX(0, true);
      });
    }
  }, [cancelPendingPageAnimation, commitPageDragX, syncMobileChromeForMenu, updateMobileTransitionMenu]);
  const animatePageDragX = useCallback((value: number, forceState = true) => {
    if (typeof window === 'undefined') {
      commitPageDragX(value, forceState);
      return;
    }
    cancelPendingPageAnimation();
    pageAnimationFrameRef.current = window.requestAnimationFrame(() => {
      pageAnimationFrameRef.current = null;
      pageAnimationSecondFrameRef.current = window.requestAnimationFrame(() => {
        pageAnimationSecondFrameRef.current = null;
        commitPageDragX(value, forceState);
      });
    });
  }, [cancelPendingPageAnimation, commitPageDragX]);
  const clearRecoveredAccountAuth = useCallback(() => {
    writeAccountUserToken('');
    writeBoundAuth(apiBase, { adminPassword: '', sitePassword: '', userAccessToken: '', addressJwt: '' });
    clearApiCache();
    setAccountProfile(null);
    setAccountUserToken('');
    setAdminPassword('');
    setSitePassword('');
    setUserAccessToken('');
    setAddressJwt('');
    setDirectAddress('');
  }, [apiBase]);
  const applyAccountLogin = useCallback(async (profile: AccountUserProfile) => {
    const activeProfile = profile.newUserToken
      ? { ...profile, userToken: profile.newUserToken, newUserToken: undefined }
      : profile;
    const confirmedAdmin = activeProfile.isAdmin || isAdminRoleValue(activeProfile.roleKey);
    activeProfile.isAdmin = confirmedAdmin;
    if (!confirmedAdmin) activeProfile.accessToken = '';
    setAccountProfile(activeProfile);
    setAccountUserToken(activeProfile.userToken);
    writeAccountUserToken(activeProfile.userToken);
    setAddressJwt('');
    setDirectAddress('');
    setStats(emptyStats);
    setActiveMenu('dashboard');
    const adminToken = confirmedAdmin ? (activeProfile.accessToken || activeProfile.userToken) : '';
    if (adminToken) {
      const rememberedAt = Date.now();
      setAdminPassword('');
      setUserAccessToken(adminToken);
      writeBoundAuth(apiBase, {
        adminPassword: '',
        sitePassword: '',
        userAccessToken: adminToken,
        addressJwt: '',
        rememberedAt,
      }, rememberedAt);
      push('success', localeText('已进入管理员后台。', 'Admin console opened.', locale));
      return;
    }
    setAdminPassword('');
    setUserAccessToken('');
    writeBoundAuth(apiBase, { adminPassword: '', sitePassword: '', userAccessToken: '', addressJwt: '' });
    push('success', localeText('已进入个人邮箱后台。', 'Personal mailbox console opened.', locale));
  }, [apiBase, locale, push]);
  const applyDirectLogin = useCallback((session: DirectAddressSession) => {
    setAddressJwt(session.jwt);
    setDirectAddress(session.address);
    setAccountProfile(null);
    setAccountUserToken('');
    writeAccountUserToken('');
    setAdminPassword('');
    setUserAccessToken('');
    writeBoundAuth(apiBase, { adminPassword: '', sitePassword: '', userAccessToken: '', addressJwt: '' });
    push('success', localeText('已进入邮箱。', 'Mailbox opened.', locale));
  }, [apiBase, locale, push]);
  useEffect(() => {
    if (!accountUserToken) {
      setAccountBooting(false);
      return;
    }
    let cancelled = false;
    setAccountBooting(true);
    fetchUserProfile(apiBase, accountUserToken)
      .then((profile) => {
        if (!cancelled) applyAccountLogin(profile);
      })
      .catch(() => {
        if (!cancelled) {
          clearRecoveredAccountAuth();
        }
      })
      .finally(() => {
        if (!cancelled) setAccountBooting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountUserToken, apiBase, applyAccountLogin, clearRecoveredAccountAuth]);
  const decodedAdminAccessProfile = useMemo(() => decodeAdminAccessProfile(userAccessToken), [userAccessToken]);
  const adminAccessProfile = decodedAdminAccessProfile || (accountProfile?.isAdmin && userAccessToken ? {
    userEmail: accountProfile.userEmail,
    userId: accountProfile.userId,
    username: accountProfile.username,
    roleLabel: accountProfile.roleLabel || 'Admin',
    isAdmin: true,
  } : null);
  const effectiveUserAccessToken = adminAccessProfile ? userAccessToken : '';
  const effectiveAdminPassword = adminPassword;
  const effectiveAccountUserToken = accountUserToken || accountProfile?.userToken || '';
  const client = useMemo(() => createApiClient(() => apiBase, () => ({
    adminPassword: effectiveAdminPassword,
    sitePassword: '',
    userAccessToken: effectiveUserAccessToken,
    accountUserToken: effectiveAccountUserToken,
    addressJwt: '',
    lang: getBackendLang(locale),
  })), [apiBase, effectiveAccountUserToken, effectiveAdminPassword, effectiveUserAccessToken, locale]);
  const previewRequest = useMemo(() => createAdminPreviewRequest(), []);
  const request = useCallback(<T,>(path: string, options?: Parameters<typeof client.request>[1]) => (
    adminPreviewMode ? previewRequest<T>(path, options) : client.request<T>(path, options)
  ), [adminPreviewMode, client, previewRequest]);
  const connected = adminPreviewMode || Boolean(effectiveAdminPassword || effectiveUserAccessToken);
  const authenticatedView = connected || Boolean(accountProfile) || Boolean(addressJwt && directAddress);
  const themeShellEligible = authenticatedView || accountBooting || Boolean(accountUserToken);
  const stableMailAccountIdentity = useMemo(() => {
    const profile = accountProfile || adminAccessProfile;
    if (profile?.userId) return `user:${profile.userId}`;
    if (profile?.userEmail) return `email:${profile.userEmail.trim().toLowerCase()}`;
    return '';
  }, [accountProfile, adminAccessProfile]);
  const mailStateScope = useMemo(() => getMailStateScope(apiBase, stableMailAccountIdentity, effectiveAdminPassword, '', effectiveUserAccessToken, ''), [apiBase, effectiveAdminPassword, effectiveUserAccessToken, stableMailAccountIdentity]);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const query = window.matchMedia('(max-width: 900px), (hover: none) and (pointer: coarse)');
    const update = () => setMobilePagesEnabled(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    activeMenuRef.current = activeMenu;
    applyMobilePageTransforms(pageDragXValueRef.current);
  }, [activeMenu, applyMobilePageTransforms]);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleResize = () => applyMobilePageTransforms(pageDragXValueRef.current);
    window.addEventListener('resize', handleResize, { passive: true });
    window.addEventListener('orientationchange', handleResize, { passive: true });
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [applyMobilePageTransforms]);
  const loadStats = useCallback(async (forceRefresh = false) => {
    const seq = authResetSeqRef.current;
    setStatsLoading(true);
    try {
      const res = await request<Statistics>('/admin/statistics', { forceRefresh, cacheTtlMs: 30_000 });
      if (seq === authResetSeqRef.current && connected) setStats({ ...emptyStats, ...res });
    } catch (error) {
      if (seq === authResetSeqRef.current && connected) push('error', error instanceof Error ? error.message : localeText('统计加载失败', 'Failed to load stats', locale));
    } finally {
      if (seq === authResetSeqRef.current) setStatsLoading(false);
    }
  }, [connected, locale, push, request]);
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
  useEffect(() => { if (connected) loadStats(); }, [connected, loadStats]);
  useEffect(() => {
    const fingerprint = `${apiBase}|${effectiveAdminPassword}|${effectiveUserAccessToken}`;
    if (credentialFingerprintRef.current !== null && credentialFingerprintRef.current !== fingerprint) clearApiCache();
    credentialFingerprintRef.current = fingerprint;
  }, [apiBase, effectiveAdminPassword, effectiveUserAccessToken]);
  useEffect(() => { writeLocalStorage(STORAGE_KEYS.addressUserFilter, addressUserFilter ? JSON.stringify(addressUserFilter) : ''); }, [addressUserFilter]);
  useEffect(() => {
    setVisitedMenus((current) => {
      if (current.has(activeMenu)) return current;
      const next = new Set(current);
      next.add(activeMenu);
      return next;
    });
  }, [activeMenu]);
  const setTheme = useCallback((nextTheme: 'light' | 'dark') => {
    if (nextTheme === theme) return;
    writeThemePreference(nextTheme);
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      setThemeState(nextTheme);
      return;
    }
    const root = document.documentElement;
    const body = document.body;
    const clearTransitionClass = () => {
      root.classList.remove('theme-transitioning');
      body.classList.remove('theme-transitioning');
    };
    if (themeTransitionTimerRef.current !== null) {
      window.clearTimeout(themeTransitionTimerRef.current);
      themeTransitionTimerRef.current = null;
    }
    root.classList.add('theme-transitioning');
    body.classList.add('theme-transitioning');
    const useDarkTheme = nextTheme === 'dark' && themeShellEligible;
    root.classList.toggle('theme-dark', useDarkTheme);
    body.classList.toggle('theme-dark', useDarkTheme);
    root.style.colorScheme = useDarkTheme ? 'dark' : 'light';
    body.style.colorScheme = useDarkTheme ? 'dark' : 'light';
    setThemeState(nextTheme);
    themeTransitionTimerRef.current = window.setTimeout(() => {
      clearTransitionClass();
      themeTransitionTimerRef.current = null;
    }, 180);
  }, [theme, themeShellEligible]);

  useLayoutEffect(() => {
    writeThemePreference(theme);
    if (typeof document === 'undefined') return;
    const useDarkTheme = theme === 'dark' && themeShellEligible;
    document.documentElement.classList.toggle('theme-dark', useDarkTheme);
    document.body.classList.toggle('theme-dark', useDarkTheme);
    document.documentElement.style.colorScheme = useDarkTheme ? 'dark' : 'light';
    document.body.style.colorScheme = useDarkTheme ? 'dark' : 'light';
  }, [theme, themeShellEligible]);
  useEffect(() => () => {
    if (themeTransitionTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(themeTransitionTimerRef.current);
    }
  }, []);
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
        '将清除本机保存的账号授权、地址登录和管理列表/邮件缓存；主题、语言和界面偏好会保留。',
        'This clears saved account authorization, address login, and local admin list/mail caches on this browser. Theme, language, and UI preferences are kept.',
        currentLocale,
      ),
      actionLabel: localeText('退出并清理', 'Sign out and clear', currentLocale),
      onConfirm: () => {
        const preservedApiBase = apiBase.trim();
        authResetSeqRef.current += 1;
        forgetAuthBrowserStorage();
        writeAccountUserToken('');
        if (preservedApiBase) writeLocalStorage(STORAGE_KEYS.apiBase, preservedApiBase);
        clearApiCache();
        setAdminPassword('');
        setSitePassword('');
        setUserAccessToken('');
        setAddressJwt('');
        setDirectAddress('');
        setAccountUserToken('');
        setAccountProfile(null);
        setAccountBooting(false);
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
        pageTransitionSeqRef.current += 1;
        cancelPendingPageAnimation();
        settleMobilePageAt('dashboard');
        credentialFingerprintRef.current = null;
        window.setTimeout(() => {
          const hasFreshAuth = Boolean(readStorage(STORAGE_KEYS.adminPassword, '') || readStorage(STORAGE_KEYS.sitePassword, '') || readStorage(STORAGE_KEYS.userAccessToken, '') || readStorage(STORAGE_KEYS.addressJwt, ''));
          if (!hasFreshAuth) forgetAuthBrowserStorage();
        }, 900);
        push('success', localeText('已退出，并清除本机保存的敏感凭据和管理缓存。', 'Signed out and cleared saved sensitive credentials plus admin caches on this browser.', currentLocale));
      },
    });
  }, [apiBase, ask, cancelPendingPageAnimation, push, settleMobilePageAt]);
  const refreshCurrent = () => {
    clearApiCache();
    loadOpenSettings(true);
    loadStats(true);
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('loven7-global-refresh', { detail: { menu: activeMenu } }));
  };
  const navigateMenu = useCallback((menu: MenuKey) => {
    if (activeMenuRef.current === menu) {
      if (mobileTransitionMenuRef.current && mobileTransitionMenuRef.current !== menu && mobilePagesEnabled && connected) {
        pageTransitionSeqRef.current += 1;
        if (pageTransitionTimerRef.current !== null) {
          window.clearTimeout(pageTransitionTimerRef.current);
          pageTransitionTimerRef.current = null;
        }
        const width = getSwipeViewportWidth();
        const duration = getPageSettleMs(pageDragXValueRef.current, 0, width);
        setPageSettleMs(duration);
        setPageSettling(true);
        setPageMotion('');
        pageSwipeTargetMenuRef.current = null;
        setPageSwipeTargetMenu(null);
        updateMobileTransitionMenu(null);
        animatePageDragX(0, true);
        const transitionSeq = pageTransitionSeqRef.current;
        pageTransitionTimerRef.current = window.setTimeout(() => {
          if (transitionSeq !== pageTransitionSeqRef.current) return;
          settleMobilePageAt(menu);
          pageTransitionTimerRef.current = null;
        }, duration);
        return;
      }
      if (typeof window !== 'undefined' && (menu === 'inbox' || menu === 'sent' || menu === 'unknown')) {
        window.dispatchEvent(new CustomEvent('loven7-global-refresh', { detail: { menu, source: 'repeat-menu-click' } }));
      }
      return;
    }
    setActiveMenu((current) => {
      if (current === menu) return current;
      const currentIndex = mobileSwipeMenus.indexOf(current);
      const nextIndex = mobileSwipeMenus.indexOf(menu);
      if (currentIndex >= 0 && nextIndex >= 0 && mobilePagesEnabled && connected) {
        pageTransitionSeqRef.current += 1;
        if (pageTransitionTimerRef.current !== null) {
          window.clearTimeout(pageTransitionTimerRef.current);
          pageTransitionTimerRef.current = null;
        }
        const width = getSwipeViewportWidth();
        const offset = getCircularOffset(menu, current);
        const targetX = -offset * width;
        const duration = getPageSettleMs(0, targetX, width);
        const adjacentTarget = Math.abs(offset) === 1 ? menu : null;
        setPageSettleMs(duration);
        setPageSettling(true);
        updateMobileTransitionMenu(menu);
        setPageMotion('');
        pageSwipeTargetMenuRef.current = adjacentTarget;
        setPageSwipeTargetMenu(adjacentTarget);
        setVisitedMenus((visited) => {
          if (visited.has(menu)) return visited;
          const next = new Set(visited);
          next.add(menu);
          return next;
        });
        animatePageDragX(targetX, true);
        const transitionSeq = pageTransitionSeqRef.current;
        pageTransitionTimerRef.current = window.setTimeout(() => {
          if (transitionSeq !== pageTransitionSeqRef.current) return;
          settleMobilePageAt(menu);
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
  }, [animatePageDragX, connected, getSwipeViewportWidth, mobilePagesEnabled, settleMobilePageAt, updateMobileTransitionMenu]);
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
    if (menu === 'address') return <MemoAddressView request={request} notify={push} ask={ask} globalQuery={globalQuery} openSettings={openSettings} userFilter={addressUserFilter} userTotal={stats.userCount} onClearUserFilter={clearAddressUserFilter} onOpenInbox={openAddressInbox} adminAccessToken={effectiveUserAccessToken} />;
    if (menu === 'users') return <UsersView request={request} notify={push} ask={ask} globalQuery={globalQuery} onFilterUserAddresses={filterUserAddresses} />;
    if (menu === 'inbox' || menu === 'sent' || menu === 'unknown') {
      const visualMenu = pageSwipeTargetMenu && Math.abs(pageDragX) > 2 ? pageSwipeTargetMenu : activeMenu;
      return (
        <div key={`${menu}:${mailStateScope}`} className="h-full min-h-0">
          <MemoMailWorkspace mode={menu} active={activeMenu === menu} visualActive={visualMenu === menu} request={request} notify={push} ask={ask} globalQuery={globalQuery} addressRequest={menu === 'inbox' ? mailboxAddressRequest : null} setActiveMenu={navigateMenu} setComposeSeed={setComposeSeed} mailStateScope={mailStateScope} theme={theme} />
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
      commitPageDragX(pageSwipeRef.current.pendingX);
    });
  }, [commitPageDragX]);
  const resetPageSwipe = useCallback((clearTarget = true) => {
    if (pageSwipeRef.current.rafId) {
      window.cancelAnimationFrame(pageSwipeRef.current.rafId);
    }
    pageSwipeRef.current = createPageSwipeState();
    if (clearTarget) {
      pageSwipeTargetMenuRef.current = null;
      setPageSwipeTargetMenu(null);
      updateMobileTransitionMenu(null);
    }
  }, [updateMobileTransitionMenu]);
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
    const width = getSwipeViewportWidth();
    const currentDragX = dragOverride ?? getPageDragX(getLockedSwipeDelta(pageSwipeRef.current.lastX - pageSwipeRef.current.startX, direction), width);
    const targetX = direction === 1 ? -width : width;
    const duration = getPageSettleMs(currentDragX, targetX, width);
    pageTransitionSeqRef.current += 1;
    if (pageTransitionTimerRef.current !== null) {
      window.clearTimeout(pageTransitionTimerRef.current);
      pageTransitionTimerRef.current = null;
    }
    setPageSettleMs(duration);
    setPageSettling(true);
    updateMobileTransitionMenu(nextMenu);
    setGestureTargetMenu(nextMenu);
    setPageMotion('');
    setVisitedMenus((current) => {
      if (current.has(nextMenu)) return current;
      const next = new Set(current);
      next.add(nextMenu);
      return next;
    });
    animatePageDragX(targetX, true);
    const transitionSeq = pageTransitionSeqRef.current;
    pageTransitionTimerRef.current = window.setTimeout(() => {
      if (transitionSeq !== pageTransitionSeqRef.current) return;
      setGestureTargetMenu(null);
      settleMobilePageAt(nextMenu);
      pageTransitionTimerRef.current = null;
    }, duration);
  }, [activeMenu, animatePageDragX, getMobileSwipeTarget, getSwipeViewportWidth, setGestureTargetMenu, settleMobilePageAt, updateMobileTransitionMenu]);
  useEffect(() => () => {
    if (pageTransitionTimerRef.current !== null) window.clearTimeout(pageTransitionTimerRef.current);
    cancelPendingPageAnimation();
  }, [cancelPendingPageAnimation]);
  useEffect(() => {
    const handleNativeTouchStart = (event: TouchEvent) => {
      if (pageSettling) return;
      if (!isMobileViewport() || event.touches.length !== 1 || shouldIgnorePageSwipe(event.target)) return;
      const touch = event.touches[0];
      if (pageSwipeRef.current.rafId) window.cancelAnimationFrame(pageSwipeRef.current.rafId);
      pageSwipeRef.current = { ...createPageSwipeState(), active: true, startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastY: touch.clientY };
      document.documentElement.style.setProperty('--mobile-nav-live-progress', '0');
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
          applyPreservedMobileMailChrome(swipe.targetMenu);
          setGestureTargetMenu(swipe.targetMenu);
        }
      }
      if (swipe.lock === 'scroll') return;
      if (swipe.lock === 'page') {
        event.preventDefault();
        setPageSettling(false);
        const width = getSwipeViewportWidth();
        const visualDx = getLockedSwipeDelta(dx, swipe.direction);
        const visibleTargetMenu = Math.abs(visualDx) > 2 ? swipe.targetMenu : null;
        if (visibleTargetMenu) applyPreservedMobileMailChrome(visibleTargetMenu);
        setGestureTargetMenu(visibleTargetMenu);
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
      const width = getSwipeViewportWidth();
      const direction = swipe.direction || (dx < 0 ? 1 : -1);
      const lockedDx = getLockedSwipeDelta(dx, direction);
      const dragX = getPageDragX(lockedDx, width);
      const commitDistance = Math.max(SWIPE.pageMinDistance, width * 0.34);
      if (Math.abs(lockedDx) < commitDistance || Math.abs(lockedDx) < dy * SWIPE.pageRatio || dy > SWIPE.pageMaxVertical) {
        const settleMs = getPageSettleMs(dragX, 0, width);
        pageTransitionSeqRef.current += 1;
        setPageSettling(true);
        setPageSettleMs(settleMs);
        animatePageDragX(0, true);
        const transitionSeq = pageTransitionSeqRef.current;
        window.setTimeout(() => {
          if (transitionSeq !== pageTransitionSeqRef.current) return;
          syncMobileChromeForMenu(activeMenuRef.current);
          setPageSettling(false);
          setGestureTargetMenu(null);
          updateMobileTransitionMenu(null);
          setPageSettleMs(220);
        }, settleMs);
        return;
      }
      switchMobileMenuBySwipe(direction, swipe.targetMenu, dragX);
    };
    const handleNativeTouchCancel = () => {
      resetPageSwipe(false);
      const settleMs = getPageSettleMs(pageDragXValueRef.current, 0, getSwipeViewportWidth());
      pageTransitionSeqRef.current += 1;
      setPageSettling(true);
      setPageSettleMs(settleMs);
      animatePageDragX(0, true);
      const transitionSeq = pageTransitionSeqRef.current;
      window.setTimeout(() => {
        if (transitionSeq !== pageTransitionSeqRef.current) return;
        syncMobileChromeForMenu(activeMenuRef.current);
        setPageSettling(false);
        setGestureTargetMenu(null);
        updateMobileTransitionMenu(null);
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
  }, [animatePageDragX, applyPreservedMobileMailChrome, getMobileSwipeTarget, getSwipeViewportWidth, pageSettling, resetPageSwipe, schedulePageDragX, setGestureTargetMenu, switchMobileMenuBySwipe, syncMobileChromeForMenu, updateMobileTransitionMenu]);
  const authProps = useMemo(() => ({
    apiBase,
    setApiBase,
    adminPassword: effectiveAdminPassword,
    setAdminPassword,
    sitePassword: '',
    setSitePassword,
    userAccessToken: effectiveUserAccessToken,
    setUserAccessToken,
    adminRoleConfirmed: Boolean(adminAccessProfile || accountProfile?.isAdmin),
    addressJwt: '',
    setAddressJwt,
    turnstileSiteKey: typeof openSettings?.cfTurnstileSiteKey === 'string' ? openSettings.cfTurnstileSiteKey : '',
    turnstileRequired: Boolean(openSettings?.enableGlobalTurnstileCheck),
    request,
    notify: push,
    canForgetBrowser: connected && !adminPreviewMode,
    onForgetBrowser: forgetCurrentBrowser,
  }), [accountProfile?.isAdmin, adminAccessProfile, adminPreviewMode, apiBase, connected, effectiveAdminPassword, effectiveUserAccessToken, forgetCurrentBrowser, openSettings?.cfTurnstileSiteKey, openSettings?.enableGlobalTurnstileCheck, push, request]);
  const activeSwipeIndex = mobileSwipeMenus.indexOf(activeMenu);
  const useMobileSwipeDeck = mobilePagesEnabled && connected && activeSwipeIndex >= 0;
  const renderLegacyMenus = !useMobileSwipeDeck;
  const isMailMenu = !useMobileSwipeDeck && (activeMenu === 'inbox' || activeMenu === 'sent');
  const visualActiveMenu = pageSwipeTargetMenu && Math.abs(pageDragX) > 2 ? pageSwipeTargetMenu : mobileTransitionMenu || activeMenu;
  const swipeViewportWidth = typeof window === 'undefined' ? 390 : Math.max(window.innerWidth, 360);
  const navSwipeTargetMenu = useMobileSwipeDeck ? (pageSwipeTargetMenu || mobileTransitionMenu) : null;
  const navUsesLiveProgress = Boolean(useMobileSwipeDeck && pageSwipeTargetMenu);
  const navSwipeDistance = navSwipeTargetMenu
    ? Math.max(1, Math.abs(getCircularOffset(navSwipeTargetMenu, activeMenu))) * Math.max(swipeViewportWidth, 1)
    : Math.max(swipeViewportWidth, 1);
  const navSwipeProgress = navSwipeTargetMenu ? Math.min(1, Math.abs(pageDragX) / navSwipeDistance) : 0;
  const mobileRenderedMenus = useMemo(() => {
    const rendered = new Set<MenuKey>(getAdjacentSwipeMenus(activeMenu));
    if (pageSwipeTargetMenu) rendered.add(pageSwipeTargetMenu);
    if (mobileTransitionMenu) rendered.add(mobileTransitionMenu);
    return mobileSwipeMenus.filter((menu) => rendered.has(menu));
  }, [activeMenu, mobileTransitionMenu, pageSwipeTargetMenu]);
  const mobileMailChromeMenu = (visualActiveMenu === 'inbox' || visualActiveMenu === 'sent')
    ? visualActiveMenu
    : (navSwipeTargetMenu === 'inbox' || navSwipeTargetMenu === 'sent')
      ? navSwipeTargetMenu
      : null;
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    syncMobileChromeForMenu(mobileMailChromeMenu);
  }, [mobileMailChromeMenu, syncMobileChromeForMenu]);

  if (accountBooting) {
    return <div className="flex h-[100dvh] w-full items-center justify-center bg-[var(--color-bg)] text-sm text-slate-500">正在恢复登录...</div>;
  }

  if (addressJwt && directAddress) {
    return (
      <>
        <DirectMailboxConsole apiBase={apiBase} jwt={addressJwt} address={directAddress} locale={locale} theme={theme} setTheme={setTheme} setLocale={updateLocale} onSignOut={forgetCurrentBrowser} />
        <NoticeToast notice={notice} />
        {confirmModal}
      </>
    );
  }

  if (accountProfile && !accountProfile.isAdmin) {
    return (
      <>
        <AccountConsole apiBase={apiBase} profile={accountProfile} locale={locale} theme={theme} setTheme={setTheme} setLocale={updateLocale} onSignOut={forgetCurrentBrowser} />
        <NoticeToast notice={notice} />
        {confirmModal}
      </>
    );
  }

  if (!connected) {
    return (
      <>
        <BackendLogin apiBase={apiBase} locale={locale} theme={theme} onAccountLogin={applyAccountLogin} onDirectLogin={applyDirectLogin} localPreviewHref={adminPreviewAvailable ? '/?preview=admin' : undefined} />
        <NoticeToast notice={notice} />
        {confirmModal}
      </>
    );
  }

  return (
    <div className={cls('h-[100dvh] w-full overflow-hidden bg-[var(--color-bg)] font-sans text-slate-800', theme === 'dark' && 'theme-dark')}>
      <div className="flex h-full w-full min-w-0 overflow-hidden bg-[var(--color-bg)]">
        <Sidebar
          activeMenu={activeMenu}
          setActiveMenu={navigateMenu}
          stats={stats}
          theme={theme}
          setTheme={setTheme}
          locale={locale}
          setLocale={updateLocale}
          refresh={refreshCurrent}
          apiBase={apiBase}
          connected={connected}
          accountName={adminPreviewMode ? localeText('本地预览', 'Local preview', locale) : accountProfile?.username || accountProfile?.userEmail || adminAccessProfile?.username || adminAccessProfile?.userEmail}
          accountMeta={adminPreviewMode
            ? localeText('样例数据 · 不连接线上账号', 'Sample data · no production account', locale)
            : accountProfile
            ? `${accountProfile.userEmail || ''}${accountProfile.linuxDoEmail ? ` · L站 ${accountProfile.linuxDoEmail}` : ''}${accountProfile.linuxDoId ? ` · ID ${accountProfile.linuxDoId}` : ''}`
            : adminAccessProfile?.userEmail}
        >
          <AuthPanel {...authProps} initialOpen={!connected} />
        </Sidebar>
        <main className={cls('mobile-page-swipe-zone relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-surface)]', isMailMenu && 'mobile-mail-shell')}>
          <Header activeMenu={visualActiveMenu} setActiveMenu={navigateMenu} query={globalQuery} setQuery={setGlobalQuery} refresh={refreshCurrent} apiBase={apiBase} locale={locale} />
          <div className={cls('min-h-0 min-w-0 flex-1 overflow-hidden md:pb-0', useMobileSwipeDeck ? 'mobile-swipe-stage pb-0' : 'pb-[calc(62px+env(safe-area-inset-bottom))]')}>
            {useMobileSwipeDeck && (
              <div
                ref={mobileSwipeCacheRef}
                className="mobile-swipe-cache h-full min-h-0 min-w-0"
                style={{ '--mobile-page-drag-x': `${pageDragX}px` } as CSSProperties}
              >
                {mobileRenderedMenus.map((menu) => {
                  const offset = getPageRenderOffset(menu, activeMenu, pageSwipeTargetMenu, pageDragX);
                  const active = menu === activeMenu;
                  const isMailSwipeMenu = menu === 'inbox' || menu === 'sent';
                  const initialX = offset * swipeViewportWidth + pageDragX;
                  const pageStyle = {
                    transform: `translate3d(${Math.round(initialX * 100) / 100}px, 0, 0)`,
                    '--mobile-page-settle-ms': `${pageSettleMs}ms`,
                  } as CSSProperties;
                  return (
                    <section
                      ref={(node) => {
                        if (node) {
                          mobilePageRefs.current.set(menu, node);
                          applyMobilePageTransforms(pageDragXValueRef.current);
                        } else {
                          mobilePageRefs.current.delete(menu);
                        }
                      }}
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
            useLiveProgress={navUsesLiveProgress}
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
