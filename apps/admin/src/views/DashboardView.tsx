import type { ComponentType, CSSProperties } from 'react';
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
  InboxLogo,
  LockLogo,
  LovenMailMark,
  SentLogo,
  SettingsLogo,
  StorageLogo,
  TimeLogo,
  UserAdminLogo,
  WebhookLogo,
} from '../components/BrandIcons';

type Tone = 'mint' | 'lavender' | 'sky' | 'peach' | 'soft' | 'neutral';
type DashboardIcon = ComponentType<{ className?: string; title?: string }>;
type RatioItem = { label: string; value: number; color: string };
type CapabilityItem = { label: string; key: keyof OpenSettings; enabled: boolean };

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
}> = [
  { menu: 'address', icon: AddressLogo, titleZh: '地址管理', titleEn: 'Addresses' },
  { menu: 'inbox', icon: InboxLogo, titleZh: '收件箱', titleEn: 'Inbox' },
  { menu: 'users', icon: UserAdminLogo, titleZh: '用户管理', titleEn: 'Users' },
  { menu: 'compose', icon: PenLine, titleZh: '写邮件', titleEn: 'Compose' },
  { menu: 'stats', icon: ChartLogo, titleZh: '统计分析', titleEn: 'Stats' },
  { menu: 'settings', icon: SettingsLogo, titleZh: '系统设置', titleEn: 'Settings' },
];

