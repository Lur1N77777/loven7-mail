import type { ComponentType } from 'react';
import { PenLine, RefreshCw, Settings } from 'lucide-react';
import { cls } from '../lib/format';
import { getRuntimeLocale, localeText } from '../lib/locale';
import type { OpenSettings, Statistics } from '../types/api';
import type { MenuKey } from '../components/Shell';
import {
  ActivityLogo,
  AddressLogo,
  AnonymousLogo,
  ChartLogo,
  DeleteMailLogo,
  GateLogo,
  HeroOrbitLogo,
  InboxLogo,
  LockLogo,
  SentLogo,
  SettingsLogo,
  StorageLogo,
  TimeLogo,
  UserAdminLogo,
  WebhookLogo,
} from '../components/BrandIcons';

type Tone = 'mint' | 'lavender' | 'sky' | 'peach' | 'soft' | 'neutral';
type DashboardIcon = ComponentType<{ className?: string; title?: string }>;

function StatCard({ icon: Icon, label, value, tone = 'neutral' }: { icon: DashboardIcon; label: string; value: number | string; tone?: Tone }) {
  const toneMap: Record<Tone, string> = {
    mint: 'dashboard-logo-inbox',
    lavender: 'dashboard-logo-sent',
    sky: 'dashboard-logo-address',
    peach: 'dashboard-logo-activity',
    soft: 'dashboard-logo-user',
    neutral: 'dashboard-logo-neutral',
  };
  return (
    <div className="dashboard-stat-card rounded-3xl border border-slate-100 bg-white p-3 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md sm:p-4">
      <div className={cls('dashboard-logo-frame mb-3 sm:mb-4', toneMap[tone])}><Icon className="dashboard-logo-svg" /></div>
      <p className="dashboard-stat-label text-sm text-slate-400">{label}</p>
      <p className="dashboard-stat-value mt-2 text-2xl font-bold tracking-tight text-slate-800 sm:text-3xl">{value}</p>
    </div>
  );
}

const capabilityLabels: Array<[string, string, keyof OpenSettings]> = [
  ['开放注册', 'Open registration', 'enableUserCreateEmail'],
  ['匿名创建限制', 'Anonymous creation limit', 'disableAnonymousUserCreateEmail'],
  ['用户删除邮件', 'User mail deletion', 'enableUserDeleteEmail'],
  ['Webhook', 'Webhook', 'enableWebhook'],
  ['R2/S3 附件', 'R2/S3 attachments', 'isS3Enabled'],
  ['地址密码', 'Address password', 'enableAddressPassword'],
];

const capabilityIconMap: Partial<Record<keyof OpenSettings, DashboardIcon>> = {
  enableUserCreateEmail: GateLogo,
  disableAnonymousUserCreateEmail: AnonymousLogo,
  enableUserDeleteEmail: DeleteMailLogo,
  enableWebhook: WebhookLogo,
  isS3Enabled: StorageLogo,
  enableAddressPassword: LockLogo,
};

const quickActions: Array<{
  menu: MenuKey;
  icon: DashboardIcon;
  titleZh: string;
  titleEn: string;
  descZh: string;
  descEn: string;
}> = [
  { menu: 'address', icon: AddressLogo, titleZh: '地址管理', titleEn: 'Addresses', descZh: '新建邮箱、筛选用户、批量管理。', descEn: 'Create, filter, and manage mailboxes.' },
  { menu: 'inbox', icon: InboxLogo, titleZh: '收件箱', titleEn: 'Inbox', descZh: '查看邮件、验证码与附件。', descEn: 'Review mail, codes, and attachments.' },
  { menu: 'users', icon: UserAdminLogo, titleZh: '用户管理', titleEn: 'Users', descZh: '管理用户、角色与绑定地址。', descEn: 'Manage users, roles, and bindings.' },
  { menu: 'compose', icon: PenLine, titleZh: '写邮件', titleEn: 'Compose', descZh: '快速进入发信工作台。', descEn: 'Open the compose workspace.' },
  { menu: 'stats', icon: ChartLogo, titleZh: '统计分析', titleEn: 'Stats', descZh: '查看占比、活跃度和能力状态。', descEn: 'Track mix, activity, and capability state.' },
  { menu: 'settings', icon: SettingsLogo, titleZh: '系统设置', titleEn: 'Settings', descZh: '配置站点、用户与自动刷新。', descEn: 'Tune site, user, and refresh settings.' },
];

