import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertCircle, Bell, Check, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useNotice, type Notice } from './Common';
import { Logo } from './Shell';
import { STORAGE_KEYS } from '../lib/constants';
import { cls } from '../lib/format';
import { localeText, type AppLocale } from '../lib/locale';
import { normalizeAuthApiBase } from '../lib/storage';
import {
  completeOAuthLogin,
  fetchOAuthLoginUrl,
  fetchOpenUserSettings,
  loginAccountUser,
  registerAccountUser,
  requestUserVerifyCode,
  type AccountUserProfile,
  type OAuthClientInfo,
} from '../lib/userAuth';

type LoginMode = 'login' | 'register';

const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const OAUTH_LEGACY_STATE_KEY = 'loven7.admin.oauth.state';
const OAUTH_LEGACY_CLIENT_KEY = 'loven7.admin.oauth.client';
const FALLBACK_LINUXDO_CLIENT: OAuthClientInfo = {
  clientID: '4zxbTaQB2Zo23wT6NGF6OyKD82bNIJhR',
  name: 'LinuxDo',
};

type OAuthAttempt = {
  state: string;
  clientID: string;
  apiBase: string;
  createdAt: number;
};

function createState() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function resolveLinuxDoClient(clients: OAuthClientInfo[]) {
  return clients.find((client) => /linux\s*do|linuxdo|l站/i.test(`${client.name} ${client.clientID}`)) || clients[0] || null;
}

function readOAuthReturn() {
  if (typeof window === 'undefined') return { code: '', state: '', error: '' };
  const url = new URL(window.location.href);
  const code = url.searchParams.get('oauth_code') || url.searchParams.get('code') || '';
  const state = url.searchParams.get('oauth_state') || url.searchParams.get('state') || '';
  const error = url.searchParams.get('oauth_error') || url.searchParams.get('error') || '';
  if (code || state || error) {
    url.searchParams.delete('oauth_code');
    url.searchParams.delete('oauth_state');
    url.searchParams.delete('oauth_error');
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    url.searchParams.delete('error');
    window.history.replaceState(null, document.title, `${url.pathname}${url.searchParams.toString() ? `?${url.searchParams}` : ''}${url.hash}`);
  }
  return { code, state, error };
}

function oauthApiScope(apiBase: string) {
  return normalizeAuthApiBase(apiBase) || 'same-origin';
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function clearOAuthAttempt(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEYS.oauthLoginAttempt);
    window.sessionStorage.removeItem(OAUTH_LEGACY_STATE_KEY);
    window.sessionStorage.removeItem(OAUTH_LEGACY_CLIENT_KEY);
  } catch {
    // Storage cleanup is best-effort in privacy modes.
  }
  try {
    window.localStorage.removeItem(STORAGE_KEYS.oauthLoginAttempt);
    window.localStorage.removeItem(OAUTH_LEGACY_STATE_KEY);
    window.localStorage.removeItem(OAUTH_LEGACY_CLIENT_KEY);
  } catch {
    // Legacy localStorage cleanup is best-effort.
  }
}

function writeOAuthAttempt(attempt: OAuthAttempt): boolean {
  const storage = getSessionStorage();
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEYS.oauthLoginAttempt, JSON.stringify(attempt));
    try {
      window.localStorage.removeItem(OAUTH_LEGACY_STATE_KEY);
      window.localStorage.removeItem(OAUTH_LEGACY_CLIENT_KEY);
    } catch {
      // Legacy cleanup is best-effort.
    }
    return true;
  } catch {
    return false;
  }
}

function readLegacyOAuthAttempt(apiBase: string): OAuthAttempt | null {
  if (typeof window === 'undefined') return null;
  try {
    const state = window.localStorage.getItem(OAUTH_LEGACY_STATE_KEY) || '';
    const clientID = window.localStorage.getItem(OAUTH_LEGACY_CLIENT_KEY) || '';
    if (!state || !clientID) return null;
    return { state, clientID, apiBase: oauthApiScope(apiBase), createdAt: Date.now() };
  } catch {
    return null;
  }
}

