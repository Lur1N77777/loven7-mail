import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, BarChart2, Check, ChevronDown, Database, Github, Inbox, LayoutDashboard, Moon, MoreHorizontal, PenLine, RefreshCw, RotateCcw, Send, Settings, Sun, UserRoundCog, Users } from 'lucide-react';
import { STORAGE_KEYS } from '../lib/constants';
import { cls } from '../lib/format';
import { getLocaleShortLabel, getRuntimeLocale, localeText, toggleLocale, type AppLocale } from '../lib/locale';
import type { Statistics } from '../types/api';
import { LovenMailMark } from './BrandIcons';

export type MenuKey = 'dashboard' | 'stats' | 'address' | 'users' | 'inbox' | 'sent' | 'unknown' | 'compose' | 'settings' | 'maintenance';

type MenuItem = { key: MenuKey; label: string; icon: React.ComponentType<{ size?: number | string; className?: string }> };

const menuGroups: Array<Array<MenuItem>> = [
  [
    { key: 'dashboard', label: '仪表盘', icon: LayoutDashboard },
    { key: 'stats', label: '统计', icon: BarChart2 },
    { key: 'address', label: '地址管理', icon: Users },
    { key: 'users', label: '用户管理', icon: UserRoundCog },
  ],
  [
    { key: 'inbox', label: '收件箱', icon: Inbox },
    { key: 'sent', label: '发件箱', icon: Send },
    { key: 'unknown', label: '未知邮件', icon: AlertCircle },
    { key: 'compose', label: '写邮件', icon: PenLine },
  ],
  [
    { key: 'settings', label: '系统设置', icon: Settings },
    { key: 'maintenance', label: '维护', icon: Database },
  ],
];

const flatMenuItems = menuGroups.flat();
export const mobilePrimaryMenus: MenuKey[] = ['stats', 'address', 'inbox', 'sent'];
export const mobileSwipeMenus: MenuKey[] = [...mobilePrimaryMenus, 'dashboard'];
const mobileMoreItems = flatMenuItems.filter((item) => !mobilePrimaryMenus.includes(item.key));
const OFFICIAL_GITHUB_URL = 'https://github.com/Lur1N77777/loven7-mail-cloudflare-suite';

const adminAvatarPresets = [
  { id: 'aurora', src: '/loven7-designer-cover-01-silk-light.png', labelZh: '丝光', labelEn: 'Silk light' },
  { id: 'mint', src: '/loven7-designer-cover-02-architectural-still.png', labelZh: '建筑静影', labelEn: 'Architectural still' },
  { id: 'coral', src: '/loven7-designer-cover-03-nocturne-window.png', labelZh: '夜窗', labelEn: 'Nocturne window' },
  { id: 'plum', src: '/loven7-cover-04-moonlit-paper.png', labelZh: '月光纸页', labelEn: 'Moonlit paper' },
  { id: 'skyline', src: '/loven7-designer-cover-05-red-accent.png', labelZh: '红色点睛', labelEn: 'Red accent' },
] as const;

type AdminAvatarPresetId = (typeof adminAvatarPresets)[number]['id'];
type AdminAvatarChoice = AdminAvatarPresetId | 'custom';

const DEFAULT_ADMIN_AVATAR: AdminAvatarPresetId = 'aurora';
const PROFILE_NAME_MAX_LENGTH = 24;

function isAdminAvatarPresetId(value: string | null): value is AdminAvatarPresetId {
  return adminAvatarPresets.some((preset) => preset.id === value);
}

function readStoredAvatarChoice(): AdminAvatarChoice {
  if (typeof window === 'undefined') return DEFAULT_ADMIN_AVATAR;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEYS.adminAvatarPreset);
    if (stored === 'custom') return 'custom';
    return isAdminAvatarPresetId(stored) ? stored : DEFAULT_ADMIN_AVATAR;
  } catch {
    return DEFAULT_ADMIN_AVATAR;
  }
}

function extractAvatarUrl(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/https?:\/\/[^\s<>"']+/i);
  return (match?.[0] || trimmed).replace(/[)\],，。]+$/, '');
}

function normalizeAvatarUrl(value: string) {
  const candidate = extractAvatarUrl(value);
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:') return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function readStoredCustomAvatar() {
  if (typeof window === 'undefined') return '';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEYS.adminAvatarCustom) || '';
    const normalized = normalizeAvatarUrl(stored);
    if (stored && !normalized) window.localStorage.removeItem(STORAGE_KEYS.adminAvatarCustom);
    return normalized;
  } catch {
    return '';
  }
}

