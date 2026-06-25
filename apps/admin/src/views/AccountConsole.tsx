import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { AlertCircle, BarChart2, Copy, ExternalLink, Inbox, KeyRound, ListFilter, Loader2, LogOut, MailOpen, Plus, RefreshCw, Search, Send, Share2, X } from 'lucide-react';
import { EmptyState, LoadingState, Modal, NoticeToast, Pagination, PopoverSelect, useConfirm, useNotice } from '../components/Common';
import { Header, MobileNav, Sidebar, type MenuKey } from '../components/Shell';
import { ActivityLogo, AddressLogo, ChartLogo, HeroOrbitLogo, InboxLogo, TimeLogo } from '../components/BrandIcons';
import { AddressView } from './AddressView';
import { copyText } from '../lib/clipboard';
import { DEFAULT_PAGE_SIZE, FRONTEND_LOGIN_BASE } from '../lib/constants';
import { createApiClient } from '../lib/api';
import { cls, formatDateTime, formatShortDate } from '../lib/format';
import { localeText, type AppLocale } from '../lib/locale';
import {
  createUserAddress,
  createUserShare,
  fetchAddressJwt,
  fetchAddressMails,
  fetchUserAddresses,
  roleDomains,
  type AccountUserProfile,
  type AddressMail,
  type UserAddress,
  type UserShareExpiry,
  type UserShareMailVisibility,
  type UserShareResult,
} from '../lib/userAuth';
import type { Statistics } from '../types/api';
import type { AddressRecord } from '../types/api';

type ThemeMode = 'light' | 'dark';
type MailMode = 'inbox' | 'sent' | 'unknown';
type AddressSortKey = 'updated' | 'address' | 'inbox' | 'sent';
type SortOrder = 'ascend' | 'descend';

const EMPTY_STATS: Statistics = {
  mailCount: 0,
  sendMailCount: 0,
  userCount: 0,
  addressCount: 0,
  activeAddressCount7days: 0,
  activeAddressCount30days: 0,
};

const ACCOUNT_ALLOWED_MENUS: MenuKey[] = ['dashboard', 'stats', 'address', 'inbox', 'sent', 'unknown'];
const DIRECT_ALLOWED_MENUS: MenuKey[] = ['inbox'];

function mailTitle(mail: AddressMail, locale: AppLocale) {
  return String(mail.subject || mail.source || (locale === 'en-US' ? 'Untitled mail' : '未命名邮件'));
}

function normalizeText(value: unknown) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeSearchText(value: unknown) {
  return normalizeText(value).toLowerCase();
}

function mailPreview(mail: AddressMail) {
  return normalizeText(mail.raw || mail.metadata).slice(0, 180);
}

function mailBody(mail: AddressMail) {
  return String(mail.raw || mail.metadata || '').replace(/\r\n/g, '\n').trim();
}

function getAddressDomain(address: string) {
  const index = address.lastIndexOf('@');
  return index >= 0 ? address.slice(index + 1) : '';
}

function getAddressLocal(address: string) {
  const index = address.lastIndexOf('@');
  return index >= 0 ? address.slice(0, index) : address;
}

function accountName(profile: AccountUserProfile) {
  return profile.username || profile.userEmail || 'User';
}