function consumeOAuthAttempt(apiBase: string): OAuthAttempt | null {
  const storage = getSessionStorage();
  let attempt: OAuthAttempt | null = null;
  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_KEYS.oauthLoginAttempt);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<OAuthAttempt>;
        if (parsed.state && parsed.clientID && parsed.createdAt) {
          attempt = {
            state: String(parsed.state),
            clientID: String(parsed.clientID),
            apiBase: String(parsed.apiBase || 'same-origin'),
            createdAt: Number(parsed.createdAt),
          };
        }
      }
    } catch {
      attempt = null;
    }
  }
  attempt ||= readLegacyOAuthAttempt(apiBase);
  clearOAuthAttempt();
  if (!attempt) return null;
  if (!Number.isFinite(attempt.createdAt) || Date.now() - attempt.createdAt > OAUTH_ATTEMPT_TTL_MS) return null;
  return attempt;
}

function safeOAuthRedirectUrl(value: string): string {
  if (typeof window === 'undefined') return value;
  const url = new URL(value, window.location.origin);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('OAuth 登录地址无效');
  return url.toString();
}

function LoginBrand() {
  return (
    <div className="anything-login-brand">
      <Logo />
      <div className="anything-login-brand-copy" aria-label="Loven7-Mail">
        <h1 className="brand-wordmark anything-login-wordmark">
          <span>Loven7</span>
          <span>Mail</span>
        </h1>
      </div>
    </div>
  );
}

