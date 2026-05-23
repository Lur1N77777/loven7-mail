import type { ComponentType } from 'react';
import { PenLine, RefreshCw, Settings } from 'lucide-react';
import { cls } from '../lib/format';
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
      <p className="text-sm text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-800 sm:text-3xl">{value}</p>
    </div>
  );
}

const capabilityLabels: Array<[string, keyof OpenSettings]> = [
  ['开放注册', 'enableUserCreateEmail'],
  ['匿名创建限制', 'disableAnonymousUserCreateEmail'],
  ['用户删除邮件', 'enableUserDeleteEmail'],
  ['Webhook', 'enableWebhook'],
  ['R2/S3 附件', 'isS3Enabled'],
  ['地址密码', 'enableAddressPassword'],
];

const capabilityIconMap: Partial<Record<keyof OpenSettings, DashboardIcon>> = {
  enableUserCreateEmail: GateLogo,
  disableAnonymousUserCreateEmail: AnonymousLogo,
  enableUserDeleteEmail: DeleteMailLogo,
  enableWebhook: WebhookLogo,
  isS3Enabled: StorageLogo,
  enableAddressPassword: LockLogo,
};

export function DashboardView({ stats, loading, openSettings, refresh, setActiveMenu }: { stats: Statistics; loading: boolean; openSettings: OpenSettings | null; refresh: () => void; setActiveMenu: (menu: MenuKey) => void }) {
  const capabilities = capabilityLabels.map(([label, key]) => ({ label, key, enabled: Boolean(openSettings?.[key]) }));

  return (
    <div className="h-full overflow-y-auto p-3 md:p-4 xl:p-6">
      <div className="space-y-4">
        <section className="dashboard-hero p-4 sm:rounded-[2rem] md:p-6">
          <div className="relative z-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div className="flex min-w-0 items-start gap-4">
              <div className="dashboard-hero-mark hidden shrink-0 sm:flex" aria-hidden="true"><HeroOrbitLogo className="dashboard-hero-logo" /></div>
              <div className="min-w-0">
              <p className="dashboard-hero-kicker text-sm">Cloudflare Temp Email Admin PWA</p>
              <h2 className="dashboard-hero-title mt-2 text-2xl font-bold tracking-tight sm:text-3xl md:text-4xl">临时邮箱后台已就绪</h2>
              <p className="dashboard-hero-copy mt-3 max-w-2xl text-sm leading-6">仪表盘用于快速判断系统是否正常、查看核心入口，并执行刷新、写邮件、进入设置等常用动作。</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <button onClick={refresh} className="dashboard-hero-ghost rounded-2xl px-4 py-3 text-sm font-medium transition"><RefreshCw className={cls('mr-2 inline h-4 w-4', loading && 'animate-spin')} />{loading ? '同步中' : '刷新'}</button>
              <button onClick={() => setActiveMenu('compose')} className="btn-primary rounded-2xl px-4 py-3 text-sm font-semibold"><PenLine className="mr-2 inline h-4 w-4" />写邮件</button>
              <button onClick={() => setActiveMenu('settings')} className="dashboard-hero-ghost rounded-2xl px-4 py-3 text-sm font-medium transition"><Settings className="mr-2 inline h-4 w-4" />系统设置</button>
            </div>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <StatCard icon={InboxLogo} label="收件总数" value={stats.mailCount} tone="mint" />
          <StatCard icon={SentLogo} label="发件总数" value={stats.sendMailCount} tone="lavender" />
          <StatCard icon={AddressLogo} label="地址数量" value={stats.addressCount} tone="sky" />
          <StatCard icon={UserAdminLogo} label="用户数量" value={stats.userCount} tone="soft" />
          <StatCard icon={ActivityLogo} label="7天活跃地址" value={stats.activeAddressCount7days} tone="peach" />
          <StatCard icon={TimeLogo} label="30天活跃地址" value={stats.activeAddressCount30days} tone="neutral" />
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
          <div className="panel p-4 sm:p-5">
            <h3 className="panel-title">快捷入口</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button onClick={() => setActiveMenu('address')} className="dashboard-quick-card rounded-2xl bg-slate-50 p-3 text-left transition hover:bg-slate-100"><span className="dashboard-quick-logo"><AddressLogo className="dashboard-logo-svg" /></span><p className="font-semibold text-slate-800">地址管理</p><p className="mt-1 text-sm text-slate-400">新建邮箱、查看 JWT、清理收发件。</p></button>
              <button onClick={() => setActiveMenu('inbox')} className="dashboard-quick-card rounded-2xl bg-slate-50 p-3 text-left transition hover:bg-slate-100"><span className="dashboard-quick-logo"><InboxLogo className="dashboard-logo-svg" /></span><p className="font-semibold text-slate-800">收件箱</p><p className="mt-1 text-sm text-slate-400">查看、解析和复制验证码。</p></button>
            </div>
          </div>
          <div className="panel p-4 sm:p-5">
            <h3 className="panel-title">站点能力</h3>
            <div className="mt-4 space-y-2.5">
              {capabilities.map(({ label, key, enabled }) => {
                const CapabilityIcon = capabilityIconMap[key] || SettingsLogo;
                return (
                  <div key={label} className="dashboard-capability-row flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2.5 text-sm">
                    <span className="flex min-w-0 items-center gap-2.5 text-slate-600"><span className="dashboard-capability-logo"><CapabilityIcon className="dashboard-logo-svg" /></span><span className="truncate">{label}</span></span>
                    <span className={cls('status-pill', enabled && 'enabled')}>{enabled ? '已启用' : '未启用'}</span>
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
  const total = Math.max(stats.mailCount + stats.sendMailCount + stats.addressCount + stats.userCount, 1);
  const bars: Array<[string, number, string, string]> = [
    ['收件', stats.mailCount, 'stat-bar-mint', '平台累计收到的邮件数量'],
    ['发件', stats.sendMailCount, 'stat-bar-lavender', '平台累计发送的邮件数量'],
    ['地址', stats.addressCount, 'stat-bar-sky', '已创建或绑定的邮箱地址'],
    ['用户', stats.userCount, 'stat-bar-peach', '系统用户数量'],
  ];
  const enabledCount = capabilityLabels.filter(([, key]) => Boolean(openSettings?.[key])).length;

  return (
    <div className="stats-view-shell h-full min-h-0 overflow-y-auto p-3 md:p-4 xl:p-6">
      <div className="mb-4 flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div><h2 className="text-2xl font-bold text-slate-800">统计</h2><p className="mt-1 text-sm text-slate-400">统计页专注指标占比、活跃度和站点能力状态；仪表盘更偏运营总览与快捷操作。</p></div>
        <button className="btn-secondary" onClick={refresh}><RefreshCw size={16} className={cls(loading && 'animate-spin')} /> {loading ? '同步中' : '刷新统计'}</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={InboxLogo} label="收件总数" value={stats.mailCount} tone="mint" />
        <StatCard icon={SentLogo} label="发件总数" value={stats.sendMailCount} tone="lavender" />
        <StatCard icon={ActivityLogo} label="7天活跃地址" value={stats.activeAddressCount7days} tone="peach" />
        <StatCard icon={SettingsLogo} label="已启用能力" value={`${enabledCount}/${capabilityLabels.length}`} tone="sky" />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="panel p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between"><div><h3 className="panel-title">运行占比</h3><p className="panel-subtitle">按当前统计接口返回值计算。</p></div><span className="dashboard-quick-logo"><ChartLogo className="dashboard-logo-svg" /></span></div>
          {bars.map(([label, value, color, desc]) => (
            <div className="mb-4" key={label}>
              <div className="mb-2 flex justify-between gap-4 text-sm"><span className="text-slate-500">{label}<em className="ml-2 not-italic text-xs text-slate-400">{desc}</em></span><span className="font-medium text-slate-700">{value}</span></div>
              <div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className={cls('h-full rounded-full transition-all', color)} style={{ width: `${Math.max(4, (value / total) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="panel p-4 sm:p-5">
          <h3 className="panel-title">活跃度</h3>
          <div className="mt-4 space-y-3">
            <div className="rounded-2xl bg-slate-50 p-3"><p className="text-sm text-slate-400">7 天 / 总地址</p><p className="mt-2 text-2xl font-bold text-slate-800">{stats.addressCount ? `${Math.round((stats.activeAddressCount7days / stats.addressCount) * 100)}%` : '0%'}</p></div>
            <div className="rounded-2xl bg-slate-50 p-3"><p className="text-sm text-slate-400">30 天 / 总地址</p><p className="mt-2 text-2xl font-bold text-slate-800">{stats.addressCount ? `${Math.round((stats.activeAddressCount30days / stats.addressCount) * 100)}%` : '0%'}</p></div>
          </div>
        </div>
      </div>
    </div>
  );
}


