import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, Loader2, Lock, LogOut } from 'lucide-react';
import type { Requester } from '../lib/api';
import { isAllowedApiBase, STORAGE_KEYS } from '../lib/constants';
import { sha256Hex } from '../lib/crypto';
import { getRuntimeLocale, localeText } from '../lib/locale';
import { normalizeAuthApiBase, readBoundAuth, writeBoundAuth, writeLocalStorage } from '../lib/storage';
import { Modal, type Notify } from './Common';
import { CredentialButton } from './Shell';

function loadTurnstileScript() {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.turnstile) return Promise.resolve(true);
  const existing = document.querySelector<HTMLScriptElement>('script[data-loven7-turnstile="true"]');
  if (existing) return new Promise<boolean>((resolve) => {
    existing.addEventListener('load', () => resolve(true), { once: true });
    existing.addEventListener('error', () => resolve(false), { once: true });
  });
  return new Promise<boolean>((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.dataset.loven7Turnstile = 'true';
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

function isEnterCommit(event: KeyboardEvent<HTMLInputElement>): boolean {
  if (event.key !== 'Enter') return false;
  if (event.nativeEvent.isComposing) return false;
  if ('keyCode' in event.nativeEvent && (event.nativeEvent as KeyboardEvent['nativeEvent']).keyCode === 229) return false;
  return true;
}

export function AuthPanel({ apiBase, setApiBase, adminPassword, setAdminPassword, sitePassword, setSitePassword, userAccessToken, setUserAccessToken, addressJwt, setAddressJwt, turnstileSiteKey, turnstileRequired, request, notify, initialOpen: requestedInitialOpen, canForgetBrowser = false, onForgetBrowser }: {
  apiBase: string;
  setApiBase: (value: string) => void;
  adminPassword: string;
  setAdminPassword: (value: string) => void;
  sitePassword: string;
  setSitePassword: (value: string) => void;
  userAccessToken: string;
  setUserAccessToken: (value: string) => void;
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
  const initialOpen = requestedInitialOpen ?? (!adminPassword && !userAccessToken);
  const [open, setOpen] = useState(initialOpen);
  const [tmpAdmin, setTmpAdmin] = useState(adminPassword);
  const [tmpSite, setTmpSite] = useState(sitePassword);
  const [tmpBase, setTmpBase] = useState(apiBase);
  const [tmpAccessToken, setTmpAccessToken] = useState(userAccessToken);
  const [cfToken, setCfToken] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [unlockedHost, setUnlockedHost] = useState(false);
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [baseSwitchHint, setBaseSwitchHint] = useState('');
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<string | null>(null);
  const locale = getRuntimeLocale();
  const t = (zh: string, en: string) => localeText(zh, en, locale);

  useEffect(() => {
    if (open) return;
    setTmpAdmin(adminPassword);
    setTmpSite(sitePassword);
    setTmpBase(apiBase);
    setTmpAccessToken(userAccessToken);
    setUnlockedHost(false);
    setBaseSwitchHint('');
  }, [adminPassword, apiBase, open, sitePassword, userAccessToken]);

  useEffect(() => {
    if (adminPassword || sitePassword || userAccessToken) return;
    setTmpAdmin('');
    setTmpSite('');
    setTmpAccessToken('');
    setCfToken('');
  }, [adminPassword, sitePassword, userAccessToken]);

  useEffect(() => {
    let cancelled = false;
    if (!open || !turnstileSiteKey) return undefined;
    loadTurnstileScript().then((ready) => {
      if (cancelled) return;
      setTurnstileReady(ready);
      if (!ready || !turnstileRef.current || !window.turnstile || widgetRef.current) return;
      widgetRef.current = window.turnstile.render(turnstileRef.current, {
        sitekey: turnstileSiteKey,
        callback: (token: string) => setCfToken(token),
        'expired-callback': () => setCfToken(''),
        'error-callback': () => setCfToken(''),
      });
    });
    return () => {
      cancelled = true;
      if (widgetRef.current && window.turnstile) {
        const removeFn = (window.turnstile as unknown as { remove?: (id: string) => void }).remove;
        try { removeFn?.(widgetRef.current); } catch { /* ignore */ }
        widgetRef.current = null;
      }
    };
  }, [open, turnstileSiteKey]);

  const resetTurnstile = () => {
    try {
      if (widgetRef.current && window.turnstile) window.turnstile.reset(widgetRef.current);
    } catch {
      // ignore turnstile reset failures
    }
  };

  const baseCheck = isAllowedApiBase(tmpBase);
  const baseAllowed = baseCheck.ok || unlockedHost;

  const loadCredentialsForBase = (nextBase: string) => {
    const normalizedNext = normalizeAuthApiBase(nextBase);
    const normalizedCurrent = normalizeAuthApiBase(apiBase);
    if (normalizedNext === normalizedCurrent) {
      setTmpAdmin(adminPassword);
      setTmpSite(sitePassword);
      setTmpAccessToken(userAccessToken);
      setBaseSwitchHint('');
      return;
    }
    const bound = readBoundAuth(normalizedNext);
    setTmpAdmin(bound.adminPassword);
    setTmpSite(bound.sitePassword);
    setTmpAccessToken(bound.userAccessToken);
    setBaseSwitchHint(bound.adminPassword || bound.userAccessToken
      ? t('已切换到此 Worker 地址在本浏览器保存的独立凭据。', 'Loaded the saved credentials for this Worker address on this browser.')
      : t('Worker 地址已变化。为避免凭据泄漏，已清空旧地址的管理员密码和 Access Token，请重新验证。', 'Worker address changed. To avoid credential leakage, old admin password/access token was cleared; please verify again.'));
  };

  const save = async () => {
    setLoading(true);
    try {
      const normalizedBase = normalizeAuthApiBase(tmpBase);
      if (!baseAllowed) throw new Error(baseCheck.reason || t('Worker API 地址不受信任', 'Worker API address is not trusted'));
      const withBase = (path: string) => (normalizedBase ? `${normalizedBase}${path}` : path);
      const trimmedAdmin = tmpAdmin.trim();
      const trimmedSite = tmpSite.trim();
      const trimmedAccessToken = tmpAccessToken.trim();
      if (!trimmedAdmin && !trimmedAccessToken) throw new Error(t('请填写管理员密码，或填写具备管理员角色的用户 access token', 'Enter an admin password, or provide a user access token with an admin role'));
      if (turnstileRequired && !cfToken && !trimmedAccessToken) throw new Error(t('当前 Worker 开启 Turnstile，请先完成校验或填写有效用户管理员 access token', 'Turnstile is enabled on this Worker. Complete verification or provide a valid admin user access token'));
      const verificationCredentials = {
        adminPassword: '',
        sitePassword: trimmedSite,
        userAccessToken: '',
        addressJwt: '',
      };
      if (trimmedSite) await request(withBase('/open_api/site_login'), { method: 'POST', ...verificationCredentials, body: { password: await sha256Hex(trimmedSite), cf_token: cfToken || undefined } });
      if (trimmedAdmin) await request(withBase('/open_api/admin_login'), { method: 'POST', ...verificationCredentials, body: { password: await sha256Hex(trimmedAdmin), cf_token: cfToken || undefined } });
      if (!trimmedAdmin && trimmedAccessToken) {
        await request(withBase('/admin/statistics'), {
          method: 'GET',
          adminPassword: '',
          sitePassword: trimmedSite,
          userAccessToken: trimmedAccessToken,
          addressJwt: '',
          forceRefresh: true,
          skipCache: true,
        });
      }
      setApiBase(normalizedBase);
      writeLocalStorage(STORAGE_KEYS.apiBase, normalizedBase);
      setAdminPassword(trimmedAdmin);
      setSitePassword(trimmedSite);
      setUserAccessToken(trimmedAccessToken);
      const bound = readBoundAuth(normalizedBase);
      const rememberedAt = Date.now();
      setAddressJwt(bound.addressJwt);
      writeBoundAuth(normalizedBase, {
        adminPassword: trimmedAdmin,
        sitePassword: trimmedSite,
        userAccessToken: trimmedAccessToken,
        addressJwt: bound.addressJwt,
        rememberedAt,
      }, rememberedAt);
      notify('success', trimmedAdmin ? t('管理员认证成功', 'Admin verified') : t('已保存用户管理员 access token', 'Admin user access token saved'));
      setOpen(false);
    } catch (error) {
      setCfToken('');
      resetTurnstile();
      notify('error', error instanceof Error ? error.message : t('认证失败', 'Authentication failed'));
    } finally {
      setLoading(false);
    }
  };

  return <>
    <CredentialButton onClick={() => setOpen(true)} />
    {open && <Modal title={t('连接设置', 'Connection settings')} onClose={() => setOpen(false)}>
      <div className="space-y-3 auth-compact">
        <div className="auth-intro rounded-2xl border border-slate-100 bg-white p-3 text-xs leading-5 text-slate-500">
          {t('保存一次后会自动记住当前站点配置。建议固定使用正式域名，避免预览域名之间缓存不共享。', 'Save once and this browser will remember the site configuration. Prefer a stable production domain so preview domains do not split cached credentials.')}
        </div>
        <div>
          <label className="form-label">{t('Worker API 地址', 'Worker API address')}</label>
          <input
            className="form-input compact-control"
            value={tmpBase}
            onChange={(event) => {
              const value = event.target.value;
              setTmpBase(value);
              setUnlockedHost(false);
              loadCredentialsForBase(value);
            }}
            placeholder="https://your-worker.example.workers.dev"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
          />
          {!baseCheck.ok && tmpBase.trim() && !unlockedHost && (
            <div className="mt-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-700">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p>{baseCheck.reason}</p>
                  <button type="button" className="mt-1 underline" onClick={() => setUnlockedHost(true)}>{t('我确认这是受我管理的 Worker，允许使用', 'I confirm this is my Worker and allow using it')}</button>
                </div>
              </div>
            </div>
          )}
          {baseSwitchHint && (
            <div className="mt-1 rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-[11px] leading-4 text-sky-700">
              {baseSwitchHint}
            </div>
          )}
        </div>
        <div>
          <label className="form-label">{t('管理员密码', 'Admin password')}</label>
          <input
            className="form-input compact-control"
            value={tmpAdmin}
            onChange={(event) => setTmpAdmin(event.target.value)}
            type="password"
            placeholder={t('ADMIN_PASSWORDS 中配置的密码', 'Password configured in ADMIN_PASSWORDS')}
            onKeyDown={(event) => { if (isEnterCommit(event)) save(); }}
          />
        </div>
        <button type="button" className="auth-advanced-toggle" onClick={() => setAdvancedOpen((value) => !value)}>{advancedOpen ? t('收起高级选项', 'Hide advanced options') : t('高级选项：站点密码 / Access Token / Turnstile', 'Advanced: site password / access token / Turnstile')}</button>
        {advancedOpen && <div className="space-y-3 rounded-2xl border border-slate-100 p-3">
          <div>
            <label className="form-label">{t('全站访问密码 x-custom-auth（可选）', 'Site password x-custom-auth (optional)')}</label>
            <input className="form-input compact-control" value={tmpSite} onChange={(event) => setTmpSite(event.target.value)} type="password" placeholder={t('未配置 PASSWORDS 就留空', 'Leave empty if PASSWORDS is not configured')} />
          </div>
          <div>
            <label className="form-label">{t('用户管理员 Access Token（可选）', 'Admin user access token (optional)')}</label>
            <textarea className="form-textarea compact-textarea" value={tmpAccessToken} onChange={(event) => setTmpAccessToken(event.target.value)} placeholder={t('如果 Worker 使用 ADMIN_USER_ROLE，可填 x-user-access-token', 'Use x-user-access-token when the Worker enables ADMIN_USER_ROLE')} />
          </div>
          {turnstileSiteKey ? <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3"><div ref={turnstileRef} /><p className="mt-2 text-xs text-slate-700">{turnstileReady ? t('Turnstile 已加载，请完成校验。', 'Turnstile is ready. Complete the challenge.') : t('正在加载 Turnstile；若无法加载，可在下方手动填 cf_token。', 'Loading Turnstile. If it cannot load, enter cf_token manually below.')}</p></div> : null}
          <div>
            <label className="form-label">{t('Turnstile cf_token（可选）', 'Turnstile cf_token (optional)')}</label>
            <input className="form-input compact-control" value={cfToken} onChange={(event) => setCfToken(event.target.value)} placeholder={t('开启 enableGlobalTurnstileCheck 时使用', 'Used when enableGlobalTurnstileCheck is enabled')} />
          </div>
        </div>}
        <button onClick={save} disabled={loading || !baseAllowed} className="btn-primary w-full compact">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock size={16} />} {t('保存并验证', 'Save and verify')}</button>
        {canForgetBrowser && onForgetBrowser ? (
          <div className="rounded-2xl border border-rose-100 bg-rose-50/70 p-3">
            <p className="mb-2 text-xs leading-5 text-rose-700">
              {t('退出当前后台并清除本机保存的凭据、地址登录和管理数据缓存；Worker 地址、主题、语言等界面偏好会保留。', 'Sign out and clear saved credentials, address login, and local admin data caches on this browser. API base, theme, language, and UI preferences are kept.')}
            </p>
            <button type="button" onClick={onForgetBrowser} disabled={loading} className="btn-danger w-full compact">
              <LogOut size={16} /> {t('退出并忘记此浏览器', 'Sign out and forget this browser')}
            </button>
          </div>
        ) : null}
      </div>
    </Modal>}
  </>;
}
