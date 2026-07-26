import type { ComponentType } from 'react';
import { PenLine, RefreshCw, Settings } from 'lucide-react';
import { cls } from '../lib/format';
import { getRuntimeLocale, localeText } from '../lib/locale';
import type { OpenSettings, Statistics } from '../types/api';
import type { MenuKey } from '../components/Shell';
import {
  AddressLogo,
  AnonymousLogo,
  ChartLogo,
  DeleteMailLogo,
  GateLogo,
  InboxLogo,
  LockLogo,
  SettingsLogo,
  StorageLogo,
  UserAdminLogo,
  WebhookLogo,
} from '../components/BrandIcons';

type DashboardIcon = ComponentType<{ className?: string; title?: string }>;
type CapabilityItem = { label: string; key: keyof OpenSettings; enabled: boolean };

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
  { menu: 'stats', icon: ChartLogo, titleZh: '统计分析', titleEn: 'Statistics' },
  { menu: 'settings', icon: SettingsLogo, titleZh: '系统设置', titleEn: 'Settings' },
];

function percentOf(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function formatMetric(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : '0';
}

function ActivityMeter({ label, value, total, muted = false }: { label: string; value: number; total: number; muted?: boolean }) {
  const percent = percentOf(value, total);
  return (
    <div className={cls('dash-meter', muted && 'is-muted')}>
      <div className="dash-meter-copy">
        <span className="dash-meter-label">{label}</span>
        <strong className="dash-meter-value">{percent}%</strong>
      </div>
      <div className="dash-meter-track" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
      <small className="dash-meter-note">{formatMetric(value)} / {formatMetric(total)}</small>
    </div>
  );
}

function ToneBar({ inbox, sent }: { inbox: number; sent: number }) {
  const total = inbox + sent;
  const inboxShare = percentOf(inbox, total);
  const sentShare = total > 0 ? 100 - inboxShare : 0;
  return (
    <div className="tone-bar" role="img" aria-label={`${inboxShare}% / ${sentShare}%`}>
      <span className="tone-ink" style={{ width: `${total > 0 ? inboxShare : 50}%` }} />
      <span className="tone-wax" style={{ width: `${total > 0 ? sentShare : 50}%` }} />
    </div>
  );
}

function TrafficSplit({ inbox, sent, inboxLabel, sentLabel }: { inbox: number; sent: number; inboxLabel: string; sentLabel: string }) {
  const total = inbox + sent;
  const inboxShare = percentOf(inbox, total);
  const sentShare = total > 0 ? 100 - inboxShare : 0;
  return (
    <dl className="dash-split">
      <div>
        <dt className="dash-split-label"><i className="tone-mark tone-ink" aria-hidden="true" />{inboxLabel}</dt>
        <dd className="dash-split-figures"><span className="dash-split-value">{formatMetric(inbox)}</span><span className="dash-split-share">{inboxShare}%</span></dd>
      </div>
      <div>
        <dt className="dash-split-label"><i className="tone-mark tone-wax" aria-hidden="true" />{sentLabel}</dt>
        <dd className="dash-split-figures"><span className="dash-split-value">{formatMetric(sent)}</span><span className="dash-split-share">{sentShare}%</span></dd>
      </div>
    </dl>
  );
}

function CapabilityCard({ items, title, enabledLabel, disabledLabel, metaText }: { items: CapabilityItem[]; title: string; enabledLabel: string; disabledLabel: string; metaText: string }) {
  return (
    <article className="paper-card dash-card-caps">
      <header className="card-head">
        <h2 className="card-title">{title}</h2>
        <span className="card-meta">{metaText}</span>
      </header>
      <div className="dash-caps-grid">
        {items.map(({ label, key, enabled }) => {
          const CapabilityIcon = capabilityIconMap[key] || SettingsLogo;
          return (
            <div className="cap-row" key={label}>
              <span className="cap-row-main">
                <CapabilityIcon className="cap-row-icon" />
                <span className="cap-row-label">{label}</span>
              </span>
              <span className={cls('cap-state', enabled && 'is-enabled')}>
                <i aria-hidden="true" />
                {enabled ? enabledLabel : disabledLabel}
              </span>
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function DashboardView({ stats, loading, openSettings, refresh, setActiveMenu }: { stats: Statistics; loading: boolean; openSettings: OpenSettings | null; refresh: () => void; setActiveMenu: (menu: MenuKey) => void }) {
  const locale = getRuntimeLocale();
  const t = (zh: string, en: string) => localeText(zh, en, locale);
  const capabilities = capabilityLabels.map(([zh, en, key]) => ({ label: t(zh, en), key, enabled: Boolean(openSettings?.[key]) }));
  const enabledCount = capabilities.filter((item) => item.enabled).length;
  const mailTotal = stats.mailCount + stats.sendMailCount;

  return (
    <div className="dashboard-view-shell admin-dashboard-view-shell h-full overflow-y-auto">
      <div className="product-page">
        <header className="page-head">
          <div className="page-head-copy">
            <span className="product-kicker">Loven7 Mail · {t('管理控制台', 'Admin console')}</span>
            <h1 className="page-title">{t('运营概览', 'Operations overview')}</h1>
            <p className="page-lede">{t('站点的邮件流量、地址活跃与能力状态，尽在一页。', 'Mail traffic, address activity and site capabilities at a glance.')}</p>
          </div>
          <div className="page-head-actions dashboard-page-actions">
            <button type="button" onClick={refresh} className="product-button product-button-quiet">
              <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} />
              {loading ? t('同步中', 'Syncing') : t('刷新', 'Refresh')}
            </button>
            <button type="button" onClick={() => setActiveMenu('settings')} className="product-button product-button-quiet">
              <Settings className="h-4 w-4" />
              {t('系统设置', 'Settings')}
            </button>
            <button type="button" onClick={() => setActiveMenu('compose')} className="product-button product-button-primary">
              <PenLine className="h-4 w-4" />
              {t('写邮件', 'Compose')}
            </button>
          </div>
        </header>

        <section className="dashboard-overview dash-metrics" aria-label={t('核心运营数据', 'Core operational data')}>
          <article className="paper-card dash-card-traffic">
            <header className="card-head">
              <h2 className="card-title">{t('邮件流量', 'Mail traffic')}</h2>
              <span className="card-chip">{t('当前累计', 'All time')}</span>
            </header>
            <div className="dash-figure-row">
              <strong className="dash-figure">{formatMetric(mailTotal)}</strong>
              <span className="dash-figure-unit">{t('封邮件', 'messages')}</span>
            </div>
            <ToneBar inbox={stats.mailCount} sent={stats.sendMailCount} />
            <TrafficSplit inbox={stats.mailCount} sent={stats.sendMailCount} inboxLabel={t('收件', 'Inbox')} sentLabel={t('发件', 'Sent')} />
          </article>

          <article className="paper-card dash-card-activity">
            <header className="card-head">
              <h2 className="card-title">{t('地址活跃', 'Address activity')}</h2>
              <span className="card-meta">{formatMetric(stats.addressCount)} {t('个地址', 'addresses')}</span>
            </header>
            <div className="dash-activity-meters">
              <ActivityMeter label={t('近 7 天活跃', 'Active last 7 days')} value={stats.activeAddressCount7days} total={stats.addressCount} />
              <ActivityMeter label={t('近 30 天活跃', 'Active last 30 days')} value={stats.activeAddressCount30days} total={stats.addressCount} muted />
            </div>
          </article>

          <article className="paper-card dash-card-scale">
            <header className="card-head">
              <h2 className="card-title">{t('站点规模', 'Site scale')}</h2>
            </header>
            <div className="dash-list">
              <div><span className="dash-list-label">{t('邮箱地址', 'Addresses')}</span><span className="dash-list-value">{formatMetric(stats.addressCount)}</span></div>
              <div><span className="dash-list-label">{t('注册用户', 'Users')}</span><span className="dash-list-value">{formatMetric(stats.userCount)}</span></div>
              <div><span className="dash-list-label">{t('已启用能力', 'Enabled capabilities')}</span><span className="dash-list-value">{enabledCount} / {capabilityLabels.length}</span></div>
            </div>
          </article>
        </section>

        <nav className="dash-quick" aria-label={t('快捷入口', 'Quick actions')}>
          <div className="dash-section-head">
            <h2>{t('快捷入口', 'Quick actions')}</h2>
            <small>{t('常用页面直达', 'Jump to frequent pages')}</small>
          </div>
          <div className="dash-quick-grid">
            {quickActions.map((action) => {
              const ActionIcon = action.icon;
              return (
                <button type="button" key={action.menu} onClick={() => setActiveMenu(action.menu)} className="dash-quick-card">
                  <ActionIcon className="dashboard-command-icon dash-quick-icon" />
                  <span>{t(action.titleZh, action.titleEn)}</span>
                </button>
              );
            })}
          </div>
        </nav>

        <CapabilityCard
          items={capabilities}
          title={t('站点能力', 'Site capabilities')}
          enabledLabel={t('已启用', 'Enabled')}
          disabledLabel={t('未启用', 'Off')}
          metaText={`${enabledCount} / ${capabilityLabels.length} ${t('已启用', 'enabled')}`}
        />
      </div>
    </div>
  );
}

export function StatsView({ stats, loading, openSettings, refresh }: { stats: Statistics; loading: boolean; openSettings: OpenSettings | null; refresh: () => void }) {
  const locale = getRuntimeLocale();
  const t = (zh: string, en: string) => localeText(zh, en, locale);
  const capabilities = capabilityLabels.map(([zh, en, key]) => ({ label: t(zh, en), key, enabled: Boolean(openSettings?.[key]) }));
  const enabledCount = capabilities.filter((item) => item.enabled).length;
  const mailTotal = stats.mailCount + stats.sendMailCount;
  const inboxShare = percentOf(stats.mailCount, mailTotal);
  const avgInboxPerAddress = stats.addressCount ? (stats.mailCount / stats.addressCount).toFixed(1) : '0.0';
  const activeLift = Math.max(0, stats.activeAddressCount30days - stats.activeAddressCount7days);

  return (
    <div className="stats-view-shell admin-stats-view-shell h-full min-h-0 overflow-y-auto">
      <div className="product-page">
        <header className="page-head stats-page-head">
          <div className="page-head-copy">
            <span className="product-kicker">{t('数据分析', 'Data analysis')}</span>
            <div className="stats-title-row">
              <h1 className="page-title">{t('统计', 'Statistics')}</h1>
              <button type="button" className="stats-mobile-refresh" onClick={refresh} aria-label={loading ? t('正在刷新统计', 'Refreshing statistics') : t('刷新统计', 'Refresh statistics')} title={t('刷新统计', 'Refresh statistics')}>
                <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} />
              </button>
            </div>
            <p className="page-lede">{t('邮件构成、地址活跃覆盖与运营指标明细。', 'Mail composition, address activity coverage and operational measures.')}</p>
          </div>
          <div className="page-head-actions stats-desktop-refresh">
            <button type="button" className="product-button product-button-quiet" onClick={refresh}>
              <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} />
              {loading ? t('同步中', 'Syncing') : t('刷新统计', 'Refresh')}
            </button>
          </div>
        </header>

        <section className="stats-analysis-lead stats-lead" aria-label={t('邮件与地址分析', 'Mail and address analysis')}>
          <article className="paper-card stats-card-total">
            <header className="card-head">
              <h2 className="card-title">{t('邮件总量', 'Total mail')}</h2>
              <span className="card-chip">{t('当前累计', 'All time')}</span>
            </header>
            <div className="dash-figure-row">
              <strong className="dash-figure">{formatMetric(mailTotal)}</strong>
              <span className="dash-figure-unit">{t('封邮件', 'messages')}</span>
            </div>
            <ToneBar inbox={stats.mailCount} sent={stats.sendMailCount} />
            <TrafficSplit inbox={stats.mailCount} sent={stats.sendMailCount} inboxLabel={t('收件', 'Inbox')} sentLabel={t('发件', 'Sent')} />
          </article>

          <article className="paper-card stats-card-activity">
            <header className="card-head">
              <h2 className="card-title">{t('地址活跃覆盖', 'Address activity')}</h2>
              <span className="card-meta">{formatMetric(stats.addressCount)} {t('个地址', 'addresses')}</span>
            </header>
            <div className="dash-activity-meters">
              <ActivityMeter label={t('近 7 天', 'Last 7 days')} value={stats.activeAddressCount7days} total={stats.addressCount} />
              <ActivityMeter label={t('近 30 天', 'Last 30 days')} value={stats.activeAddressCount30days} total={stats.addressCount} muted />
            </div>
          </article>
        </section>

        <section className="stats-detail">
          <article className="paper-card stats-card-measures">
            <header className="card-head">
              <h2 className="card-title">{t('运营指标', 'Operational measures')}</h2>
              <span className="card-meta">{t('当前累计', 'Current totals')}</span>
            </header>
            <div className="dash-list">
              <div><span className="dash-list-label">{t('地址总数', 'Addresses')}</span><span className="dash-list-value">{formatMetric(stats.addressCount)}</span></div>
              <div><span className="dash-list-label">{t('用户总数', 'Users')}</span><span className="dash-list-value">{formatMetric(stats.userCount)}</span></div>
              <div><span className="dash-list-label">{t('单地址平均收件', 'Inbox per address')}</span><span className="dash-list-value">{avgInboxPerAddress}</span></div>
              <div><span className="dash-list-label">{t('收件占比', 'Inbox share')}</span><span className="dash-list-value">{inboxShare}%</span></div>
              <div><span className="dash-list-label">{t('30 天新增活跃', 'Additional 30d active')}</span><span className="dash-list-value">{formatMetric(activeLift)}</span></div>
            </div>
          </article>

          <CapabilityCard
            items={capabilities}
            title={t('能力状态', 'Capability status')}
            enabledLabel={t('已启用', 'Enabled')}
            disabledLabel={t('未启用', 'Off')}
            metaText={`${enabledCount} / ${capabilityLabels.length} ${t('已启用', 'enabled')}`}
          />
        </section>
      </div>
    </div>
  );
}