export function DashboardView({ stats, loading, openSettings, refresh, setActiveMenu }: { stats: Statistics; loading: boolean; openSettings: OpenSettings | null; refresh: () => void; setActiveMenu: (menu: MenuKey) => void }) {
  const locale = getRuntimeLocale();
  const t = (zh: string, en: string) => localeText(zh, en, locale);
  const capabilities = capabilityLabels.map(([zh, en, key]) => ({ label: t(zh, en), key, enabled: Boolean(openSettings?.[key]) }));

  return (
    <div className="dashboard-view-shell dashboard-view-typography h-full overflow-y-auto p-3 md:p-4 xl:p-6">
      <div className="space-y-4">
        <section className="dashboard-hero p-4 sm:rounded-[2rem] md:p-6">
          <div className="relative z-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div className="flex min-w-0 items-start gap-4">
              <div className="dashboard-hero-mark hidden shrink-0 sm:flex" aria-hidden="true"><HeroOrbitLogo className="dashboard-hero-logo" /></div>
              <div className="min-w-0">
              <p className="dashboard-hero-kicker text-sm">Cloudflare Temp Email Admin PWA</p>
              <h2 className="dashboard-hero-title mt-2 text-2xl font-bold tracking-tight sm:text-3xl md:text-4xl">{t('临时邮箱后台已就绪', 'Temp mail admin is ready')}</h2>
              <p className="dashboard-hero-copy mt-3 max-w-2xl text-sm leading-6">{t('仪表盘用于快速判断系统是否正常、查看核心入口，并执行刷新、写邮件、进入设置等常用动作。', 'Use the dashboard to check system health, jump to key areas, refresh data, compose mail, and open settings quickly.')}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <button onClick={refresh} className="dashboard-hero-ghost rounded-2xl px-4 py-3 text-sm font-medium transition"><RefreshCw className={cls('mr-2 inline h-4 w-4', loading && 'animate-spin')} />{loading ? t('同步中', 'Syncing') : t('刷新', 'Refresh')}</button>
              <button onClick={() => setActiveMenu('compose')} className="btn-primary rounded-2xl px-4 py-3 text-sm font-semibold"><PenLine className="mr-2 inline h-4 w-4" />{t('写邮件', 'Compose')}</button>
              <button onClick={() => setActiveMenu('settings')} className="dashboard-hero-ghost rounded-2xl px-4 py-3 text-sm font-medium transition"><Settings className="mr-2 inline h-4 w-4" />{t('系统设置', 'Settings')}</button>
            </div>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <StatCard icon={InboxLogo} label={t('收件总数', 'Inbox total')} value={stats.mailCount} tone="mint" />
          <StatCard icon={SentLogo} label={t('发件总数', 'Sent total')} value={stats.sendMailCount} tone="lavender" />
          <StatCard icon={AddressLogo} label={t('地址数量', 'Addresses')} value={stats.addressCount} tone="sky" />
          <StatCard icon={UserAdminLogo} label={t('用户数量', 'Users')} value={stats.userCount} tone="soft" />
          <StatCard icon={ActivityLogo} label={t('7天活跃地址', 'Active addresses 7d')} value={stats.activeAddressCount7days} tone="peach" />
          <StatCard icon={TimeLogo} label={t('30天活跃地址', 'Active addresses 30d')} value={stats.activeAddressCount30days} tone="neutral" />
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
          <div className="panel dashboard-quick-panel p-4 sm:p-5">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h3 className="panel-title">{t('快捷入口', 'Quick actions')}</h3>
                <p className="panel-subtitle mt-1">{t('常用入口保持 6 项，地址、邮件、用户、统计与设置集中展示。', 'Six common actions keep addresses, mail, users, stats, and settings grouped cleanly.')}</p>
              </div>
              <span className="dashboard-quick-count">{quickActions.length}</span>
            </div>
            <div className="dashboard-quick-grid mt-4 grid gap-3">
              {quickActions.map((action) => {
                const QuickIcon = action.icon;
                return (
                  <button key={action.menu} onClick={() => setActiveMenu(action.menu)} className="dashboard-quick-card rounded-2xl bg-slate-50 p-3 text-left transition hover:bg-slate-100">
                    <span className="dashboard-quick-logo"><QuickIcon className="dashboard-logo-svg" /></span>
                    <p className="dashboard-quick-title font-semibold text-slate-800">{t(action.titleZh, action.titleEn)}</p>
                    <p className="dashboard-quick-desc mt-1 text-sm text-slate-400">{t(action.descZh, action.descEn)}</p>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="panel p-4 sm:p-5">
            <h3 className="panel-title">{t('站点能力', 'Site capabilities')}</h3>
            <div className="mt-4 space-y-2.5">
              {capabilities.map(({ label, key, enabled }) => {
                const CapabilityIcon = capabilityIconMap[key] || SettingsLogo;
                return (
                  <div key={label} className="dashboard-capability-row flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2.5 text-sm">
                    <span className="flex min-w-0 items-center gap-2.5 text-slate-600"><span className="dashboard-capability-logo"><CapabilityIcon className="dashboard-logo-svg" /></span><span className="truncate">{label}</span></span>
                    <span className={cls('status-pill', enabled && 'enabled')}>{enabled ? t('已启用', 'Enabled') : t('未启用', 'Disabled')}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export function StatsView({ stats, loading, openSettings, refresh }: { stats: Statistics; loading: boolean; openSettings: OpenSettings | null; refresh: () => void }) {
  const locale = getRuntimeLocale();
  const t = (zh: string, en: string) => localeText(zh, en, locale);
  const total = Math.max(stats.mailCount + stats.sendMailCount + stats.addressCount + stats.userCount, 1);
  const bars: Array<[string, number, string, string]> = [
    [t('收件', 'Inbox'), stats.mailCount, 'stat-bar-mint', t('平台累计收到的邮件数量', 'Total received messages')],
    [t('发件', 'Sent'), stats.sendMailCount, 'stat-bar-lavender', t('平台累计发送的邮件数量', 'Total sent messages')],
    [t('地址', 'Addresses'), stats.addressCount, 'stat-bar-sky', t('已创建或绑定的邮箱地址', 'Created or bound mailbox addresses')],
    [t('用户', 'Users'), stats.userCount, 'stat-bar-peach', t('系统用户数量', 'System users')],
  ];
  const enabledCount = capabilityLabels.filter(([, , key]) => Boolean(openSettings?.[key])).length;

  return (
    <div className="stats-view-shell dashboard-view-typography h-full min-h-0 overflow-y-auto p-3 md:p-4 xl:p-6">
      <div className="mb-4 flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div><h2 className="page-title">{t('统计', 'Stats')}</h2><p className="page-subtitle mt-1">{t('统计页专注指标占比、活跃度和站点能力状态；仪表盘更偏运营总览与快捷操作。', 'Stats focuses on ratios, activity, and capability status; the dashboard is for operational overview and quick actions.')}</p></div>
        <button className="btn-secondary" onClick={refresh}><RefreshCw size={16} className={cls(loading && 'animate-spin')} /> {loading ? t('同步中', 'Syncing') : t('刷新统计', 'Refresh stats')}</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={InboxLogo} label={t('收件总数', 'Inbox total')} value={stats.mailCount} tone="mint" />
        <StatCard icon={SentLogo} label={t('发件总数', 'Sent total')} value={stats.sendMailCount} tone="lavender" />
        <StatCard icon={ActivityLogo} label={t('7天活跃地址', 'Active addresses 7d')} value={stats.activeAddressCount7days} tone="peach" />
        <StatCard icon={SettingsLogo} label={t('已启用能力', 'Enabled capabilities')} value={`${enabledCount}/${capabilityLabels.length}`} tone="sky" />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="panel p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between"><div><h3 className="panel-title">{t('运行占比', 'Operational mix')}</h3><p className="panel-subtitle">{t('按当前统计接口返回值计算。', 'Calculated from the current statistics API response.')}</p></div><span className="dashboard-quick-logo"><ChartLogo className="dashboard-logo-svg" /></span></div>
          {bars.map(([label, value, color, desc]) => (
            <div className="mb-4" key={label}>
              <div className="stats-ratio-row mb-2 flex justify-between gap-4 text-sm"><span className="stats-ratio-label text-slate-500">{label}<em className="stats-ratio-desc ml-2 not-italic text-xs text-slate-400">{desc}</em></span><span className="stats-ratio-value font-medium text-slate-700">{value}</span></div>
              <div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className={cls('h-full rounded-full transition-all', color)} style={{ width: `${Math.max(4, (value / total) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="panel p-4 sm:p-5">
          <h3 className="panel-title">{t('活跃度', 'Activity')}</h3>
          <div className="mt-4 space-y-3">
            <div className="stats-activity-card rounded-2xl bg-slate-50 p-3"><p className="stats-activity-label text-sm text-slate-400">{t('7 天 / 总地址', '7d / total addresses')}</p><p className="stats-activity-value mt-2 text-2xl font-bold text-slate-800">{stats.addressCount ? `${Math.round((stats.activeAddressCount7days / stats.addressCount) * 100)}%` : '0%'}</p></div>
            <div className="stats-activity-card rounded-2xl bg-slate-50 p-3"><p className="stats-activity-label text-sm text-slate-400">{t('30 天 / 总地址', '30d / total addresses')}</p><p className="stats-activity-value mt-2 text-2xl font-bold text-slate-800">{stats.addressCount ? `${Math.round((stats.activeAddressCount30days / stats.addressCount) * 100)}%` : '0%'}</p></div>
          </div>
        </div>
      </div>
    </div>
  );
}


