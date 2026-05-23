import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clearApiCache, createApiClient } from './lib/api';
import { API_BASE, STORAGE_KEYS, SWIPE } from './lib/constants';
import { readJwtFromQuery } from './lib/clipboard';
import { isLikelyJwt } from './lib/crypto';
import { readStorage, writeLocalStorage } from './lib/storage';
import { cls } from './lib/format';
import type { AddressUserFilter, ComposePayload, OpenSettings, Statistics } from './types/api';
import { AuthPanel } from './components/AuthPanel';
import { NoticeToast, useConfirm, useNotice } from './components/Common';
import { Header, MobileNav, Sidebar, type MenuKey } from './components/Shell';
import { DashboardView, StatsView } from './views/DashboardView';

const AddressView = lazy(() => import('./views/AddressView').then((mod) => ({ default: mod.AddressView })));
const MailWorkspace = lazy(() => import('./views/MailWorkspace').then((mod) => ({ default: mod.MailWorkspace })));
const ComposeView = lazy(() => import('./views/ComposeView').then((mod) => ({ default: mod.ComposeView })));
const UsersView = lazy(() => import('./views/UsersView').then((mod) => ({ default: mod.UsersView })));
const SettingsView = lazy(() => import('./views/SettingsMaintenance').then((mod) => ({ default: mod.SettingsView })));
const MaintenanceView = lazy(() => import('./views/SettingsMaintenance').then((mod) => ({ default: mod.MaintenanceView })));

const emptyStats: Statistics = { mailCount: 0, sendMailCount: 0, userCount: 0, addressCount: 0, activeAddressCount7days: 0, activeAddressCount30days: 0 };
const keepAliveMenus: MenuKey[] = ['dashboard', 'stats', 'address', 'users', 'inbox', 'sent', 'unknown', 'compose', 'settings', 'maintenance'];
const mobileSwipeMenus: MenuKey[] = ['dashboard', 'stats', 'address', 'users', 'inbox', 'sent', 'unknown', 'compose', 'settings', 'maintenance'];
type MailboxAddressRequest = { address: string; requestId: number };

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px), (hover: none) and (pointer: coarse)').matches;
}

function shouldIgnorePageSwipe(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, iframe, .modal-card, .mobile-mail-detail, .mail-frame, .code-area, [data-no-page-swipe="true"]'));
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
  return <div className="flex h-full items-center justify-center text-sm text-slate-400">视图加载中...</div>;
}