function percentOf(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function ratioWidth(value: number, total: number): string {
  if (!Number.isFinite(value) || value <= 0 || total <= 0) return '0%';
  return `${Math.max(5, Math.min(100, (value / total) * 100))}%`;
}

function formatMetric(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : '0';
}

function MixPanel({ title, items }: { title: string; items: RatioItem[] }) {
  const total = Math.max(items.reduce((sum, item) => sum + Math.max(0, item.value), 0), 1);
  return (
    <div className="panel dashboard-visual-panel p-4 sm:p-5">
      <div className="dashboard-panel-heading">
        <div>
          <h3 className="panel-title">{title}</h3>
        </div>
        <span className="dashboard-quick-logo"><ChartLogo className="dashboard-logo-svg" /></span>
      </div>
      <div className="dashboard-segment-bar mt-4" aria-hidden="true">
        {items.map((item) => <span key={item.label} className={item.color} style={{ width: ratioWidth(item.value, total) }} />)}
      </div>
      <div className="dashboard-ratio-list mt-4">
        {items.map((item) => (
          <div className="dashboard-ratio-item" key={item.label}>
            <span className={cls('dashboard-ratio-dot', item.color)} />
            <span className="dashboard-ratio-main">
              <strong>{item.label}</strong>
            </span>
            <span className="dashboard-ratio-number">{formatMetric(item.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityGauge({ label, value, total }: { label: string; value: number; total: number }) {
  const percent = percentOf(value, total);
  return (
    <div className="dashboard-gauge-row">
      <div className="dashboard-gauge" style={{ '--gauge-value': `${percent}%` } as CSSProperties}>
        <span>{percent}%</span>
      </div>
      <div className="min-w-0">
        <strong>{label}</strong>
        <small>{formatMetric(value)} / {formatMetric(total)}</small>
      </div>
    </div>
  );
}

function CapabilityMatrix({ items }: { items: CapabilityItem[] }) {
  return (
    <div className="dashboard-capability-matrix">
      {items.map(({ label, key, enabled }) => {
        const CapabilityIcon = capabilityIconMap[key] || SettingsLogo;
        return (
          <div key={label} className={cls('dashboard-capability-cell', enabled && 'enabled')}>
            <span className="dashboard-capability-logo"><CapabilityIcon className="dashboard-logo-svg" /></span>
            <span className="truncate">{label}</span>
            <i aria-hidden="true" />
          </div>
        );
      })}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="dashboard-summary-row">
      <span>
        <strong>{label}</strong>
      </span>
      <b>{value}</b>
    </div>
  );
}

export function DashboardView({ stats, loading, openSettings, refresh, setActiveMenu }: { stats: Statistics; loading: boolean; openSettings: OpenSettings | null; refresh: () => void; setActiveMenu: (menu: MenuKey) => void }) {
  const locale = getRuntimeLocale();
  const t = (zh: string, en: string) => localeText(zh, en, locale);
  const capabilities = capabilityLabels.map(([zh, en, key]) => ({ label: t(zh, en), key, enabled: Boolean(openSettings?.[key]) }));
  const enabledCount = capabilities.filter((item) => item.enabled).length;
  const mailTrafficTotal = Math.max(stats.mailCount + stats.sendMailCount, 1);
  const operationalTotal = Math.max(stats.mailCount + stats.sendMailCount + stats.addressCount + stats.userCount, 1);
  const mixItems: RatioItem[] = [
    { label: t('收件', 'Inbox'), value: stats.mailCount, color: 'stat-bar-mint' },
    { label: t('发件', 'Sent'), value: stats.sendMailCount, color: 'stat-bar-lavender' },
    { label: t('地址', 'Addresses'), value: stats.addressCount, color: 'stat-bar-sky' },
    { label: t('用户', 'Users'), value: stats.userCount, color: 'stat-bar-peach' },
  ];
  const nextActions = [
    {
      menu: 'inbox' as const,
      icon: InboxLogo,
      title: t('查看最新收件', 'Review latest inbox'),
    },
    {
      menu: 'address' as const,
      icon: AddressLogo,
      title: t('管理邮箱地址', 'Manage mailboxes'),
    },
    {
      menu: enabledCount < capabilityLabels.length ? 'settings' as const : 'stats' as const,
      icon: enabledCount < capabilityLabels.length ? SettingsLogo : ChartLogo,
      title: enabledCount < capabilityLabels.length ? t('补齐能力配置', 'Complete capabilities') : t('查看完整统计', 'Open full stats'),
    },
  ];

  return (
    <div className="dashboard-view-shell dashboard-view-typography h-full overflow-y-auto p-3 md:p-4 xl:p-6">
      <div className="space-y-4">
        <section className="dashboard-hero p-4 sm:rounded-[2rem] md:p-6">
          <div className="relative z-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div className="dashboard-brand-lockup flex min-w-0 items-start gap-4">
              <div className="dashboard-hero-mark shrink-0" aria-hidden="true"><LovenMailMark className="dashboard-hero-logo" /></div>
              <div className="min-w-0">
                <p className="dashboard-hero-kicker text-sm">{t('官方邮箱后台', 'Official mail console')}</p>
                <h2 className="dashboard-hero-title dashboard-brand-title mt-1 text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">Loven7 Mail</h2>
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
              </div>
              <span className="dashboard-quick-count">{quickActions.length}</span>
            </div>
            <div className="dashboard-quick-grid mt-4 grid gap-3">
              {quickActions.map((action) => {
                const QuickIcon = action.icon;
                return (
                  <button key={action.menu} onClick={() => setActiveMenu(action.menu)} className="dashboard-quick-card text-left transition">
                    <span className="dashboard-quick-logo"><QuickIcon className="dashboard-logo-svg" /></span>
                    <p className="dashboard-quick-title font-semibold text-slate-800">{t(action.titleZh, action.titleEn)}</p>
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
                  <div key={label} className="dashboard-capability-row flex items-center justify-between px-3 py-2.5 text-sm">
                    <span className="flex min-w-0 items-center gap-2.5 text-slate-600"><span className="dashboard-capability-logo"><CapabilityIcon className="dashboard-logo-svg" /></span><span className="truncate">{label}</span></span>
                    <span className={cls('status-pill', enabled && 'enabled')}>{enabled ? t('已启用', 'Enabled') : t('未启用', 'Disabled')}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="dashboard-console-grid grid gap-4 xl:grid-cols-[1.12fr_.88fr]">
          <MixPanel title={t('邮件流量构成', 'Mail traffic mix')} items={mixItems} />
          <div className="panel dashboard-visual-panel p-4 sm:p-5">
            <div className="dashboard-panel-heading">
              <div>
                <h3 className="panel-title">{t('地址活跃仪表', 'Address activity')}</h3>
              </div>
              <span className="dashboard-quick-logo"><ActivityLogo className="dashboard-logo-svg" /></span>
            </div>
            <div className="dashboard-gauge-list mt-4">
              <ActivityGauge label={t('7 天活跃', '7d active')} value={stats.activeAddressCount7days} total={stats.addressCount} />
              <ActivityGauge label={t('30 天活跃', '30d active')} value={stats.activeAddressCount30days} total={stats.addressCount} />
            </div>
          </div>
        </section>

        <section className="dashboard-console-grid grid gap-4 xl:grid-cols-[.92fr_1.08fr]">
          <div className="panel dashboard-visual-panel p-4 sm:p-5">
            <div className="dashboard-panel-heading">
              <div>
                <h3 className="panel-title">{t('能力覆盖', 'Capability coverage')}</h3>
              </div>
              <span className="dashboard-coverage-score">{enabledCount}/{capabilityLabels.length}</span>
            </div>
            <div className="dashboard-coverage-track mt-4"><span style={{ width: `${percentOf(enabledCount, capabilityLabels.length)}%` }} /></div>
            <CapabilityMatrix items={capabilities} />
          </div>
          <div className="panel dashboard-visual-panel p-4 sm:p-5">
            <div className="dashboard-panel-heading">
              <div>
                <h3 className="panel-title">{t('下一步操作', 'Next actions')}</h3>
              </div>
              <span className="dashboard-quick-logo"><TimeLogo className="dashboard-logo-svg" /></span>
            </div>
            <div className="dashboard-action-list mt-4">
              {nextActions.map((action) => {
                const ActionIcon = action.icon;
                return (
                  <button key={action.title} type="button" className="dashboard-action-row" onClick={() => setActiveMenu(action.menu)}>
                    <span className="dashboard-capability-logo"><ActionIcon className="dashboard-logo-svg" /></span>
                    <span>
                      <strong>{action.title}</strong>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="dashboard-mini-summary mt-4">
              <SummaryRow label={t('收发比', 'Inbox / sent')} value={`${percentOf(stats.mailCount, mailTrafficTotal)}%`} />
              <SummaryRow label={t('能力完成度', 'Capability coverage')} value={`${percentOf(enabledCount, capabilityLabels.length)}%`} />
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
  const bars: Array<[string, number, string]> = [
    [t('收件', 'Inbox'), stats.mailCount, 'stat-bar-mint'],
    [t('发件', 'Sent'), stats.sendMailCount, 'stat-bar-lavender'],
    [t('地址', 'Addresses'), stats.addressCount, 'stat-bar-sky'],
    [t('用户', 'Users'), stats.userCount, 'stat-bar-peach'],
  ];
  const capabilities = capabilityLabels.map(([zh, en, key]) => ({ label: t(zh, en), key, enabled: Boolean(openSettings?.[key]) }));
  const enabledCount = capabilities.filter((item) => item.enabled).length;
  const avgInboxPerAddress = stats.addressCount ? (stats.mailCount / stats.addressCount).toFixed(1) : '0.0';
  const activeLift = Math.max(0, stats.activeAddressCount30days - stats.activeAddressCount7days);
  const capabilityRate = percentOf(enabledCount, capabilityLabels.length);

  return (
    <div className="stats-view-shell dashboard-view-typography h-full min-h-0 overflow-y-auto p-3 md:p-4 xl:p-6">
      <div className="mb-4 flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div><h2 className="page-title">{t('统计', 'Stats')}</h2></div>
        <button className="btn-secondary" onClick={refresh}><RefreshCw size={16} className={cls(loading && 'animate-spin')} /> {loading ? t('同步中', 'Syncing') : t('刷新统计', 'Refresh stats')}</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={InboxLogo} label={t('收件总数', 'Inbox total')} value={stats.mailCount} tone="mint" />
        <StatCard icon={SentLogo} label={t('发件总数', 'Sent total')} value={stats.sendMailCount} tone="lavender" />
        <StatCard icon={ActivityLogo} label={t('7天活跃地址', 'Active addresses 7d')} value={stats.activeAddressCount7days} tone="peach" />
        <StatCard icon={SettingsLogo} label={t('已启用能力', 'Enabled capabilities')} value={`${enabledCount}/${capabilityLabels.length}`} tone="sky" />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="panel dashboard-visual-panel p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between"><div><h3 className="panel-title">{t('运行占比', 'Operational mix')}</h3></div><span className="dashboard-quick-logo"><ChartLogo className="dashboard-logo-svg" /></span></div>
          {bars.map(([label, value, color]) => (
            <div className="mb-4" key={label}>
              <div className="stats-ratio-row mb-2 flex justify-between gap-4 text-sm"><span className="stats-ratio-label text-slate-500">{label}</span><span className="stats-ratio-value font-medium text-slate-700">{value}</span></div>
              <div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className={cls('h-full rounded-full transition-all', color)} style={{ width: `${Math.max(4, (value / total) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="panel dashboard-visual-panel p-4 sm:p-5">
          <div className="dashboard-panel-heading">
            <div>
              <h3 className="panel-title">{t('活跃度', 'Activity')}</h3>
            </div>
            <span className="dashboard-quick-logo"><ActivityLogo className="dashboard-logo-svg" /></span>
          </div>
          <div className="dashboard-gauge-list mt-4">
            <ActivityGauge label={t('7 天 / 总地址', '7d / total addresses')} value={stats.activeAddressCount7days} total={stats.addressCount} />
            <ActivityGauge label={t('30 天 / 总地址', '30d / total addresses')} value={stats.activeAddressCount30days} total={stats.addressCount} />
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1fr]">
        <div className="panel dashboard-visual-panel p-4 sm:p-5">
          <div className="dashboard-panel-heading">
            <div>
              <h3 className="panel-title">{t('能力矩阵', 'Capability matrix')}</h3>
            </div>
            <span className="dashboard-coverage-score">{enabledCount}/{capabilityLabels.length}</span>
          </div>
          <div className="dashboard-coverage-track mt-4"><span style={{ width: `${capabilityRate}%` }} /></div>
          <CapabilityMatrix items={capabilities} />
        </div>
        <div className="panel dashboard-visual-panel p-4 sm:p-5">
          <div className="dashboard-panel-heading">
            <div>
              <h3 className="panel-title">{t('运营摘要', 'Operational summary')}</h3>
            </div>
            <span className="dashboard-quick-logo"><TimeLogo className="dashboard-logo-svg" /></span>
          </div>
          <div className="dashboard-mini-summary mt-4">
            <SummaryRow label={t('单地址平均收件', 'Inbox per address')} value={avgInboxPerAddress} />
            <SummaryRow label={t('30 天新增活跃覆盖', '30d extra active')} value={formatMetric(activeLift)} />
            <SummaryRow label={t('能力完成度', 'Capability coverage')} value={`${capabilityRate}%`} />
          </div>
        </div>
      </div>
    </div>
  );
}