function persistAvatarChoice(choice: AdminAvatarChoice) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEYS.adminAvatarPreset, choice);
  } catch {
    // Local storage can be unavailable in strict browser privacy modes.
  }
}

function persistCustomAvatar(url: string) {
  if (typeof window === 'undefined') return;
  try {
    if (url) window.localStorage.setItem(STORAGE_KEYS.adminAvatarCustom, url);
    else window.localStorage.removeItem(STORAGE_KEYS.adminAvatarCustom);
  } catch {
    // Local storage can be unavailable in strict browser privacy modes.
  }
}

function normalizeProfileName(value: string) {
  return value.trim().replace(/\s+/g, ' ').slice(0, PROFILE_NAME_MAX_LENGTH);
}

function readStoredProfileName() {
  if (typeof window === 'undefined') return '';
  try {
    return normalizeProfileName(window.localStorage.getItem(STORAGE_KEYS.adminProfileName) || '');
  } catch {
    return '';
  }
}

function persistProfileName(name: string) {
  if (typeof window === 'undefined') return;
  try {
    if (name) window.localStorage.setItem(STORAGE_KEYS.adminProfileName, name);
    else window.localStorage.removeItem(STORAGE_KEYS.adminProfileName);
  } catch {
    // Local storage can be unavailable in strict browser privacy modes.
  }
}

const menuLabelsEn: Partial<Record<MenuKey, string>> = {
  dashboard: 'Dashboard',
  stats: 'Stats',
  address: 'Addresses',
  users: 'Users',
  inbox: 'Inbox',
  sent: 'Sent',
  unknown: 'Unknown',
  compose: 'Compose',
  settings: 'Settings',
  maintenance: 'Maintenance',
};

function menuLabel(item: { key: MenuKey; label: string }, locale: AppLocale) {
  return locale === 'en-US' ? menuLabelsEn[item.key] || item.label : item.label;
}

function localeToggleTitle(locale: AppLocale) {
  return locale === 'en-US' ? 'Switch to Chinese' : 'Switch to English';
}