function resolveClientIconSrc(client: OAuthClientInfo | null) {
  const rawIcon = client?.icon?.trim() || '';
  if (!rawIcon) return '';
  if (/^<svg[\s>]/i.test(rawIcon)) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rawIcon)}`;
  }
  if (/^(https?:\/\/|data:image\/(?:svg\+xml|png|jpe?g|webp))/i.test(rawIcon)) return rawIcon;
  return '';
}

function LinuxDoIcon({ client, loading }: { client: OAuthClientInfo | null; loading: boolean }) {
  if (loading) {
    return (
      <span className="anything-oauth-icon anything-oauth-icon-loading">
        <Loader2 className="h-[22px] w-[22px] animate-spin text-[#111316]" />
      </span>
    );
  }
  const iconSrc = resolveClientIconSrc(client);
  if (iconSrc) {
    return <img className="anything-oauth-icon" src={iconSrc} alt="" loading="lazy" decoding="async" />;
  }
  return (
    <svg className="anything-oauth-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m7.44,0s.09,0,.13,0c.09,0,.19,0,.28,0,.14,0,.29,0,.43,0,.09,0,.18,0,.27,0q.12,0,.25,0t.26.08c.15.03.29.06.44.08,1.97.38,3.78,1.47,4.95,3.11.04.06.09.12.13.18.67.96,1.15,2.11,1.3,3.28q0,.19.09.26c0,.15,0,.29,0,.44,0,.04,0,.09,0,.13,0,.09,0,.19,0,.28,0,.14,0,.29,0,.43,0,.09,0,.18,0,.27,0,.08,0,.17,0,.25q0,.19-.08.26c-.03.15-.06.29-.08.44-.38,1.97-1.47,3.78-3.11,4.95-.06.04-.12.09-.18.13-.96.67-2.11,1.15-3.28,1.3q-.19,0-.26.09c-.15,0-.29,0-.44,0-.04,0-.09,0-.13,0-.09,0-.19,0-.28,0-.14,0-.29,0-.43,0-.09,0-.18,0-.27,0-.08,0-.17,0-.25,0q-.19,0-.26-.08c-.15-.03-.29-.06-.44-.08-1.97-.38-3.78-1.47-4.95-3.11q-.07-.09-.13-.18c-.67-.96-1.15-2.11-1.3-3.28q0-.19-.09-.26c0-.15,0-.29,0-.44,0-.04,0-.09,0-.13,0-.09,0-.19,0-.28,0-.14,0-.29,0-.43,0-.09,0-.18,0-.27,0-.08,0-.17,0-.25q0-.19.08-.26c.03-.15.06-.29.08-.44.38-1.97,1.47-3.78,3.11-4.95.06-.04.12-.09.18-.13C4.42.73,5.57.26,6.74.1,7,.07,7.15,0,7.44,0Z" fill="#EFEFEF" />
      <path d="m1.27,11.33h13.45c-.94,1.89-2.51,3.21-4.51,3.88-1.99.59-3.96.37-5.8-.57-1.25-.7-2.67-1.9-3.14-3.3Z" fill="#FEB005" />
      <path d="m12.54,1.99c.87.7,1.82,1.59,2.18,2.68H1.27c.87-1.74,2.33-3.13,4.2-3.78,2.44-.79,5-.47,7.07,1.1Z" fill="#1D1D1F" />
    </svg>
  );
}

function LoginNoticeToast({ notice }: { notice: Notice }) {
  if (!notice) return null;
  const Icon = notice.type === 'success' ? Check : notice.type === 'error' ? AlertCircle : Bell;
  return (
    <div className={cls('anything-login-toast', `anything-login-toast-${notice.type}`)} role={notice.type === 'error' ? 'alert' : 'status'}>
      <Icon size={17} />
      <span>{notice.message}</span>
    </div>
  );
}

export function BackendLogin({ apiBase, locale, theme, onAccountLogin, onDirectLogin }: {
  apiBase: string;
  locale: AppLocale;
  theme: 'light' | 'dark';
  onAccountLogin: (profile: AccountUserProfile) => void | Promise<void>;
  onDirectLogin: (session: { jwt: string; address: string }) => void;
}) {
  void theme;
  void onDirectLogin;
  const [mode, setMode] = useState<LoginMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [clients, setClients] = useState<OAuthClientInfo[]>([]);
  const [enableMailVerify, setEnableMailVerify] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [busy, setBusy] = useState('');
  const { notice, push } = useNotice();
  const t = useCallback((zh: string, en: string) => localeText(zh, en, locale), [locale]);
  const linuxDoClient = useMemo(() => resolveLinuxDoClient(clients) || FALLBACK_LINUXDO_CLIENT, [clients]);

  useEffect(() => {
    if (codeCooldown <= 0) return undefined;
    const timer = window.setInterval(() => {
      setCodeCooldown((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [codeCooldown]);

  useEffect(() => {
    let cancelled = false;
    fetchOpenUserSettings(apiBase)
      .then((settings) => {
        if (cancelled) return;
        setClients(Array.isArray(settings.oauth2ClientIDs) ? settings.oauth2ClientIDs : []);
        setEnableMailVerify(Boolean(settings.enableMailVerify));
        setRegistrationEnabled(settings.enable !== false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  useEffect(() => {
    const params = readOAuthReturn();
    if (!params.code && !params.error) return;
    const attempt = consumeOAuthAttempt(apiBase);
    if (params.error) {
      push('error', params.error.slice(0, 180));
      return;
    }
    if (!params.code || !params.state || !attempt || params.state !== attempt.state || attempt.apiBase !== oauthApiScope(apiBase)) {
      push('error', t('LinuxDo 登录状态校验失败，请重新登录。', 'LinuxDo sign-in state check failed. Try again.'));
      return;
    }
    setBusy('oauth');
    completeOAuthLogin(apiBase, params.code, attempt.clientID)
      .then(onAccountLogin)
      .catch((err) => push('error', err instanceof Error ? err.message : t('LinuxDo 登录失败', 'LinuxDo sign-in failed')))
      .finally(() => setBusy(''));
  }, [apiBase, onAccountLogin, push, t]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      push('error', t('请输入邮箱和密码。', 'Enter email and password.'));
      return;
    }
    if (mode === 'register' && enableMailVerify && !code.trim()) {
      push('error', t('请输入验证码。', 'Enter the verification code.'));
      return;
    }
    setBusy(mode);
    try {
      const profile = mode === 'register'
        ? await registerAccountUser(apiBase, cleanEmail, password, code.trim())
        : await loginAccountUser(apiBase, cleanEmail, password);
      await onAccountLogin(profile);
      setPassword('');
      setCode('');
    } catch (err) {
      push('error', err instanceof Error ? err.message : t('登录失败', 'Sign-in failed'));
    } finally {
      setBusy('');
    }
  };

  const sendCode = async () => {
    if (codeCooldown > 0) return;
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      push('error', t('请输入邮箱。', 'Enter email.'));
      return;
    }
    setBusy('code');
    try {
      await requestUserVerifyCode(apiBase, cleanEmail);
      setCodeCooldown(60);
    } catch (err) {
      push('error', err instanceof Error ? err.message : t('发送失败', 'Failed to send code'));
    } finally {
      setBusy('');
    }
  };

  const codeButtonText = busy === 'code'
    ? t('发送中', 'Sending')
    : codeCooldown > 0
      ? t(`已发送 ${codeCooldown}s`, `Sent ${codeCooldown}s`)
      : t('发送', 'Send');

  const startOAuth = async () => {
    if (!linuxDoClient?.clientID) return;
    setBusy('oauth');
    try {
      const state = createState();
      const stored = writeOAuthAttempt({
        state,
        clientID: linuxDoClient.clientID,
        apiBase: oauthApiScope(apiBase),
        createdAt: Date.now(),
      });
      if (!stored) throw new Error(t('浏览器无法保存临时登录状态，请检查隐私模式或存储权限。', 'The browser could not save the temporary sign-in state. Check private mode or storage permissions.'));
      const url = await fetchOAuthLoginUrl(apiBase, linuxDoClient.clientID, state);
      window.location.assign(safeOAuthRedirectUrl(url));
    } catch (err) {
      clearOAuthAttempt();
      setBusy('');
      push('error', err instanceof Error ? err.message : t('LinuxDo 登录失败', 'LinuxDo sign-in failed'));
    }
  };

  return (
    <div className="anything-login-page">
      <LoginNoticeToast notice={notice} />
      <div className="anything-login-logo">
        <LoginBrand />
      </div>
      <main className="anything-login-left">
        <div className="anything-login-left-inner">
          <section className="anything-login-form-card">
            <form className="anything-login-form" onSubmit={submit}>
              <div className="anything-login-title-block">
                <h2 className="anything-login-title">{mode === 'register' ? t('注册账号', 'Create account') : t('登录', 'Log in')}</h2>
              </div>

              <div className="anything-login-fields">
                <div className="anything-login-field-stack">
                  <div className="anything-oauth-wrap">
                    {linuxDoClient ? (
                      <button type="button" className="anything-oauth-trigger" disabled={Boolean(busy)} onClick={startOAuth}>
                        <span className="anything-oauth-card">
                          <LinuxDoIcon client={linuxDoClient} loading={busy === 'oauth'} />
                          <span className="anything-oauth-text">{t('使用 LinuxDo 登录', 'Sign in with LinuxDo')}</span>
                        </span>
                      </button>
                    ) : null}
                    <div className="anything-login-divider">
                      <span />
                      <p>{t('或', 'Or')}</p>
                      <span />
                    </div>
                  </div>

                  <label className="anything-field-label">
                    <span className="anything-label-line">{t('邮箱', 'Email')}<span /></span>
                    <input className="anything-input" placeholder={t('请输入邮箱', 'Enter your email')} type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
                  </label>
                  <label className="anything-field-label anything-field-spaced">
                    <span className="anything-label-line">{t('密码', 'Password')}<span /></span>
                    <span className="anything-password-control">
                      <input className="anything-input" placeholder={t('请输入密码', 'Enter your password')} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
                      <button type="button" className="anything-password-toggle" aria-label={showPassword ? t('隐藏密码', 'Hide password') : t('显示密码', 'Show password')} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>
                        {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                    </span>
                  </label>
                  {mode === 'register' && enableMailVerify ? (
                    <div className="anything-code-row">
                      <label className="anything-field-label">
                        <span className="anything-label-line">{t('验证码', 'Verification code')}<span /></span>
                        <input className="anything-input" value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" />
                      </label>
                      <button type="button" className={cls('anything-code-button', codeCooldown > 0 && 'is-sent')} disabled={busy === 'code' || codeCooldown > 0} onClick={sendCode}>{codeButtonText}</button>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="anything-submit-wrap">
                <button type="submit" className="anything-primary-button" disabled={Boolean(busy)}>
                  {busy && busy !== 'oauth' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {busy && busy !== 'oauth' ? t('处理中...', 'Working...') : mode === 'register' ? t('创建账号', 'Create account') : t('登录', 'Log in')}
                </button>
              </div>

              <div className="anything-login-footer">
                <p>{mode === 'register' ? t('已有账号？', 'Already have an account?') : t('还没有账号？', "Don't have an account?")}</p>
                <button type="button" disabled={mode === 'login' && !registrationEnabled} onClick={() => setMode(mode === 'register' ? 'login' : 'register')}>
                  {mode === 'register' ? t('去登录', 'Log in') : t('创建账号', 'Create your account')}
                </button>
              </div>
            </form>
          </section>
        </div>
      </main>
      <aside className="anything-login-media">
        <img src="/loven7-anything-login-bg.png" alt="" />
      </aside>
    </div>
  );
}