function accountMeta(profile: AccountUserProfile, locale: AppLocale) {
  const parts = [
    profile.userEmail,
    profile.roleLabel || (locale === 'en-US' ? 'Member' : '普通用户'),
    profile.linuxDoEmail ? `LinuxDo ${profile.linuxDoEmail}` : '',
    profile.linuxDoId ? `ID ${profile.linuxDoId}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function recentAddressCount(addresses: UserAddress[], days: number) {
  const now = Date.now();
  const span = days * 24 * 60 * 60 * 1000;
  return addresses.filter((row) => {
    const stamp = new Date(row.updated_at || row.created_at || '').getTime();
    return Number.isFinite(stamp) && now - stamp <= span;
  }).length;
}

function statsFromAddresses(addresses: UserAddress[]): Statistics {
  return {
    ...EMPTY_STATS,
    userCount: 1,
    addressCount: addresses.length,
    mailCount: addresses.reduce((sum, row) => sum + Number(row.mail_count || 0), 0),
    sendMailCount: addresses.reduce((sum, row) => sum + Number(row.send_count || 0), 0),
    activeAddressCount7days: recentAddressCount(addresses, 7),
    activeAddressCount30days: recentAddressCount(addresses, 30),
  };
}

function useLocaleText(locale: AppLocale) {
  return useCallback((zh: string, en: string) => localeText(zh, en, locale), [locale]);
}

function UserCredentialButton({ profile, locale, onSignOut }: { profile: AccountUserProfile; locale: AppLocale; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const t = useLocaleText(locale);
  const title = [
    profile.userEmail,
    profile.username,
    profile.roleLabel,
    profile.linuxDoEmail ? `LinuxDo ${profile.linuxDoEmail}` : '',
    profile.linuxDoId ? `ID ${profile.linuxDoId}` : '',
  ].filter(Boolean).join(' · ');
  const copyCredential = async () => {
    try {
      await copyText(profile.userToken);
      setNotice(t('登录凭据已复制', 'Credential copied'));
      window.setTimeout(() => setNotice(''), 1400);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('复制失败', 'Copy failed'));
    }
  };
  const rows = [
    [t('登录邮箱', 'Email'), profile.userEmail || '-'],
    [t('用户名', 'Username'), profile.username || '-'],
    [t('用户 ID', 'User ID'), profile.userId ? `#${profile.userId}` : '-'],
    [t('身份', 'Role'), profile.roleLabel || profile.roleKey || (profile.isAdmin ? 'Admin' : 'Member')],
    [t('LinuxDo 邮箱', 'LinuxDo email'), profile.linuxDoEmail || '-'],
    [t('LinuxDo ID', 'LinuxDo ID'), profile.linuxDoId || '-'],
  ];
  return (
    <>
      <button className="sidebar-mini-btn credential-button" onClick={() => setOpen(true)} title={title || t('当前账号凭据', 'Current account credential')} aria-label={t('凭据', 'Credential')}>
        <KeyRound size={15} />
        {t('凭据', 'Auth')}
      </button>
      {open && (
        <Modal title={t('账号凭据', 'Account credential')} onClose={() => setOpen(false)}>
          <div className="space-y-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-800">{accountName(profile)}</p>
              <p className="mt-1 text-xs text-slate-500">{accountMeta(profile, locale) || '-'}</p>
            </div>
            <div className="divide-y divide-slate-100 rounded-2xl border border-slate-100 bg-white">
              {rows.map(([label, value]) => (
                <div key={label} className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 px-3 py-2.5 text-sm">
                  <span className="text-slate-400">{label}</span>
                  <span className="min-w-0 truncate font-medium text-slate-700">{value}</span>
                </div>
              ))}
            </div>
            {notice ? <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm font-medium text-slate-600">{notice}</div> : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <button className="btn-secondary justify-center" onClick={copyCredential}><Copy size={16} />{t('复制凭据', 'Copy credential')}</button>
              <button className="btn-danger justify-center" onClick={onSignOut}><LogOut size={16} />{t('退出登录', 'Sign out')}</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function AccountDashboardView({ stats, profile, loading, locale, refresh, setActiveMenu }: {
  stats: Statistics;
  profile: AccountUserProfile;
  loading: boolean;
  locale: AppLocale;
  refresh: () => void;
  setActiveMenu: (menu: MenuKey) => void;
}) {
  const t = useLocaleText(locale);
  const quickActions: Array<{ menu: MenuKey; icon: ComponentType<{ className?: string }>; title: string; desc: string }> = [
    { menu: 'address', icon: AddressLogo, title: t('地址管理', 'Addresses'), desc: t('创建和查看自己名下的邮箱地址。', 'Create and view your own mailbox addresses.') },
    { menu: 'inbox', icon: InboxLogo, title: t('收件箱', 'Inbox'), desc: t('查看自己邮箱收到的邮件。', 'Read mail received by your own mailboxes.') },
    { menu: 'sent', icon: Send, title: t('发件箱', 'Sent'), desc: t('查看自己权限范围内的发件记录。', 'View sent records within your own scope.') },
    { menu: 'unknown', icon: AlertCircle, title: t('未知邮件', 'Unknown'), desc: t('普通用户仅显示自己权限内的未知邮件。', 'Member view only shows unknown mail within its own scope.') },
    { menu: 'stats', icon: ChartLogo, title: t('统计', 'Stats'), desc: t('查看个人地址和邮件统计。', 'View personal address and mail stats.') },
  ];
  return (
    <div className="dashboard-view-shell dashboard-view-typography h-full overflow-y-auto p-3 md:p-4 xl:p-6">
      <div className="space-y-4">
        <section className="dashboard-hero p-4 sm:rounded-[2rem] md:p-6">
          <div className="relative z-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div className="flex min-w-0 items-start gap-4">
              <div className="dashboard-hero-mark hidden shrink-0 sm:flex" aria-hidden="true"><HeroOrbitLogo className="dashboard-hero-logo" /></div>
              <div className="min-w-0">
                <p className="dashboard-hero-kicker text-sm">{profile.roleLabel || t('普通用户', 'Member')} · {profile.userEmail}</p>
                <h2 className="dashboard-hero-title mt-2 text-2xl font-bold tracking-tight sm:text-3xl md:text-4xl">{t('个人管理后台', 'Personal admin console')}</h2>
                <p className="dashboard-hero-copy mt-3 max-w-2xl text-sm leading-6">{t('地址、收件箱、发件箱和未知邮件均按当前账号权限显示。', 'Addresses, inbox, sent, and unknown mail are scoped to the current account.')}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <button onClick={refresh} className="dashboard-hero-ghost rounded-2xl px-4 py-3 text-sm font-medium transition"><RefreshCw className={cls('mr-2 inline h-4 w-4', loading && 'animate-spin')} />{loading ? t('同步中', 'Syncing') : t('刷新', 'Refresh')}</button>
              <button onClick={() => setActiveMenu('address')} className="btn-primary rounded-2xl px-4 py-3 text-sm font-semibold"><Plus className="mr-2 inline h-4 w-4" />{t('新建地址', 'New address')}</button>
            </div>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div className="dashboard-stat-card rounded-3xl border border-slate-100 bg-white p-4 shadow-sm"><div className="dashboard-logo-frame dashboard-logo-address mb-4"><AddressLogo className="dashboard-logo-svg" /></div><p className="dashboard-stat-label text-sm text-slate-400">{t('地址数量', 'Addresses')}</p><p className="dashboard-stat-value mt-2 text-3xl font-bold text-slate-800">{stats.addressCount}</p></div>
          <div className="dashboard-stat-card rounded-3xl border border-slate-100 bg-white p-4 shadow-sm"><div className="dashboard-logo-frame dashboard-logo-inbox mb-4"><InboxLogo className="dashboard-logo-svg" /></div><p className="dashboard-stat-label text-sm text-slate-400">{t('收件总数', 'Inbox total')}</p><p className="dashboard-stat-value mt-2 text-3xl font-bold text-slate-800">{stats.mailCount}</p></div>
          <div className="dashboard-stat-card rounded-3xl border border-slate-100 bg-white p-4 shadow-sm"><div className="dashboard-logo-frame dashboard-logo-sent mb-4"><BarChart2 className="dashboard-logo-svg" /></div><p className="dashboard-stat-label text-sm text-slate-400">{t('发件记录', 'Sent records')}</p><p className="dashboard-stat-value mt-2 text-3xl font-bold text-slate-800">{stats.sendMailCount}</p></div>
          <div className="dashboard-stat-card rounded-3xl border border-slate-100 bg-white p-4 shadow-sm"><div className="dashboard-logo-frame dashboard-logo-activity mb-4"><ActivityLogo className="dashboard-logo-svg" /></div><p className="dashboard-stat-label text-sm text-slate-400">{t('7天活跃', 'Active 7d')}</p><p className="dashboard-stat-value mt-2 text-3xl font-bold text-slate-800">{stats.activeAddressCount7days}</p></div>
          <div className="dashboard-stat-card rounded-3xl border border-slate-100 bg-white p-4 shadow-sm"><div className="dashboard-logo-frame dashboard-logo-neutral mb-4"><TimeLogo className="dashboard-logo-svg" /></div><p className="dashboard-stat-label text-sm text-slate-400">{t('30天活跃', 'Active 30d')}</p><p className="dashboard-stat-value mt-2 text-3xl font-bold text-slate-800">{stats.activeAddressCount30days}</p></div>
        </section>

        <section className="panel dashboard-quick-panel p-4 sm:p-5">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 className="panel-title">{t('快捷入口', 'Quick actions')}</h3>
              <p className="panel-subtitle mt-1">{t('和管理员后台保持一致的菜单结构，只显示当前账号可用页面。', 'The menu structure matches the admin console and only shows available pages.')}</p>
            </div>
            <span className="dashboard-quick-count">{quickActions.length}</span>
          </div>
          <div className="dashboard-quick-grid mt-4 grid gap-3">
            {quickActions.map((action) => {
              const Icon = action.icon;
              return (
                <button key={action.menu} onClick={() => setActiveMenu(action.menu)} className="dashboard-quick-card text-left transition">
                  <span className="dashboard-quick-logo"><Icon className="dashboard-logo-svg" /></span>
                  <p className="dashboard-quick-title font-semibold text-slate-800">{action.title}</p>
                  <p className="dashboard-quick-desc mt-1 text-sm text-slate-400">{action.desc}</p>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function AccountStatsView({ stats, locale, refresh, loading }: { stats: Statistics; locale: AppLocale; refresh: () => void; loading: boolean }) {
  const t = useLocaleText(locale);
  const total = Math.max(stats.mailCount + stats.addressCount + stats.sendMailCount, 1);
  const mailPercent = Math.round((stats.mailCount / total) * 100);
  const addressPercent = Math.round((stats.addressCount / total) * 100);
  const sentPercent = Math.round((stats.sendMailCount / total) * 100);
  return (
    <div className="stats-view-shell dashboard-view-typography h-full min-h-0 overflow-y-auto p-3 md:p-4 xl:p-6">
      <div className="space-y-3">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
          <div>
            <h2 className="page-title">{t('统计', 'Stats')}</h2>
            <p className="page-subtitle mt-1">{t('仅统计当前账号名下地址、收件和活跃情况。', 'Only counts addresses, inbox mail, and activity under the current account.')}</p>
          </div>
          <button className="btn-secondary compact" onClick={refresh}><RefreshCw size={16} className={cls(loading && 'animate-spin')} />{t('刷新', 'Refresh')}</button>
        </div>
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="dashboard-stat-card rounded-3xl border border-slate-100 bg-white p-4 shadow-sm"><div className="dashboard-logo-frame dashboard-logo-address mb-4"><AddressLogo className="dashboard-logo-svg" /></div><p className="dashboard-stat-label text-sm text-slate-400">{t('地址数量', 'Addresses')}</p><p className="dashboard-stat-value mt-2 text-3xl font-bold text-slate-800">{stats.addressCount}</p></div>
          <div className="dashboard-stat-card rounded-3xl border border-slate-100 bg-white p-4 shadow-sm"><div className="dashboard-logo-frame dashboard-logo-inbox mb-4"><InboxLogo className="dashboard-logo-svg" /></div><p className="dashboard-stat-label text-sm text-slate-400">{t('收件总数', 'Inbox total')}</p><p className="dashboard-stat-value mt-2 text-3xl font-bold text-slate-800">{stats.mailCount}</p></div>
          <div className="dashboard-stat-card rounded-3xl border border-slate-100 bg-white p-4 shadow-sm"><div className="dashboard-logo-frame dashboard-logo-sent mb-4"><Send className="dashboard-logo-svg" /></div><p className="dashboard-stat-label text-sm text-slate-400">{t('发件记录', 'Sent records')}</p><p className="dashboard-stat-value mt-2 text-3xl font-bold text-slate-800">{stats.sendMailCount}</p></div>
          <div className="dashboard-stat-card rounded-3xl border border-slate-100 bg-white p-4 shadow-sm"><div className="dashboard-logo-frame dashboard-logo-neutral mb-4"><TimeLogo className="dashboard-logo-svg" /></div><p className="dashboard-stat-label text-sm text-slate-400">{t('30天活跃地址', 'Active addresses 30d')}</p><p className="dashboard-stat-value mt-2 text-3xl font-bold text-slate-800">{stats.activeAddressCount30days}</p></div>
        </section>
        <section className="panel p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between"><div><h3 className="panel-title">{t('运行占比', 'Operational mix')}</h3><p className="panel-subtitle">{t('用当前用户数据计算。', 'Calculated from current user data.')}</p></div><span className="dashboard-quick-logo"><ChartLogo className="dashboard-logo-svg" /></span></div>
          <div className="dashboard-segment-bar" aria-hidden="true">
            <span className="stat-bar-mint" style={{ width: `${Math.max(mailPercent, 4)}%` }} />
            <span className="stat-bar-sky" style={{ width: `${Math.max(addressPercent, 4)}%` }} />
            <span className="stat-bar-lavender" style={{ width: `${Math.max(sentPercent, 4)}%` }} />
          </div>
          <div className="dashboard-ratio-list mt-4">
            <div className="dashboard-ratio-item"><span className="dashboard-ratio-dot stat-bar-mint" /><span className="dashboard-ratio-main"><strong>{t('收件', 'Inbox')}</strong><small>{mailPercent}%</small></span><span className="dashboard-ratio-number">{stats.mailCount}</span></div>
            <div className="dashboard-ratio-item"><span className="dashboard-ratio-dot stat-bar-sky" /><span className="dashboard-ratio-main"><strong>{t('地址', 'Addresses')}</strong><small>{addressPercent}%</small></span><span className="dashboard-ratio-number">{stats.addressCount}</span></div>
            <div className="dashboard-ratio-item"><span className="dashboard-ratio-dot stat-bar-lavender" /><span className="dashboard-ratio-main"><strong>{t('发件', 'Sent')}</strong><small>{sentPercent}%</small></span><span className="dashboard-ratio-number">{stats.sendMailCount}</span></div>
          </div>
        </section>
      </div>
    </div>
  );
}

function MailDetail({ mail, mode, locale }: { mail: AddressMail | null; mode: MailMode; locale: AppLocale }) {
  const t = useLocaleText(locale);
  if (!mail) {
    const emptyIcon = mode === 'sent' ? Send : mode === 'unknown' ? AlertCircle : Inbox;
    return (
      <div className="grid h-full min-h-0 place-items-center p-5">
        <EmptyState icon={emptyIcon} title={t('请选择一封邮件', 'Select a mail')} body={t('从左侧列表打开邮件后，会在这里显示完整内容。', 'Open a message from the list to read the full content here.')} />
      </div>
    );
  }
  const body = mailBody(mail);
  const recipientLabel = mode === 'sent' ? t('发件邮箱：', 'Sender mailbox:') : t('收件邮箱：', 'Inbox:');
  return (
    <div className="mail-detail-scroll h-full overflow-y-auto p-3 md:p-5">
      <article className="mail-detail-card min-h-full rounded-[1.4rem] border border-slate-100 bg-white p-4 shadow-sm md:p-6">
        <div className="flex flex-col gap-3 border-b border-slate-100 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mail-time mail-detail-meta-pill rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{formatDateTime(mail.created_at)}</span>
            <span className="mail-detail-meta-pill rounded-full bg-slate-50 px-2 py-0.5 text-xs font-semibold text-slate-500">#{mail.id}</span>
            {mode === 'unknown' ? <span className="mail-detail-meta-pill rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-600">{t('未知邮件', 'Unknown mail')}</span> : null}
          </div>
          <h2 className="mail-detail-subject text-2xl font-semibold leading-tight text-slate-900">{mailTitle(mail, locale)}</h2>
          <div className="account-address-row mail-detail-recipient-row">
            <span className="text-sm text-slate-500">{recipientLabel}</span>
            <span className="plain-copy-address">{mail.address || '-'}</span>
          </div>
        </div>
        <div className="mt-5">
          {body ? (
            <pre className="mail-text whitespace-pre-wrap rounded-2xl border border-slate-100 bg-slate-50 p-4 text-sm leading-7 text-slate-700">{body}</pre>
          ) : (
            <EmptyState title={t('无正文内容', 'No content')} body={t('这封邮件没有返回可展示的正文。', 'This message did not return displayable content.')} />
          )}
        </div>
      </article>
    </div>
  );
}

function MailboxReader({ apiBase, jwt, address, locale, mode = 'inbox', refreshKey = 0, onMailCountChange }: {
  apiBase: string;
  jwt: string;
  address: string;
  locale: AppLocale;
  mode?: MailMode;
  refreshKey?: number;
  onMailCountChange?: (count: number) => void;
}) {
  const [mails, setMails] = useState<AddressMail[]>([]);
  const [selected, setSelected] = useState<AddressMail | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const t = useLocaleText(locale);
  const title = mode === 'sent' ? t('发件箱', 'Sent') : mode === 'unknown' ? t('未知邮件', 'Unknown mail') : t('收件箱', 'Inbox');
  const emptyIcon = mode === 'sent' ? Send : mode === 'unknown' ? AlertCircle : Inbox;

  const load = useCallback(async () => {
    if (mode !== 'inbox') {
      setMails([]);
      setSelected(null);
      onMailCountChange?.(0);
      return;
    }
    if (!jwt) return;
    setLoading(true);
    setError('');
    try {
      const page = await fetchAddressMails(apiBase, jwt, 80, 0);
      setMails(page.results);
      onMailCountChange?.(page.count || page.results.length);
      setSelected((current) => (current && page.results.some((mail) => mail.id === current.id) ? current : page.results[0] || null));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('邮件加载失败', 'Failed to load mail'));
    } finally {
      setLoading(false);
    }
  }, [apiBase, jwt, mode, onMailCountChange, t]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const visibleMails = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return mails;
    return mails.filter((mail) => `${mail.subject || ''} ${mail.source || ''} ${mail.address || ''} ${mail.raw || ''} ${mail.metadata || ''}`.toLowerCase().includes(keyword));
  }, [mails, query]);

  useEffect(() => {
    if (!selected) return;
    if (visibleMails.some((mail) => mail.id === selected.id)) return;
    setSelected(visibleMails[0] || null);
  }, [selected, visibleMails]);

  return (
    <div className="mail-workspace flex h-full min-h-0 overflow-hidden bg-white">
      <div className="mail-list-panel relative flex h-full min-h-0 w-full shrink-0 flex-col border-r border-slate-100 lg:w-[430px] xl:w-[470px]">
        <div className="mail-list-header shrink-0 px-2.5 py-2 md:p-4 md:pb-2">
          <div className="mail-toolbar flex flex-wrap items-center gap-2">
            <div className="mr-auto min-w-0">
              <div className="mail-title-line flex items-center gap-2">
                <h2 className="mail-title-heading truncate text-[17px] font-bold text-slate-800 md:text-2xl">{title}</h2>
                <span className="mail-count-badge rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 md:text-sm">{locale === 'en-US' ? `${visibleMails.length} mails` : `${visibleMails.length} 封`}</span>
              </div>
              <div className="mail-auto-refresh-note mt-1 truncate text-[11px] font-medium text-slate-500">{address || t('当前账号', 'Current account')}</div>
            </div>
            <button className="mail-tool-btn primary mail-search-refresh" onClick={() => void load()} title={t('刷新', 'Refresh')} aria-label={t('刷新', 'Refresh')}>
              <RefreshCw size={15} className={cls(loading && 'animate-spin')} />
              <span className="mail-tool-text">{t('刷新', 'Refresh')}</span>
            </button>
          </div>
          <div className="mail-address-search-row mt-2">
            <div className="address-filter-wrap">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="form-input address-filter-input rounded-xl py-1.5 pl-9 pr-9 text-[13px] md:rounded-2xl md:py-2 md:text-sm"
                placeholder={t('搜索邮箱、主题或正文', 'Search mailbox, subject, or body')}
                inputMode="text"
                autoCapitalize="none"
                autoCorrect="off"
              />
              {query && (
                <button type="button" className="address-filter-clear" onClick={() => setQuery('')} aria-label={t('清空邮件搜索', 'Clear mail search')} title={t('清空邮件搜索', 'Clear mail search')}>
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
        {error ? <div className="mx-4 mb-2 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</div> : null}
        <div className="mail-list-viewport flex-1 overflow-y-auto px-2 pb-2 md:px-4 md:pb-4">
          {loading && mails.length === 0 ? <LoadingState label={t('正在加载邮件...', 'Loading mail...')} /> : visibleMails.length === 0 ? (
            <EmptyState icon={emptyIcon} title={t('没有匹配的邮件', 'No matching mail')} body={query ? t('搜索结果为空，清空关键词或刷新后再试。', 'No search results. Clear the keyword or refresh.') : t('当前账号暂时没有可查看的邮件。', 'There is no mail available for this account yet.')} />
          ) : visibleMails.map((mail) => {
            const active = selected?.id === mail.id;
            return (
              <button
                key={mail.id}
                type="button"
                onClick={() => setSelected(mail)}
                className={cls('mail-list-item group relative mb-1 w-full cursor-pointer px-3 py-2 text-left transition-all md:px-3.5', active ? 'mail-row-selected' : 'mail-row-idle')}
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <div className="mail-avatar-wrap">
                    <span className="brand-avatar brand-avatar-fallback mail-list-brand-avatar flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
                      {(mail.source || mail.address || 'M').slice(0, 1).toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <span className="mail-sender block truncate text-[13px] font-normal text-slate-600 md:text-[14px]">{mail.source || mail.address || t('未知发件人', 'Unknown sender')}</span>
                        <h4 className="mail-subject mt-0.5 truncate text-[14px] font-semibold text-slate-900 md:text-[15px]">{mailTitle(mail, locale)}</h4>
                      </div>
                      <span className="mail-time shrink-0 text-[12px] font-semibold text-slate-600">{formatShortDate(mail.created_at)}</span>
                    </div>
                    <p className="line-clamp-2 text-[12px] leading-5 text-slate-500">{mailPreview(mail) || t('无预览', 'No preview')}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="mail-detail-pane hidden h-full min-w-0 flex-1 flex-col bg-slate-50/40 lg:flex">
        <MailDetail mail={selected} mode={mode} locale={locale} />
      </div>
    </div>
  );
}

function AddressManagementView({
  addresses,
  domains,
  profile,
  selectedAddress,
  busy,
  error,
  newName,
  newDomain,
  randomSubdomain,
  locale,
  setNewName,
  setNewDomain,
  setRandomSubdomain,
  createAddress,
  createShare,
  loadAddresses,
  openInbox,
  openSent,
}: {
  addresses: UserAddress[];
  domains: string[];
  profile: AccountUserProfile;
  selectedAddress: UserAddress | null;
  busy: string;
  error: string;
  newName: string;
  newDomain: string;
  randomSubdomain: boolean;
  locale: AppLocale;
  setNewName: (value: string) => void;
  setNewDomain: (value: string) => void;
  setRandomSubdomain: (value: boolean) => void;
  createAddress: () => Promise<boolean>;
  createShare: (rows: UserAddress[], expiresIn: UserShareExpiry, mailVisibility: UserShareMailVisibility, allowHideMail: boolean) => Promise<UserShareResult>;
  loadAddresses: () => Promise<void>;
  openInbox: (address: UserAddress) => void;
  openSent: (address: UserAddress) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<AddressSortKey>('updated');
  const [sortOrder, setSortOrder] = useState<SortOrder>('descend');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selectedMap, setSelectedMap] = useState<Record<number, boolean>>({});
  const [shareOpen, setShareOpen] = useState(false);
  const [shareExpiry, setShareExpiry] = useState<UserShareExpiry>('30d');
  const [shareMailVisibility, setShareMailVisibility] = useState<UserShareMailVisibility>('new');
  const [shareAllowHideMail, setShareAllowHideMail] = useState(true);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareActionBusy, setShareActionBusy] = useState<number | null>(null);
  const [shareResult, setShareResult] = useState<UserShareResult | null>(null);
  const [copyNotice, setCopyNotice] = useState('');
  const t = useLocaleText(locale);
  const selectedIds = useMemo(() => new Set(Object.entries(selectedMap).filter(([, selected]) => selected).map(([id]) => Number(id))), [selectedMap]);
  const selectedRows = useMemo(() => addresses.filter((row) => selectedIds.has(row.id)), [addresses, selectedIds]);
  const addressCount = addresses.length;
  const mailCount = addresses.reduce((sum, row) => sum + Number(row.mail_count || 0), 0);
  const sendCount = addresses.reduce((sum, row) => sum + Number(row.send_count || 0), 0);
  const roleLabel = profile.roleLabel || profile.roleKey || (profile.isAdmin ? 'Admin' : 'Member');
  const domainOptions = domains.length
    ? domains.map((domain) => ({ value: domain, label: domain, description: t('当前角色可用', 'Available for this role') }))
    : [{ value: '', label: t('默认域名', 'Default domain'), description: t('由后端默认域名决定', 'Resolved by backend default') }];
  const sortOptions = [
    { value: 'updated', label: t('更新时间', 'Updated') },
    { value: 'address', label: t('地址', 'Address') },
    { value: 'inbox', label: t('收件数', 'Inbox') },
    { value: 'sent', label: t('发件数', 'Sent') },
  ];
  const shareExpiryOptions = [
    { value: '1d', label: t('1 天', '1 day'), description: t('短期分享', 'Short share') },
    { value: '7d', label: t('7 天', '7 days'), description: t('一周有效', 'Valid for one week') },
    { value: '30d', label: t('30 天', '30 days'), description: t('默认有效期', 'Default expiry') },
    { value: 'forever', label: t('永久有效', 'Never expires'), description: t('手动撤销前有效', 'Valid until revoked') },
  ];
  const shareVisibilityOptions = [
    { value: 'new', label: t('仅新增邮件', 'New mail only'), description: t('从创建分享后开始显示', 'Show mail after share creation') },
    { value: 'all', label: t('全部邮件', 'All mail'), description: t('包含已有邮件', 'Include existing mail') },
  ];

  const filteredRows = useMemo(() => {
    const keyword = normalizeSearchText(query);
    const rows = keyword
      ? addresses.filter((row) => normalizeSearchText(`${row.id} ${row.name} ${getAddressDomain(row.name)} ${profile.userEmail} ${roleLabel}`).includes(keyword))
      : [...addresses];
    rows.sort((left, right) => {
      let result = 0;
      if (sortBy === 'address') result = left.name.localeCompare(right.name);
      else if (sortBy === 'inbox') result = Number(left.mail_count || 0) - Number(right.mail_count || 0);
      else if (sortBy === 'sent') result = Number(left.send_count || 0) - Number(right.send_count || 0);
      else result = new Date(left.updated_at || left.created_at || 0).getTime() - new Date(right.updated_at || right.created_at || 0).getTime();
      return sortOrder === 'ascend' ? result : -result;
    });
    return rows;
  }, [addresses, profile.userEmail, query, roleLabel, sortBy, sortOrder]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const pageRows = useMemo(() => filteredRows.slice((page - 1) * pageSize, page * pageSize), [filteredRows, page, pageSize]);
  const allPageSelected = pageRows.length > 0 && pageRows.every((row) => selectedIds.has(row.id));
  const previewDomain = domains.length ? (newDomain || domains[0]) : t('默认域名', 'default domain');
  const previewName = newName.trim() || t('自动生成', 'auto');

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const showNotice = (message: string) => {
    setCopyNotice(message);
    window.setTimeout(() => setCopyNotice(''), 1800);
  };

  const copyAddress = async (address: string) => {
    try {
      await copyText(address);
      showNotice(t('地址已复制', 'Address copied'));
    } catch (err) {
      showNotice(err instanceof Error ? err.message : t('复制失败', 'Copy failed'));
    }
  };

  const toggleSelected = (row: UserAddress) => {
    setSelectedMap((current) => ({ ...current, [row.id]: !current[row.id] }));
  };

  const toggleSelectAll = () => {
    setSelectedMap((current) => {
      const next = { ...current };
      if (allPageSelected) pageRows.forEach((row) => { delete next[row.id]; });
      else pageRows.forEach((row) => { next[row.id] = true; });
      return next;
    });
  };

  const handleCreateAddress = async () => {
    const ok = await createAddress();
    if (ok) setCreateOpen(false);
  };

  const runShare = async (rows: UserAddress[], source: 'bulk' | number, expiresIn = shareExpiry, visibility = shareMailVisibility) => {
    if (!rows.length) {
      showNotice(t('请先勾选要共享的邮箱', 'Select mailboxes to share first'));
      return;
    }
    setShareResult(null);
    if (source === 'bulk') setShareBusy(true);
    else setShareActionBusy(source);
    try {
      const result = await createShare(rows, expiresIn, visibility, shareAllowHideMail);
      setShareResult(result);
      await copyText(result.url);
      showNotice(rows.length === 1 ? t('共享链接已创建并复制', 'Share link created and copied') : t('批量共享链接已创建并复制', 'Batch share link created and copied'));
      if (source !== 'bulk') return;
    } catch (err) {
      showNotice(err instanceof Error ? err.message : t('创建共享链接失败', 'Failed to create share link'));
    } finally {
      if (source === 'bulk') setShareBusy(false);
      else setShareActionBusy(null);
    }
  };

  const openShareDialog = () => {
    if (!selectedRows.length) {
      showNotice(t('请先勾选要共享的邮箱', 'Select mailboxes to share first'));
      return;
    }
    setShareResult(null);
    setShareOpen(true);
  };

  const renderMobileAddressCard = (row: UserAddress) => {
    const active = selectedAddress?.id === row.id;
    const checked = selectedIds.has(row.id);
    return (
      <article key={row.id} className={cls('mobile-address-card', active && 'ring-2 ring-slate-900/5')}>
        <div className="flex items-start gap-3">
          <input className="row-check mt-1" type="checkbox" checked={checked} onChange={() => toggleSelected(row)} aria-label={locale === 'en-US' ? `Select ${row.name}` : `选择 ${row.name}`} />
          <div className="min-w-0 flex-1">
            <button className="address-strong max-w-full truncate text-left" onClick={() => void copyAddress(row.name)}>{row.name}</button>
            <p className="mt-1 text-xs text-slate-400">#{row.id} · {roleLabel} · {getAddressDomain(row.name) || '-'}</p>
          </div>
          <button className="table-action" onClick={() => void copyAddress(row.name)} title={t('复制地址', 'Copy address')}><Copy size={15} /></button>
        </div>
        <div className="mobile-address-stats mt-3 grid grid-cols-3 gap-2 text-xs text-slate-500">
          <div className="rounded-xl bg-slate-50 px-2.5 py-2"><span className="block text-[10px] text-slate-400">{t('前缀', 'Local')}</span><span className="mt-0.5 block truncate font-medium text-slate-700">{getAddressLocal(row.name)}</span></div>
          <div className="rounded-xl bg-slate-50 px-2.5 py-2"><span className="block text-[10px] text-slate-400">{t('收件', 'Inbox')}</span><span className="mt-0.5 block font-medium text-slate-700">{row.mail_count ?? 0}</span></div>
          <div className="rounded-xl bg-slate-50 px-2.5 py-2"><span className="block text-[10px] text-slate-400">{t('更新', 'Updated')}</span><span className="mt-0.5 block truncate">{formatDateTime(row.updated_at || row.created_at)}</span></div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <button className="btn-secondary compact justify-center" onClick={() => openInbox(row)}><MailOpen size={14} /> {t('收件', 'Inbox')}</button>
          <button className="btn-secondary compact justify-center" onClick={() => openSent(row)}><Send size={14} /> {t('发件', 'Sent')}</button>
          <button className="btn-secondary compact justify-center" disabled={shareActionBusy === row.id} onClick={() => void runShare([row], row.id, '30d', 'new')}><Share2 size={14} className={cls(shareActionBusy === row.id && 'animate-pulse')} /> {t('分享', 'Share')}</button>
        </div>
      </article>
    );
  };

  return (
    <div className="address-view-shell h-full space-y-4 overflow-y-auto p-3 md:p-4 xl:p-6">
      <div className="address-page-head flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div className="address-page-title">
          <h2 className="text-2xl font-bold text-slate-800">{t('地址管理', 'Address management')}</h2>
          <p className="mt-1 text-sm text-slate-400">{t('创建、搜索、分享并打开当前账号名下的邮箱地址。', 'Create, search, share, and open mailbox addresses under this account.')}</p>
        </div>
        <div className="address-page-actions flex flex-wrap gap-2">
          <button className="btn-primary" onClick={() => setCreateOpen(true)}><Plus size={16} /> <span>{t('新建地址', 'New address')}</span></button>
          <button className="btn-secondary" onClick={openShareDialog}><Share2 size={16} /> <span>{t('创建共享链接', 'Create share link')}</span></button>
          <button className="btn-secondary" onClick={() => void loadAddresses()}><RefreshCw size={15} className={cls(busy === 'list' && 'animate-spin')} /> <span>{t('刷新', 'Refresh')}</span></button>
        </div>
      </div>

      <section className="grid gap-3 md:grid-cols-3">
        <div className="panel p-4"><p className="text-xs font-medium text-slate-400">{t('我的地址', 'My addresses')}</p><p className="mt-2 text-3xl font-semibold text-slate-900">{addressCount}</p></div>
        <div className="panel p-4"><p className="text-xs font-medium text-slate-400">{t('收件总数', 'Inbox total')}</p><p className="mt-2 text-3xl font-semibold text-slate-900">{mailCount}</p></div>
        <div className="panel p-4"><p className="text-xs font-medium text-slate-400">{t('发件记录', 'Sent records')}</p><p className="mt-2 text-3xl font-semibold text-slate-900">{sendCount}</p></div>
      </section>

      <div className="panel overflow-hidden">
        <div className="address-toolbar">
          <div className="toolbar-field user-filter-trigger">
            <KeyRound size={15} className="toolbar-icon" />
            <span className="user-filter-copy">
              <span className="user-filter-label">{profile.userEmail || t('当前用户', 'Current user')}</span>
              <span className="user-filter-count">{roleLabel}</span>
            </span>
          </div>
          <label className="toolbar-field address-search-field" aria-label={t('搜索地址', 'Search addresses')}>
            <Search size={15} className="toolbar-icon" />
            <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder={t('搜索地址', 'Search addresses')} />
            {query && (
              <button
                type="button"
                className="address-search-clear"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { setQuery(''); setPage(1); }}
                aria-label={t('清空地址搜索', 'Clear address search')}
                title={t('清空地址搜索', 'Clear address search')}
              >
                <X size={13} />
              </button>
            )}
          </label>
          <PopoverSelect className="address-sort-select" ariaLabel={t('地址排序字段', 'Address sort field')} value={sortBy} options={sortOptions} onChange={(value) => setSortBy(value as AddressSortKey)} />
          <button className="btn-secondary compact toolbar-action sort-order-action" title={sortOrder === 'ascend' ? t('当前升序，点击切换', 'Currently ascending. Click to toggle.') : t('当前降序，点击切换', 'Currently descending. Click to toggle.')} onClick={() => setSortOrder(sortOrder === 'ascend' ? 'descend' : 'ascend')}><ListFilter size={15} /> <span>{sortOrder === 'ascend' ? t('升序', 'Asc') : t('降序', 'Desc')}</span></button>
          <button className="btn-secondary compact toolbar-action address-toolbar-refresh" title={t('刷新地址列表', 'Refresh address list')} aria-label={t('刷新地址列表', 'Refresh address list')} onClick={() => void loadAddresses()}><RefreshCw size={15} className={cls(busy === 'list' && addresses.length > 0 && 'animate-spin')} /> <span>{t('刷新', 'Refresh')}</span></button>
        </div>
        {selectedRows.length > 0 && (
          <div className="address-bulk-bar">
            <div className="address-bulk-summary">
              <strong>{locale === 'en-US' ? `${selectedRows.length} addresses selected` : `已选择 ${selectedRows.length} 个地址`}</strong>
              <span>{t('可批量生成多邮箱共享链接。', 'Create a multi-mailbox share link in one action.')}</span>
            </div>
            <div className="address-bulk-actions">
              <button className="btn-secondary compact" onClick={openShareDialog}><Share2 size={15} /> {t('创建共享链接', 'Create share link')}</button>
              <button className="btn-secondary compact mobile-bulk-clear" onClick={() => setSelectedMap({})}><X size={15} /> {t('清除选择', 'Clear selection')}</button>
            </div>
          </div>
        )}
        {copyNotice ? <div className="mx-4 mb-3 rounded-xl bg-slate-50 px-3 py-2 text-sm font-medium text-slate-600">{copyNotice}</div> : null}
        {error ? <div className="mx-4 mb-3 rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">{error}</div> : null}
        {busy === 'list' && addresses.length === 0 ? <LoadingState label={t('正在加载地址...', 'Loading addresses...')} /> : filteredRows.length === 0 ? (
          <div className="p-4 md:p-6"><EmptyState title={t('暂无地址', 'No addresses')} body={t('可以通过右上角新建地址。', 'Use New address in the top-right to create one.')} /></div>
        ) : (
          <>
            <div className="space-y-2 p-3 md:hidden">
              {pageRows.map(renderMobileAddressCard)}
            </div>
            <div className="address-table-wrap hidden overflow-auto md:block">
              <table className="data-table action-table">
                <thead>
                  <tr>
                    <th><input className="row-check" type="checkbox" checked={allPageSelected} onChange={toggleSelectAll} aria-label={t('全选地址', 'Select all addresses')} /></th>
                    <th>ID</th>
                    <th>{t('地址', 'Address')}</th>
                    <th>{t('来源', 'Source')}</th>
                    <th>{t('收件', 'Inbox')}</th>
                    <th>{t('发件', 'Sent')}</th>
                    <th>{t('更新时间', 'Updated')}</th>
                    <th className="address-actions-th text-right">{t('操作', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
                    <tr key={row.id} className={cls(selectedAddress?.id === row.id && 'user-row-expanded')}>
                      <td><input className="row-check" type="checkbox" checked={selectedIds.has(row.id)} onChange={() => toggleSelected(row)} aria-label={locale === 'en-US' ? `Select ${row.name}` : `选择 ${row.name}`} /></td>
                      <td className="font-mono text-xs text-slate-400">#{row.id}</td>
                      <td><button className="address-strong" onClick={() => void copyAddress(row.name)} title={t('点击复制邮箱地址', 'Copy mailbox address')}>{row.name}</button><p className="mt-1 text-xs text-slate-400">{profile.userEmail || '-'}</p></td>
                      <td>{roleLabel}</td>
                      <td>{row.mail_count ?? 0}</td>
                      <td>{row.send_count ?? 0}</td>
                      <td>{formatDateTime(row.updated_at || row.created_at)}</td>
                      <td className="address-actions-cell">
                        <div className="address-desktop-actions">
                          <button className="table-action" onClick={() => void copyAddress(row.name)} title={t('复制邮箱地址', 'Copy mailbox address')}><Copy size={15} /></button>
                          <button className="table-action" disabled={shareActionBusy === row.id} onClick={() => void runShare([row], row.id, '30d', 'new')} title={t('创建共享链接', 'Create share link')}><Share2 size={15} className={cls(shareActionBusy === row.id && 'animate-pulse')} /></button>
                          <button className="table-action" onClick={() => openInbox(row)} title={t('查看收件箱', 'View inbox')}><MailOpen size={15} /></button>
                          <button className="table-action" onClick={() => openSent(row)} title={t('查看发件箱', 'View sent')}><Send size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <Pagination page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} count={filteredRows.length} />
      </div>

      {createOpen && (
        <Modal
          title={t('新建邮箱地址', 'New mailbox address')}
          onClose={() => setCreateOpen(false)}
          cardClassName="new-address-modal-card"
          bodyClassName="new-address-modal-body"
        >
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(160px,220px)]">
              <div>
                <label className="form-label">{t('邮箱名称', 'Mailbox name')}</label>
                <input className="form-input compact-control" value={newName} onChange={(event) => setNewName(event.target.value.trim())} placeholder={t('留空自动生成', 'Leave empty to auto-generate')} autoCapitalize="none" autoCorrect="off" />
              </div>
              <div>
                <label className="form-label">{t('邮箱域名', 'Mailbox domain')}</label>
                <PopoverSelect ariaLabel={t('邮箱域名', 'Mailbox domain')} value={newDomain || domainOptions[0]?.value || ''} options={domainOptions} className="new-address-domain-select" onChange={setNewDomain} />
              </div>
            </div>
            <div className="rounded-2xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
              {t('预览：', 'Preview: ')}<span className="font-semibold text-slate-800">{previewName}@{previewDomain}</span>
            </div>
            <label className="check-row rounded-xl bg-slate-50 px-3 py-2"><input type="checkbox" checked={randomSubdomain} onChange={(event) => setRandomSubdomain(event.target.checked)} />{t('随机二级域名', 'Random subdomain')}</label>
            {error ? <p className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">{error}</p> : null}
            <button className="btn-primary w-full" disabled={busy === 'create'} onClick={() => void handleCreateAddress()}>
              {busy === 'create' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus size={16} />} {busy === 'create' ? t('创建中...', 'Creating...') : t('创建', 'Create')}
            </button>
          </div>
        </Modal>
      )}

      {shareOpen && (
        <Modal title={locale === 'en-US' ? `Create share link (${selectedRows.length})` : `创建共享链接（${selectedRows.length} 个）`} onClose={() => setShareOpen(false)}>
          <div className="space-y-4">
            <div className="rounded-2xl bg-slate-50 px-3 py-2 text-sm text-slate-500">
              {t('共享对象：', 'Sharing: ')}<span className="font-semibold text-slate-800">{selectedRows.length}</span>{t(' 个邮箱地址', ' mailbox addresses')}
            </div>
            <div>
              <label className="form-label">{t('有效期', 'Expiry')}</label>
              <PopoverSelect ariaLabel={t('共享链接有效期', 'Share link expiry')} value={shareExpiry} options={shareExpiryOptions} onChange={(value) => setShareExpiry(value as UserShareExpiry)} />
            </div>
            <div>
              <label className="form-label">{t('邮件范围', 'Mail range')}</label>
              <PopoverSelect ariaLabel={t('共享邮件范围', 'Shared mail range')} value={shareMailVisibility} options={shareVisibilityOptions} onChange={(value) => setShareMailVisibility(value as UserShareMailVisibility)} />
            </div>
            <label className="check-row rounded-xl bg-slate-50 px-3 py-2"><input type="checkbox" checked={shareAllowHideMail} onChange={(event) => setShareAllowHideMail(event.target.checked)} />{t('允许访客从分享页隐藏邮件', 'Allow visitors to hide mail in the share page')}</label>
            <button className="btn-primary w-full" disabled={shareBusy || selectedRows.length === 0} onClick={() => void runShare(selectedRows, 'bulk')}>
              {shareBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 size={16} />} {shareBusy ? t('正在创建...', 'Creating...') : t('创建并复制共享链接', 'Create and copy share link')}
            </button>
            {shareResult ? (
              <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                <code className="block overflow-hidden text-ellipsis whitespace-nowrap rounded-xl bg-white px-3 py-2 text-xs text-slate-500">{shareResult.url}</code>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="btn-secondary compact" onClick={() => void copyText(shareResult.url)}><Copy size={15} /> {t('复制', 'Copy')}</button>
                  <a className="btn-secondary compact" href={shareResult.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> {t('打开测试', 'Open test')}</a>
                </div>
              </div>
            ) : null}
          </div>
        </Modal>
      )}
    </div>
  );
}

export function DirectMailboxConsole({ apiBase, jwt, address, locale, theme, setTheme, setLocale, onSignOut }: {
  apiBase: string;
  jwt: string;
  address: string;
  locale: AppLocale;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  setLocale: (locale: AppLocale) => void;
  onSignOut: () => void;
}) {
  const [mailRefreshKey, setMailRefreshKey] = useState(0);
  const [mailCount, setMailCount] = useState(0);
  const stats = useMemo(() => ({ ...EMPTY_STATS, addressCount: 1, mailCount }), [mailCount]);

  return (
    <div className={cls('h-[100dvh] w-full overflow-hidden bg-[var(--color-bg)] font-sans text-slate-800', theme === 'dark' && 'theme-dark')}>
      <div className="flex h-full w-full min-w-0 overflow-hidden bg-[var(--color-bg)]">
        <Sidebar
          activeMenu="inbox"
          setActiveMenu={() => undefined}
          stats={stats}
          theme={theme}
          setTheme={setTheme}
          locale={locale}
          setLocale={setLocale}
          refresh={() => setMailRefreshKey((value) => value + 1)}
          apiBase={apiBase}
          connected
          accountName={address}
          accountMeta={address}
          allowedMenus={DIRECT_ALLOWED_MENUS}
          showComposeButton={false}
          showSettingsShortcut={false}
          miniActionColumns={2}
          sidebarSubtitle={localeText('邮箱直达', 'Mailbox', locale)}
        >
          <button className="sidebar-mini-btn" onClick={onSignOut} title={localeText('退出登录', 'Sign out', locale)}><LogOut size={15} />{localeText('退出', 'Sign out', locale)}</button>
        </Sidebar>
        <main className="mobile-page-swipe-zone mobile-mail-shell relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-surface)]">
          <Header activeMenu="inbox" setActiveMenu={() => undefined} query="" setQuery={() => undefined} refresh={() => setMailRefreshKey((value) => value + 1)} apiBase={apiBase} locale={locale} />
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden pb-[calc(62px+env(safe-area-inset-bottom))] md:pb-0">
            <MailboxReader apiBase={apiBase} jwt={jwt} address={address} locale={locale} refreshKey={mailRefreshKey} onMailCountChange={setMailCount} />
          </div>
          <MobileNav activeMenu="inbox" visualActiveMenu="inbox" setActiveMenu={() => undefined} locale={locale} allowedMenus={DIRECT_ALLOWED_MENUS} />
        </main>
      </div>
    </div>
  );
}

export function AccountConsole({ apiBase, profile, locale, theme, setTheme, setLocale, onSignOut }: {
  apiBase: string;
  profile: AccountUserProfile;
  locale: AppLocale;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  setLocale: (locale: AppLocale) => void;
  onSignOut: () => void;
}) {
  const [activeMenu, setActiveMenu] = useState<MenuKey>('dashboard');
  const [addresses, setAddresses] = useState<UserAddress[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<UserAddress | null>(null);
  const [selectedJwt, setSelectedJwt] = useState('');
  const [newName, setNewName] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [randomSubdomain, setRandomSubdomain] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [mailRefreshKey, setMailRefreshKey] = useState(0);
  const domains = useMemo(() => roleDomains(profile), [profile]);
  const stats = useMemo(() => statsFromAddresses(addresses), [addresses]);
  const t = useLocaleText(locale);
  const apiClient = useMemo(() => createApiClient(
    () => apiBase,
    () => ({ accountUserToken: profile.userToken, lang: locale === 'en-US' ? 'en' : 'zh' }),
  ), [apiBase, locale, profile.userToken]);
  const request = useCallback(<T,>(path: string, options?: Parameters<typeof apiClient.request>[1]) => apiClient.request<T>(path, options), [apiClient]);
  const { ask, modal: confirmModal } = useConfirm();
  const { notice, push } = useNotice();

  const loadAddresses = useCallback(async () => {
    setBusy('list');
    setError('');
    try {
      const rows = await fetchUserAddresses(apiBase, profile.userToken);
      setAddresses(rows);
      setSelectedAddress((current) => {
        if (current) {
          const refreshed = rows.find((row) => row.id === current.id);
          if (refreshed) return refreshed;
        }
        return rows[0] || null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('邮箱列表加载失败', 'Failed to load addresses'));
    } finally {
      setBusy('');
    }
  }, [apiBase, profile.userToken, t]);

  useEffect(() => {
    void loadAddresses();
  }, [loadAddresses]);

  useEffect(() => {
    if (!selectedAddress) {
      setSelectedJwt('');
      return;
    }
    let cancelled = false;
    setBusy(`open:${selectedAddress.id}`);
    fetchAddressJwt(apiBase, profile.userToken, selectedAddress.id)
      .then((jwt) => {
        if (!cancelled) setSelectedJwt(jwt);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('邮箱打开失败', 'Failed to open mailbox'));
      })
      .finally(() => {
        if (!cancelled) setBusy('');
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, profile.userToken, selectedAddress, t]);

  const createAddress = async () => {
    setBusy('create');
    setError('');
    try {
      const domain = domains.length ? (newDomain || domains[0]) : '';
      await createUserAddress(apiBase, profile.userToken, {
        name: newName.trim(),
        domain: domain || undefined,
        enableRandomSubdomain: randomSubdomain,
      });
      setNewName('');
      setNewDomain('');
      setRandomSubdomain(false);
      await loadAddresses();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('创建失败', 'Create failed'));
      return false;
    } finally {
      setBusy('');
    }
  };

  const createShareForRows = useCallback((rows: UserAddress[], expiresIn: UserShareExpiry, mailVisibility: UserShareMailVisibility, allowHideMail: boolean) => (
    createUserShare(apiBase, profile.userToken, FRONTEND_LOGIN_BASE, rows, { expiresIn, mailVisibility, allowHideMail })
  ), [apiBase, profile.userToken]);

  const openInbox = (addressRow: UserAddress) => {
    setSelectedAddress(addressRow);
    setActiveMenu('inbox');
    setMailRefreshKey((value) => value + 1);
  };

  const openSent = (addressRow: UserAddress) => {
    setSelectedAddress(addressRow);
    setActiveMenu('sent');
    setMailRefreshKey((value) => value + 1);
  };

  const refreshCurrent = () => {
    if (activeMenu === 'address' || activeMenu === 'dashboard' || activeMenu === 'stats') {
      void loadAddresses();
      return;
    }
    setMailRefreshKey((value) => value + 1);
  };

  const syncAddressRows = useCallback((rows: AddressRecord[]) => {
    const nextRows: UserAddress[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      mail_count: row.mail_count,
      send_count: row.send_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
    setAddresses(nextRows);
    setSelectedAddress((current) => {
      if (current) {
        const refreshed = nextRows.find((row) => row.id === current.id || row.name === current.name);
        if (refreshed) return refreshed;
      }
      return nextRows[0] || null;
    });
  }, []);

  const openInboxByAddress = useCallback((address: string) => {
    const row = addresses.find((item) => item.name === address);
    if (!row) {
      setError(t('请先刷新地址列表后再打开邮箱', 'Refresh the address list before opening this mailbox'));
      void loadAddresses();
      return;
    }
    openInbox(row);
  }, [addresses, loadAddresses, t]);

  const renderMailSection = (mode: MailMode) => (
    selectedAddress && selectedJwt ? (
      <MailboxReader
        apiBase={apiBase}
        jwt={selectedJwt}
        address={selectedAddress.name}
        locale={locale}
        mode={mode}
        refreshKey={mailRefreshKey}
      />
    ) : (
      <div className="grid h-full place-items-center p-4">
        {busy.startsWith('open:')
          ? <LoadingState label={t('正在打开邮箱...', 'Opening mailbox...')} />
          : <EmptyState icon={mode === 'sent' ? Send : mode === 'unknown' ? AlertCircle : Inbox} title={t('请选择邮箱', 'Select a mailbox')} body={t('从地址管理打开自己的邮箱。', 'Open one of your own mailboxes from address management.')} />}
      </div>
    )
  );

  return (
    <div className={cls('h-[100dvh] w-full overflow-hidden bg-[var(--color-bg)] font-sans text-slate-800', theme === 'dark' && 'theme-dark')}>
      <div className="flex h-full w-full min-w-0 overflow-hidden bg-[var(--color-bg)]">
        <Sidebar
          activeMenu={activeMenu}
          setActiveMenu={setActiveMenu}
          stats={stats}
          theme={theme}
          setTheme={setTheme}
          locale={locale}
          setLocale={setLocale}
          refresh={refreshCurrent}
          apiBase={apiBase}
          connected
          accountName={accountName(profile)}
          accountMeta={accountMeta(profile, locale)}
          allowedMenus={ACCOUNT_ALLOWED_MENUS}
          showComposeButton={false}
          showSettingsShortcut={false}
          miniActionColumns={2}
          sidebarSubtitle={t('个人管理后台', 'Personal console')}
        >
          <UserCredentialButton profile={profile} locale={locale} onSignOut={onSignOut} />
        </Sidebar>
        <main className={cls('mobile-page-swipe-zone relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-surface)]', (activeMenu === 'inbox' || activeMenu === 'sent' || activeMenu === 'unknown') && 'mobile-mail-shell')}>
          <Header activeMenu={activeMenu} setActiveMenu={setActiveMenu} query="" setQuery={() => undefined} refresh={refreshCurrent} apiBase={apiBase} locale={locale} />
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden pb-[calc(62px+env(safe-area-inset-bottom))] md:pb-0">
            <section className={cls('h-full min-h-0 min-w-0', activeMenu === 'dashboard' ? 'block' : 'hidden')} aria-hidden={activeMenu !== 'dashboard'}>
              <AccountDashboardView stats={stats} profile={profile} loading={busy === 'list'} locale={locale} refresh={refreshCurrent} setActiveMenu={setActiveMenu} />
            </section>
            <section className={cls('h-full min-h-0 min-w-0', activeMenu === 'stats' ? 'block' : 'hidden')} aria-hidden={activeMenu !== 'stats'}>
              <AccountStatsView stats={stats} locale={locale} refresh={refreshCurrent} loading={busy === 'list'} />
            </section>
            <section className={cls('h-full min-h-0 min-w-0', activeMenu === 'address' ? 'block' : 'hidden')} aria-hidden={activeMenu !== 'address'}>
              <AddressView
                request={request}
                notify={push}
                ask={ask}
                globalQuery=""
                accountUserToken={profile.userToken}
                accountUserEmail={profile.userEmail}
                accountUserRoleLabel={profile.roleLabel || profile.roleKey || (profile.isAdmin ? 'Admin' : t('普通用户', 'Member'))}
                accountDomains={domains}
                onAccountAddressRowsChange={syncAddressRows}
                onOpenInbox={openInboxByAddress}
              />
            </section>
            <section className={cls('h-full min-h-0 min-w-0', activeMenu === 'inbox' ? 'block' : 'hidden')} aria-hidden={activeMenu !== 'inbox'}>
              {renderMailSection('inbox')}
            </section>
            <section className={cls('h-full min-h-0 min-w-0', activeMenu === 'sent' ? 'block' : 'hidden')} aria-hidden={activeMenu !== 'sent'}>
              {renderMailSection('sent')}
            </section>
            <section className={cls('h-full min-h-0 min-w-0', activeMenu === 'unknown' ? 'block' : 'hidden')} aria-hidden={activeMenu !== 'unknown'}>
              {renderMailSection('unknown')}
            </section>
          </div>
          <MobileNav activeMenu={activeMenu} visualActiveMenu={activeMenu} setActiveMenu={setActiveMenu} locale={locale} allowedMenus={ACCOUNT_ALLOWED_MENUS} />
        </main>
      </div>
      {confirmModal}
      <NoticeToast notice={notice} />
    </div>
  );
}
