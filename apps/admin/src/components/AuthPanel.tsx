import { useState, type ComponentType } from 'react';
import { LogOut } from 'lucide-react';
import type { Requester } from '../lib/api';
import { decodeJwtPayload } from '../lib/crypto';
import { getRuntimeLocale, localeText, type AppLocale } from '../lib/locale';
import { normalizeAuthApiBase } from '../lib/storage';
import { AddressLogo, GateLogo, LockLogo, UserAdminLogo, WebhookLogo } from './BrandIcons';
import { Modal, type Notify } from './Common';

function getApiHostLabel(apiBase: string, locale: AppLocale = 'zh-CN') {
  const normalized = normalizeAuthApiBase(apiBase);
  if (!normalized) return localeText('同源 Worker', 'Same-origin Worker', locale);
  try {
    return new URL(normalized).hostname || normalized;
  } catch {
    return normalized.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
}

type DecodedAccessToken = {
  userEmail: string;
  userId: number;
  username: string;
  isAdmin: boolean;
  roleLabel: string;
};

function decodeAccessToken(token: string): DecodedAccessToken | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const record = payload as Record<string, unknown>;
  const userRole = (record.user_role || record.userRole) as Record<string, unknown> | undefined;
  const roleValue = String(record.role_key || record.roleKey || record.role || record.role_text || record.roleText || userRole?.role || userRole?.role_text || userRole?.roleText || userRole?.label || '').trim().toLowerCase();
  const isAdminRole = roleValue === 'admin' || roleValue === 'administrator' || roleValue === '管理员';
  return {
    userEmail: String(record.user_email || record.userEmail || record.email || ''),
    userId: Number(record.user_id || record.userId || 0),
    username: String(record.username || record.user_name || record.userName || record.name || record.preferred_username || record.preferredUsername || ''),
    isAdmin: Boolean(record.is_admin || record.isAdmin) || isAdminRole,
    roleLabel: String(userRole?.label || userRole?.role || record.roleLabel || roleValue || ''),
  };
}

export function CredentialButton({ onClick, label }: { onClick: () => void; label?: string }) {
  const locale = getRuntimeLocale();
  return (
    <button type="button" onClick={onClick} className="sidebar-mini-btn credential-button" aria-label={label || localeText('凭据设置', 'Credential settings', locale)}>
      <GateLogo className="credential-button-logo" />
      <span className="credential-button-label">{label || localeText('凭据', 'Auth', locale)}</span>
    </button>
  );
}

type AccountInfoIcon = ComponentType<{ className?: string; title?: string }>;

function AccountInfoRow({ icon: Icon, tone, label, value }: {
  icon: AccountInfoIcon;
  tone: 'connection' | 'auth' | 'role' | 'account';
  label: string;
  value: string;
}) {
  return (
    <div className="account-info-row">
      <span className={`account-info-logo-wrap account-info-logo-${tone}`} aria-hidden="true">
        <Icon className="account-info-logo" />
      </span>
      <div className="min-w-0">
        <p className="account-info-label">{label}</p>
        <p className="account-info-value">{value}</p>
      </div>
    </div>
  );
}