export default function App() {
  const [activeMenu, setActiveMenu] = useState<MenuKey>('dashboard');
  const [pageMotion, setPageMotion] = useState<'forward' | 'back' | ''>('');
  const [pageDragX, setPageDragX] = useState(0);
  const [pageSettling, setPageSettling] = useState(false);
  const [visitedMenus, setVisitedMenus] = useState<Set<MenuKey>>(() => new Set(['dashboard']));
  const [globalQuery, setGlobalQuery] = useState('');
  const [apiBase, setApiBase] = useState(() => readStorage(STORAGE_KEYS.apiBase, API_BASE));
  const [adminPassword, setAdminPassword] = useState(() => readStorage(STORAGE_KEYS.adminPassword, ''));
  const [sitePassword, setSitePassword] = useState(() => readStorage(STORAGE_KEYS.sitePassword, ''));
  const [userAccessToken, setUserAccessToken] = useState(() => readStorage(STORAGE_KEYS.userAccessToken, ''));
  const [addressJwt] = useState(() => {
    const fromUrl = consumeAddressJwtFromUrl();
    if (fromUrl) {
      writeLocalStorage(STORAGE_KEYS.addressJwt, fromUrl);
      return fromUrl;
    }
    const stored = readStorage(STORAGE_KEYS.addressJwt, '');
    return isLikelyJwt(stored) ? stored : '';
  });
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (readStorage(STORAGE_KEYS.uiTheme, 'light') === 'dark' ? 'dark' : 'light'));
  const [stats, setStats] = useState<Statistics>(emptyStats);
  const [statsLoading, setStatsLoading] = useState(false);
  const [openSettings, setOpenSettings] = useState<OpenSettings | null>(null);
  const [composeSeed, setComposeSeed] = useState<Partial<ComposePayload>>({});
  const [addressUserFilter, setAddressUserFilter] = useState<AddressUserFilter | null>(() => readInitialAddressUserFilter());
  const [mailboxAddressRequest, setMailboxAddressRequest] = useState<MailboxAddressRequest | null>(null);
  const pageSwipeRef = useRef({ active: false, startX: 0, startY: 0, lastX: 0, lastY: 0 });
  const credentialFingerprintRef = useRef<string | null>(null);
  const { notice, push } = useNotice();
  const { ask, modal: confirmModal } = useConfirm();
  const client = useMemo(() => createApiClient(() => apiBase, () => ({ adminPassword, sitePassword, userAccessToken, addressJwt, lang: 'zh' })), [addressJwt, adminPassword, apiBase, sitePassword, userAccessToken]);
  const request = useCallback(<T,>(path: string, options?: Parameters<typeof client.request>[1]) => client.request<T>(path, options), [client]);
  const loadStats = useCallback(async (forceRefresh = false) => {
    setStatsLoading(true);
    try { const res = await request<Statistics>('/admin/statistics', { forceRefresh, cacheTtlMs: 30_000 }); setStats({ ...emptyStats, ...res }); }
    catch (error) { if (adminPassword || userAccessToken) push('error', error instanceof Error ? error.message : '统计加载失败'); }
    finally { setStatsLoading(false); }
  }, [adminPassword, push, request, userAccessToken]);
  const loadOpenSettings = useCallback(async (forceRefresh = false) => { try { const res = await request<OpenSettings>('/open_api/settings', { forceRefresh, cacheTtlMs: 120_000 }); setOpenSettings(res); } catch { /* open settings may require site auth */ } }, [request]);
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
      if (currentIndex >= 0 && nextIndex >= 0) {
        setPageMotion(nextIndex > currentIndex ? 'forward' : 'back');
        window.setTimeout(() => setPageMotion(''), 260);
      } else {
        setPageMotion('');
      }
      return menu;
    });
  }, []);
  const renderContent = (menu: MenuKey) => {
    if (menu === 'dashboard') return <DashboardView stats={stats} loading={statsLoading} openSettings={openSettings} refresh={refreshCurrent} setActiveMenu={navigateMenu} />;
    if (menu === 'stats') return <StatsView stats={stats} loading={statsLoading} openSettings={openSettings} refresh={refreshCurrent} />;
    if (menu === 'address') return <AddressView request={request} notify={push} ask={ask} globalQuery={globalQuery} openSettings={openSettings} userFilter={addressUserFilter} userTotal={stats.userCount} onClearUserFilter={() => setAddressUserFilter(null)} onOpenInbox={(address) => { setMailboxAddressRequest((current) => ({ address, requestId: (current?.requestId || 0) + 1 })); navigateMenu('inbox'); }} />;
    if (menu === 'users') return <UsersView request={request} notify={push} ask={ask} globalQuery={globalQuery} onFilterUserAddresses={(filter) => { setAddressUserFilter((current) => ({ userId: filter.userId, userEmail: filter.userEmail, requestId: (current?.requestId || 0) + 1 })); setGlobalQuery(''); navigateMenu('address'); }} />;
    if (menu === 'inbox' || menu === 'sent' || menu === 'unknown') return <MailWorkspace mode={menu} active={activeMenu === menu} request={request} notify={push} ask={ask} globalQuery={globalQuery} addressRequest={menu === 'inbox' ? mailboxAddressRequest : null} setActiveMenu={navigateMenu} setComposeSeed={setComposeSeed} />;
    if (menu === 'compose') return <ComposeView request={request} notify={push} seed={composeSeed} clearSeed={() => setComposeSeed({})} />;
    if (menu === 'settings') return <SettingsView request={request} notify={push} />;
    return <MaintenanceView request={request} notify={push} />;
  };
  const switchMobileMenuBySwipe = (direction: 1 | -1) => {
    const currentIndex = mobileSwipeMenus.indexOf(activeMenu);
    if (currentIndex < 0) return;
    const nextMenu = mobileSwipeMenus[currentIndex + direction];
    if (!nextMenu) {
      setPageSettling(true);
      setPageDragX(0);
      window.setTimeout(() => setPageSettling(false), 160);
      return;
    }
    const width = typeof window === 'undefined' ? 390 : Math.max(window.innerWidth, 360);
    setPageSettling(true);
    setPageDragX(direction === 1 ? -width : width);
    window.setTimeout(() => {
      setActiveMenu(nextMenu);
      setPageMotion(direction === 1 ? 'forward' : 'back');
      setPageDragX(direction === 1 ? 28 : -28);
      window.requestAnimationFrame(() => setPageDragX(0));
      window.setTimeout(() => {
        setPageSettling(false);
        setPageMotion('');
      }, 230);
    }, 150);
  };
  useEffect(() => {
    const handleNativeTouchStart = (event: TouchEvent) => {
      if (!isMobileViewport() || event.touches.length !== 1 || shouldIgnorePageSwipe(event.target)) return;
      const touch = event.touches[0];
      pageSwipeRef.current = { active: true, startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastY: touch.clientY };
    };
    const handleNativeTouchMove = (event: TouchEvent) => {
      const swipe = pageSwipeRef.current;
      if (!swipe.active || event.touches.length !== 1) return;
      const touch = event.touches[0];
      swipe.lastX = touch.clientX;
      swipe.lastY = touch.clientY;
      const dx = swipe.lastX - swipe.startX;
      const dy = Math.abs(swipe.lastY - swipe.startY);
      if (Math.abs(dx) > SWIPE.startThreshold && Math.abs(dx) > dy * SWIPE.ratio) {
        event.preventDefault();
        setPageSettling(false);
        const limit = Math.min(130, Math.max(72, window.innerWidth * 0.34));
        setPageDragX(Math.max(-limit, Math.min(limit, dx)));
      }
    };
    const handleNativeTouchEnd = () => {
      const swipe = pageSwipeRef.current;
      pageSwipeRef.current = { active: false, startX: 0, startY: 0, lastX: 0, lastY: 0 };
      if (!swipe.active) return;
      const dx = swipe.lastX - swipe.startX;
      const dy = Math.abs(swipe.lastY - swipe.startY);
      if (Math.abs(dx) < SWIPE.pageMinDistance || Math.abs(dx) < dy * SWIPE.pageRatio || dy > SWIPE.pageMaxVertical) {
        setPageSettling(true);
        setPageDragX(0);
        window.setTimeout(() => setPageSettling(false), 160);
        return;
      }
      switchMobileMenuBySwipe(dx < 0 ? 1 : -1);
    };
    const handleNativeTouchCancel = () => {
      pageSwipeRef.current = { active: false, startX: 0, startY: 0, lastX: 0, lastY: 0 };
      setPageSettling(true);
      setPageDragX(0);
      window.setTimeout(() => setPageSettling(false), 160);
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
  }, [activeMenu, navigateMenu]);
  const authProps = useMemo(() => ({
    apiBase,
    setApiBase,
    adminPassword,
    setAdminPassword,
    sitePassword,
    setSitePassword,
    userAccessToken,
    setUserAccessToken,
    turnstileSiteKey: typeof openSettings?.cfTurnstileSiteKey === 'string' ? openSettings.cfTurnstileSiteKey : '',
    turnstileRequired: Boolean(openSettings?.enableGlobalTurnstileCheck),
    request,
    notify: push,
  }), [adminPassword, apiBase, openSettings?.cfTurnstileSiteKey, openSettings?.enableGlobalTurnstileCheck, push, request, sitePassword, userAccessToken]);
  return (
    <div className={cls('h-[100dvh] w-full overflow-hidden bg-[var(--color-bg)] font-sans text-slate-800', theme === 'dark' && 'theme-dark')}>
      <div className="flex h-full w-full min-w-0 overflow-hidden bg-[var(--color-bg)]">
        <Sidebar activeMenu={activeMenu} setActiveMenu={navigateMenu} stats={stats} theme={theme} setTheme={setTheme} refresh={refreshCurrent}>
          <AuthPanel {...authProps} initialOpen={!adminPassword && !userAccessToken} />
        </Sidebar>
        <main className="mobile-page-swipe-zone relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-surface)]">
          <Header activeMenu={activeMenu} setActiveMenu={navigateMenu} query={globalQuery} setQuery={setGlobalQuery} refresh={refreshCurrent} apiBase={apiBase}>
            <AuthPanel {...authProps} initialOpen={false} />
          </Header>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden pb-[calc(62px+env(safe-area-inset-bottom))] md:pb-0">
            {keepAliveMenus.filter((menu) => menu === activeMenu || visitedMenus.has(menu)).map((menu) => (
              <section
                key={menu}
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
          <MobileNav activeMenu={activeMenu} setActiveMenu={navigateMenu} />
        </main>
      </div>
      <NoticeToast notice={notice} />
      {confirmModal}
    </div>
  );
}