function getApiHostLabel(apiBase?: string, locale: AppLocale = 'zh-CN') {
  if (!apiBase) return localeText('同源 Worker', 'Same-origin Worker', locale);
  try {
    return new URL(apiBase).hostname || localeText('自定义 API', 'Custom API', locale);
  } catch {
    return apiBase.replace(/^https?:\/\//, '').replace(/\/$/, '') || localeText('自定义 API', 'Custom API', locale);
  }
}

function getProfileInitial(apiBase?: string) {
  const host = getApiHostLabel(apiBase);
  const match = host.match(/[a-z0-9]/i);
  return match ? match[0].toUpperCase() : 'A';
}

function BrandGlyph({ className = 'h-7 w-7' }: { className?: string }) {
  return <LovenMailMark className={cls('logo-mark logo-sigil', className)} />;
}

export function Logo() {
  return (
    <div className="logo-tile flex h-10 w-10 items-center justify-center" aria-hidden="true">
      <BrandGlyph />
    </div>
  );
}

export function Sidebar({ activeMenu, setActiveMenu, stats, theme, setTheme, locale, setLocale, refresh, refreshing = false, apiBase, connected, accountName, accountMeta, allowedMenus, showComposeButton = true, showSettingsShortcut = true, sidebarSubtitle, miniActionColumns, children }: {
  activeMenu: MenuKey;
  setActiveMenu: (menu: MenuKey) => void;
  stats: Statistics;
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  refresh: () => void;
  refreshing?: boolean;
  apiBase?: string;
  connected?: boolean;
  accountName?: string;
  accountMeta?: string;
  allowedMenus?: MenuKey[];
  showComposeButton?: boolean;
  showSettingsShortcut?: boolean;
  sidebarSubtitle?: string;
  miniActionColumns?: 2 | 3;
  children?: React.ReactNode;
}) {
  const hostLabel = getApiHostLabel(apiBase, locale);
  const profileInitial = getProfileInitial(apiBase);
  const profileCardRef = useRef<HTMLDivElement | null>(null);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [avatarPopoverMounted, setAvatarPopoverMounted] = useState(false);
  const [avatarChoice, setAvatarChoice] = useState<AdminAvatarChoice>(() => readStoredAvatarChoice());
  const [customAvatar, setCustomAvatar] = useState(() => readStoredCustomAvatar());
  const [avatarUrlDraft, setAvatarUrlDraft] = useState(() => readStoredCustomAvatar());
  const [profileName, setProfileName] = useState(() => readStoredProfileName());
  const [profileNameDraft, setProfileNameDraft] = useState(() => readStoredProfileName());
  const [avatarNotice, setAvatarNotice] = useState('');
  const selectedPreset = adminAvatarPresets.find((preset) => preset.id === avatarChoice) || adminAvatarPresets[0];
  const isCustomAvatarActive = avatarChoice === 'custom' && !!customAvatar;
  const avatarSrc = isCustomAvatarActive ? customAvatar : selectedPreset.src;
  const defaultProfileName = locale === 'en-US' ? 'Admin' : '管理员';
  const loginIdentity = accountName && accountMeta && accountMeta !== accountName
    ? `${accountName} · ${accountMeta}`
    : accountMeta || accountName || `${connected ? (locale === 'en-US' ? 'Connected' : '已连接') : (locale === 'en-US' ? 'Offline' : '未连接')} · ${hostLabel}`;
  const displayProfileName = profileName || accountName || defaultProfileName;
  const displayProfileMeta = loginIdentity;
  const allowedMenuSet = allowedMenus?.length ? new Set(allowedMenus) : null;
  const visibleMenuGroups = allowedMenuSet
    ? menuGroups.map((group) => group.filter((item) => allowedMenuSet.has(item.key))).filter((group) => group.length > 0)
    : menuGroups;
  const sidebarMenuGroups = visibleMenuGroups
    .map((group) => group.filter((item) => !(showComposeButton && item.key === 'compose')))
    .filter((group) => group.length > 0);
  const getMenuBadge = (key: MenuKey) => {
    if (key === 'inbox') return stats.mailCount;
    if (key === 'sent') return stats.sendMailCount;
    if (key === 'address') return stats.addressCount;
    if (key === 'users') return stats.userCount;
    return undefined;
  };

  useEffect(() => {
    if (avatarPickerOpen) {
      setAvatarPopoverMounted(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setAvatarPopoverMounted(false), 170);
    return () => window.clearTimeout(timer);
  }, [avatarPickerOpen]);

  useEffect(() => {
    if (!avatarPickerOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (profileCardRef.current && !profileCardRef.current.contains(event.target as Node)) setAvatarPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAvatarPickerOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [avatarPickerOpen]);

  const chooseAvatar = (choice: AdminAvatarChoice) => {
    if (choice === 'custom' && !customAvatar) return;
    setAvatarChoice(choice);
    persistAvatarChoice(choice);
    setAvatarNotice(locale === 'en-US' ? 'Avatar saved' : '头像已保存');
  };

  const resetAvatar = () => {
    setCustomAvatar('');
    setAvatarUrlDraft('');
    persistCustomAvatar('');
    chooseAvatar(DEFAULT_ADMIN_AVATAR);
  };

  const applyAvatarUrl = () => {
    const normalized = normalizeAvatarUrl(avatarUrlDraft);
    if (!normalized) {
      setAvatarNotice(locale === 'en-US' ? 'Use a valid HTTPS image URL' : '请填写有效的 HTTPS 图片链接');
      return;
    }
    setCustomAvatar(normalized);
    setAvatarUrlDraft(normalized);
    persistCustomAvatar(normalized);
    setAvatarChoice('custom');
    persistAvatarChoice('custom');
    setAvatarNotice(locale === 'en-US' ? 'Custom avatar applied' : '自定义头像已应用');
  };

  const applyProfileName = () => {
    const normalized = normalizeProfileName(profileNameDraft);
    setProfileName(normalized);
    setProfileNameDraft(normalized);
    persistProfileName(normalized);
    setAvatarNotice(normalized ? (locale === 'en-US' ? 'Profile name saved' : '名称已保存') : (locale === 'en-US' ? 'Default name restored' : '已恢复默认名称'));
  };

  return (
    <aside className="sidebar-reference-shell hidden h-full w-[272px] shrink-0 flex-col md:flex xl:w-[288px]">
      <div className="sidebar-reference-panel">
        <div ref={profileCardRef} className="admin-profile-card sidebar-profile-card">
          <button type="button" className={cls('admin-profile-row sidebar-profile-row', avatarPickerOpen && 'is-open')} onClick={() => setAvatarPickerOpen((current) => !current)} aria-haspopup="dialog" aria-expanded={avatarPickerOpen}>
            <span className={cls('admin-profile-avatar sidebar-profile-avatar', !isCustomAvatarActive && 'admin-profile-avatar-preset')}>
              <img src={avatarSrc} alt="" draggable={false} />
              <span className="sr-only">{profileInitial}</span>
            </span>
            <span className="admin-profile-main sidebar-profile-main">
              <span className="admin-profile-name sidebar-profile-name">{displayProfileName}</span>
              <span className="admin-profile-status sidebar-profile-status">{displayProfileMeta}</span>
            </span>
            <ChevronDown size={15} className="admin-profile-chevron sidebar-profile-chevron" />
          </button>
          {avatarPopoverMounted && (
            <div className={cls('admin-avatar-popover', !avatarPickerOpen && 'is-closing')} role="dialog" aria-label={locale === 'en-US' ? 'Choose avatar' : '选择头像'}>
              <div className="admin-avatar-popover-head">
                <span>{locale === 'en-US' ? 'Avatar' : '头像'}</span>
                <small>{locale === 'en-US' ? '5 presets + custom URL' : '5 个预设 + 自定义链接'}</small>
              </div>
              <label className="admin-profile-name-block" htmlFor="admin-profile-name">
                <span>{locale === 'en-US' ? 'Display name' : '显示名称'}</span>
                <span className="admin-profile-name-row">
                  <input
                    id="admin-profile-name"
                    className="admin-profile-name-input"
                    value={profileNameDraft}
                    maxLength={PROFILE_NAME_MAX_LENGTH}
                    placeholder={defaultProfileName}
                    spellCheck={false}
                    onChange={(event) => setProfileNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        applyProfileName();
                      }
                    }}
                  />
                  <button type="button" className="admin-profile-name-apply" onClick={applyProfileName} title={locale === 'en-US' ? 'Save display name' : '保存显示名称'} aria-label={locale === 'en-US' ? 'Save display name' : '保存显示名称'}><Check size={14} /></button>
                </span>
              </label>
              <div className="admin-avatar-grid">
                {adminAvatarPresets.map((preset) => {
                  const active = avatarChoice !== 'custom' && avatarChoice === preset.id;
                  return (
                    <button key={preset.id} type="button" className={cls('admin-avatar-option admin-avatar-preset-option', active && 'active')} title={locale === 'en-US' ? preset.labelEn : preset.labelZh} aria-label={locale === 'en-US' ? preset.labelEn : preset.labelZh} onClick={() => chooseAvatar(preset.id)}>
                      <img src={preset.src} alt="" draggable={false} />
                      {active && <span className="admin-avatar-check"><Check size={10} /></span>}
                    </button>
                  );
                })}
                {customAvatar && (
                  <button type="button" className={cls('admin-avatar-option admin-avatar-custom-option', avatarChoice === 'custom' && 'active')} title={locale === 'en-US' ? 'Custom avatar' : '自定义头像'} aria-label={locale === 'en-US' ? 'Custom avatar' : '自定义头像'} onClick={() => chooseAvatar('custom')}>
                    <img src={customAvatar} alt="" draggable={false} />
                    {avatarChoice === 'custom' && <span className="admin-avatar-check"><Check size={10} /></span>}
                  </button>
                )}
              </div>
              <label className="admin-avatar-url-block" htmlFor="admin-avatar-url">
                <span>{locale === 'en-US' ? 'Avatar image URL' : '头像图片链接'}</span>
                <span className="admin-avatar-url-row">
                  <input
                    id="admin-avatar-url"
                    className="admin-avatar-url-input"
                    value={avatarUrlDraft}
                    placeholder="https://your-image-host.example/avatar.webp"
                    spellCheck={false}
                    onChange={(event) => setAvatarUrlDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        applyAvatarUrl();
                      }
                    }}
                  />
                  <button type="button" className="admin-avatar-url-apply" onClick={applyAvatarUrl} title={locale === 'en-US' ? 'Apply custom avatar' : '应用自定义头像'} aria-label={locale === 'en-US' ? 'Apply custom avatar' : '应用自定义头像'}><Check size={14} /></button>
                </span>
              </label>
              <div className="admin-avatar-actions">
                <button type="button" className="admin-avatar-action" onClick={resetAvatar}><RotateCcw size={15} />{locale === 'en-US' ? 'Reset' : '默认'}</button>
              </div>
              {avatarNotice && <p className="admin-avatar-notice">{avatarNotice}</p>}
            </div>
          )}
        </div>

        <nav className="sidebar-reference-nav" aria-label={locale === 'en-US' ? 'Admin navigation' : '后台导航'}>
          {sidebarMenuGroups.map((group, groupIndex) => (
            <div className="sidebar-nav-group" key={groupIndex}>
              {group.map((item) => {
                const Icon = item.icon;
                const badge = getMenuBadge(item.key);
                return (
                  <button type="button" key={item.key} onClick={() => setActiveMenu(item.key)} className={cls('sidebar-nav-item', activeMenu === item.key && 'sidebar-nav-active')} aria-current={activeMenu === item.key ? 'page' : undefined}>
                    <span className="sidebar-nav-main"><Icon size={18} className="sidebar-nav-icon" /> <span className="sidebar-nav-label">{menuLabel(item, locale)}</span></span>
                    <span className="sidebar-badge-slot">{typeof badge === 'number' && badge > 0 && <span className="sidebar-badge">{badge}</span>}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-reference-footer">
          <div className="sidebar-reference-tools">
            <button type="button" onClick={refresh} className={cls('sidebar-mini-btn sidebar-tool-btn', refreshing && 'is-refreshing')} disabled={refreshing} aria-busy={refreshing} title={locale === 'en-US' ? 'Refresh' : '刷新'} aria-label={locale === 'en-US' ? 'Refresh' : '刷新'}><RefreshCw size={15} className={cls(refreshing && 'animate-spin')} /><span>{refreshing ? (locale === 'en-US' ? 'Refreshing' : '刷新中') : (locale === 'en-US' ? 'Refresh' : '刷新')}</span></button>
            {showSettingsShortcut ? <button type="button" onClick={() => setActiveMenu('settings')} className="sidebar-mini-btn sidebar-tool-btn" title={locale === 'en-US' ? 'Settings' : '系统设置'} aria-label={locale === 'en-US' ? 'Settings' : '系统设置'}><Settings size={15} /><span>{locale === 'en-US' ? 'Settings' : '设置'}</span></button> : null}
            <a className="sidebar-mini-btn sidebar-tool-btn sidebar-github-link" href={OFFICIAL_GITHUB_URL} target="_blank" rel="noreferrer" title={locale === 'en-US' ? 'Official GitHub repository' : '官方 GitHub 仓库'} aria-label={locale === 'en-US' ? 'Open official GitHub repository' : '打开官方 GitHub 仓库'}>
              <Github size={15} />
              <span>GitHub</span>
            </a>
            {children}
          </div>
          <div className="theme-segmented-control sidebar-theme-control"><button type="button" onClick={() => setTheme('light')} className={cls('theme-segmented-option', theme === 'light' && 'active')} title={locale === 'en-US' ? 'Light mode' : '浅色模式'} aria-label={locale === 'en-US' ? 'Light mode' : '浅色模式'}><Sun size={15} /><span>{locale === 'en-US' ? 'Light' : '浅色'}</span></button><button type="button" onClick={() => setTheme('dark')} className={cls('theme-segmented-option', theme === 'dark' && 'active')} title={locale === 'en-US' ? 'Dark mode' : '深色模式'} aria-label={locale === 'en-US' ? 'Dark mode' : '深色模式'}><Moon size={15} /><span>{locale === 'en-US' ? 'Dark' : '深色'}</span></button></div>
          <button type="button" className="locale-mode-toggle sidebar-locale-toggle" title={localeToggleTitle(locale)} onClick={() => setLocale(toggleLocale(locale))}>
            <span>{locale === 'en-US' ? 'Language' : '界面语言'}</span>
            <strong>{locale === 'en-US' ? 'English' : '中文'}</strong>
            <em>{getLocaleShortLabel(toggleLocale(locale))}</em>
          </button>
          {showComposeButton ? <button type="button" onClick={() => setActiveMenu('compose')} className="sidebar-compose-btn"><PenLine size={17} /> <span>{locale === 'en-US' ? 'New email' : '写邮件'}</span></button> : null}
        </div>
      </div>
    </aside>
  );
}

export function Header({ activeMenu, apiBase, locale }: {
  activeMenu: MenuKey; setActiveMenu: (menu: MenuKey) => void; query: string; setQuery: (query: string) => void; refresh: () => void; apiBase: string; locale: AppLocale;
}) {
  const titleMap: Record<MenuKey, string> = { dashboard: '仪表盘', stats: '统计', address: '地址管理', users: '用户管理', inbox: '收件箱', sent: '发件箱', unknown: '未知邮件', compose: '写邮件', settings: '系统设置', maintenance: '维护' };
  const activeLabel = locale === 'en-US' ? menuLabelsEn[activeMenu] || titleMap[activeMenu] : titleMap[activeMenu];
  return <span className="mobile-header sr-only">{activeLabel} · {apiBase || (locale === 'en-US' ? 'Same-origin Worker' : '同源 Worker')}</span>;
}

type MobileNavProps = {
  activeMenu: MenuKey;
  visualActiveMenu?: MenuKey;
  setActiveMenu: (menu: MenuKey) => void;
  locale: AppLocale;
  allowedMenus?: MenuKey[];
};

export function MobileNav({ activeMenu, visualActiveMenu, setActiveMenu, locale, allowedMenus }: MobileNavProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const displayMenu = visualActiveMenu || activeMenu;
  const allowedMenuSet = allowedMenus?.length ? new Set(allowedMenus) : null;
  const navPrimaryMenus = allowedMenuSet ? mobilePrimaryMenus.filter((key) => allowedMenuSet.has(key)) : mobilePrimaryMenus;
  const navPrimaryMenuSet = new Set(navPrimaryMenus);
  const navPrimaryItems = navPrimaryMenus.map((key) => flatMenuItems.find((item) => item.key === key)!).filter(Boolean);
  const navMoreItems = allowedMenuSet
    ? flatMenuItems.filter((item) => allowedMenuSet.has(item.key) && !navPrimaryMenuSet.has(item.key))
    : mobileMoreItems;
  const isMoreActive = navMoreItems.length > 0 && (moreOpen || !navPrimaryMenuSet.has(displayMenu));

  useEffect(() => {
    if (!moreOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [moreOpen]);

  const choose = (menu: MenuKey) => {
    setActiveMenu(menu);
    setMoreOpen(false);
  };

  return (
    <nav
      ref={rootRef}
      className="mobile-nav fixed bottom-0 left-0 right-0 z-[80] flex h-[calc(62px+env(safe-area-inset-bottom))] items-center justify-around border-t px-2 pb-safe md:hidden"
      aria-label={locale === 'en-US' ? 'Mobile navigation' : '移动端主导航'}
    >
      {navPrimaryItems.map((item) => {
        const Icon = item.icon;
        const active = displayMenu === item.key;
        return <button key={item.key} type="button" data-menu={item.key} onClick={() => choose(item.key)} className={cls('mobile-nav-item flex w-14 flex-col items-center gap-0.5', active && 'active')} aria-current={active ? 'page' : undefined} aria-label={menuLabel(item, locale)}><Icon size={21} /><span className="text-[10px] font-medium">{menuLabel(item, locale)}</span></button>;
      })}
      {navMoreItems.length > 0 && (
        <button type="button" onClick={() => setMoreOpen((current) => !current)} className={cls('mobile-nav-item flex w-14 flex-col items-center gap-0.5', isMoreActive && 'active')} aria-haspopup="menu" aria-expanded={moreOpen}>
          <MoreHorizontal size={21} />
          <span className="text-[10px] font-medium">{locale === 'en-US' ? 'More' : '更多'}</span>
        </button>
      )}
      {moreOpen && (
        <div className="mobile-more-menu" role="menu" aria-label={locale === 'en-US' ? 'More pages' : '更多页面'}>
          {navMoreItems.map((item) => {
            const Icon = item.icon;
            const active = activeMenu === item.key;
            return (
              <button key={item.key} type="button" role="menuitem" className={cls('mobile-more-item', active && 'active')} onClick={() => choose(item.key)}>
                <Icon size={17} />
                <span>{menuLabel(item, locale)}</span>
              </button>
            );
          })}
          <a className="mobile-more-item mobile-more-github-link" href={OFFICIAL_GITHUB_URL} target="_blank" rel="noreferrer" role="menuitem" aria-label={locale === 'en-US' ? 'Open official GitHub repository' : '打开官方 GitHub 仓库'}>
            <Github size={17} />
            <span>GitHub</span>
          </a>
        </div>
      )}
    </nav>
  );
}