export function AuthPanel({ apiBase, adminPassword, userAccessToken, adminRoleConfirmed = false, initialOpen: requestedInitialOpen, canForgetBrowser = false, onForgetBrowser }: {
  apiBase: string;
  setApiBase: (value: string) => void;
  adminPassword: string;
  setAdminPassword: (value: string) => void;
  sitePassword: string;
  setSitePassword: (value: string) => void;
  userAccessToken: string;
  setUserAccessToken: (value: string) => void;
  adminRoleConfirmed?: boolean;
  addressJwt: string;
  setAddressJwt: (value: string) => void;
  turnstileSiteKey?: string;
  turnstileRequired?: boolean;
  request: Requester;
  notify: Notify;
  initialOpen?: boolean;
  canForgetBrowser?: boolean;
  onForgetBrowser?: () => void;
}) {
  const isAuthenticated = Boolean(adminPassword || userAccessToken);
  const initialOpen = requestedInitialOpen ?? !isAuthenticated;
  const [open, setOpen] = useState(initialOpen);
  const locale = getRuntimeLocale();
  const t = (zh: string, en: string) => localeText(zh, en, locale);

  const decodedUser = userAccessToken ? decodeAccessToken(userAccessToken) : null;
  const confirmedAdmin = Boolean(adminPassword || adminRoleConfirmed || decodedUser?.isAdmin);
  const apiHost = getApiHostLabel(apiBase, locale);
  const loginHref = '/';
  const authMethod = adminPassword ? t('管理员账号登录', 'Admin account sign-in') : userAccessToken ? t('账号登录', 'Account sign-in') : '';
  const identityLabel = confirmedAdmin ? t('管理员', 'Admin') : decodedUser?.roleLabel || t('用户', 'User');

  return <>
    <CredentialButton onClick={() => setOpen(true)} />
    {open && (
      <Modal
        title={isAuthenticated ? t('账号信息', 'Account info') : t('请先登录', 'Sign in required')}
        onClose={() => setOpen(false)}
        cardClassName={isAuthenticated ? 'account-info-modal-card' : ''}
        bodyClassName={isAuthenticated ? 'account-info-modal-body' : ''}
      >
        {isAuthenticated ? (
          /* ───── 已认证：账号信息面板 ───── */
          <div className="account-info-shell">
            <div className="account-info-card">
              <AccountInfoRow icon={WebhookLogo} tone="connection" label={t('连接信息', 'Connection')} value={apiHost} />
              <AccountInfoRow icon={LockLogo} tone="auth" label={t('认证方式', 'Auth method')} value={authMethod} />
              <AccountInfoRow icon={UserAdminLogo} tone="role" label={t('身份', 'Role')} value={identityLabel} />

              {decodedUser ? (
                <>
                  <AccountInfoRow icon={AddressLogo} tone="account" label={t('登录账号', 'Login account')} value={decodedUser.userEmail || `ID ${decodedUser.userId}`} />
                  <div className="account-detail-grid">
                    <p><span>{t('邮箱', 'Email')}：</span>{decodedUser.userEmail || '-'}</p>
                    <p><span>{t('用户名', 'Username')}：</span>{decodedUser.username || '-'}</p>
                    <p><span>{t('用户 ID', 'User ID')}：</span>{decodedUser.userId || '-'}</p>
                    <p><span>{t('管理员身份', 'Admin role')}：</span>{confirmedAdmin ? t('已确认', 'Confirmed') : t('未确认', 'Not confirmed')}</p>
                  </div>
                </>
              ) : null}
            </div>

            {/* 退出登录 */}
            {canForgetBrowser && onForgetBrowser ? (
              <div className="account-danger-zone">
                <p className="account-danger-copy">
                  {t('退出当前后台并清除本机保存的凭据、地址登录和管理数据缓存；界面偏好会保留。', 'Sign out and clear saved credentials, address login, and local admin data caches on this browser. UI preferences are kept.')}
                </p>
                <button type="button" onClick={() => { setOpen(false); onForgetBrowser(); }} className="btn-danger account-danger-action compact">
                  <LogOut size={16} /> {t('退出登录', 'Sign out')}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3 auth-compact">
            <div className="auth-intro rounded-2xl border border-slate-100 bg-white p-4 text-sm leading-6 text-slate-600">
              {t('请回到后台登录页，并使用管理员账号或 LinuxDo 登录。', 'Return to the admin sign-in page and use an admin account or LinuxDo.')}
            </div>
            <a className="btn-primary w-full compact justify-center" href={loginHref}>{t('返回登录页', 'Back to sign in')}</a>
          </div>
        )}
      </Modal>
    )}
  </>;
}
