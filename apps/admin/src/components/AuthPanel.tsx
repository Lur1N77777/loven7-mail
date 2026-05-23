import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, Loader2, Lock } from 'lucide-react';
import type { Requester } from '../lib/api';
import { isAllowedApiBase, STORAGE_KEYS } from '../lib/constants';
import { sha256Hex } from '../lib/crypto';
import { writeAuthCookieMirror, writeLocalStorage, writeSessionStorage } from '../lib/storage';
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

export function AuthPanel({ apiBase, setApiBase, adminPassword, setAdminPassword, sitePassword, setSitePassword, userAccessToken, setUserAccessToken, turnstileSiteKey, turnstileRequired, request, notify, initialOpen: requestedInitialOpen }: {
  apiBase: string;
  setApiBase: (value: string) => void;
  adminPassword: string;
  setAdminPassword: (value: string) => void;
  sitePassword: string;
  setSitePassword: (value: string) => void;
  userAccessToken: string;
  setUserAccessToken: (value: string) => void;
  turnstileSiteKey?: string;
  turnstileRequired?: boolean;
  request: Requester;
  notify: Notify;
  initialOpen?: boolean;
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
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) return;
    setTmpAdmin(adminPassword);
    setTmpSite(sitePassword);
    setTmpBase(apiBase);
    setTmpAccessToken(userAccessToken);
    setUnlockedHost(false);
  }, [adminPassword, apiBase, open, sitePassword, userAccessToken]);

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

  const save = async () => {
    setLoading(true);
    try {
      const normalizedBase = tmpBase.trim().replace(/\/$/, '');
      if (!baseAllowed) throw new Error(baseCheck.reason || 'Worker API 地址不受信任');
      const withBase = (path: string) => (normalizedBase ? `${normalizedBase}${path}` : path);
      const trimmedAdmin = tmpAdmin.trim();
      const trimmedSite = tmpSite.trim();
      const trimmedAccessToken = tmpAccessToken.trim();
      if (!trimmedAdmin && !trimmedAccessToken) throw new Error('请填写管理员密码，或填写具备管理员角色的用户 access token');
      if (turnstileRequired && !cfToken && !trimmedAccessToken) throw new Error('当前 Worker 开启 Turnstile，请先完成校验或填写有效用户管理员 access token');
      if (trimmedSite) await request(withBase('/open_api/site_login'), { method: 'POST', sitePassword: trimmedSite, body: { password: await sha256Hex(trimmedSite), cf_token: cfToken || undefined } });
      if (trimmedAdmin) await request(withBase('/open_api/admin_login'), { method: 'POST', sitePassword: trimmedSite, body: { password: await sha256Hex(trimmedAdmin), cf_token: cfToken || undefined } });
      setApiBase(normalizedBase);
      writeLocalStorage(STORAGE_KEYS.apiBase, normalizedBase);
      setAdminPassword(trimmedAdmin);
      setSitePassword(trimmedSite);
      setUserAccessToken(trimmedAccessToken);
      writeLocalStorage(STORAGE_KEYS.adminPassword, trimmedAdmin);
      writeLocalStorage(STORAGE_KEYS.sitePassword, trimmedSite);
      writeLocalStorage(STORAGE_KEYS.userAccessToken, trimmedAccessToken);
      writeLocalStorage(STORAGE_KEYS.authRememberedAt, String(Date.now()));
      writeSessionStorage(STORAGE_KEYS.adminPassword, trimmedAdmin);
      writeSessionStorage(STORAGE_KEYS.sitePassword, trimmedSite);
      writeSessionStorage(STORAGE_KEYS.userAccessToken, trimmedAccessToken);
      writeAuthCookieMirror({
        apiBase: normalizedBase,
        adminPassword: trimmedAdmin,
        sitePassword: trimmedSite,
        userAccessToken: trimmedAccessToken,
        rememberedAt: Date.now(),
      });
      notify('success', trimmedAdmin ? '管理员认证成功' : '已保存用户管理员 access token');
      setOpen(false);
    } catch (error) {
      setCfToken('');
      resetTurnstile();
      notify('error', error instanceof Error ? error.message : '认证失败');
    } finally {
      setLoading(false);
    }
  };

  return <>
    <CredentialButton onClick={() => setOpen(true)} />
    {open && <Modal title="连接设置" onClose={() => setOpen(false)}>
      <div className="space-y-3 auth-compact">
        <div className="auth-intro rounded-2xl border border-slate-100 bg-white p-3 text-xs leading-5 text-slate-500">
          保存一次后会自动记住当前站点配置。建议固定使用正式域名，避免预览域名之间缓存不共享。
        </div>
        <div>
          <label className="form-label">Worker API 地址</label>
          <input
            className="form-input compact-control"
            value={tmpBase}
            onChange={(event) => { setTmpBase(event.target.value); setUnlockedHost(false); }}
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
                  <button type="button" className="mt-1 underline" onClick={() => setUnlockedHost(true)}>我确认这是受我管理的 Worker，允许使用</button>
                </div>
              </div>
            </div>
          )}
        </div>
        <div>
          <label className="form-label">管理员密码</label>
          <input
            className="form-input compact-control"
            value={tmpAdmin}
            onChange={(event) => setTmpAdmin(event.target.value)}
            type="password"
            placeholder="ADMIN_PASSWORDS 中配置的密码"
            onKeyDown={(event) => { if (isEnterCommit(event)) save(); }}
          />
        </div>
        <button type="button" className="auth-advanced-toggle" onClick={() => setAdvancedOpen((value) => !value)}>{advancedOpen ? '收起高级选项' : '高级选项：站点密码 / Access Token / Turnstile'}</button>
        {advancedOpen && <div className="space-y-3 rounded-2xl border border-slate-100 p-3">
          <div>
            <label className="form-label">全站访问密码 x-custom-auth（可选）</label>
            <input className="form-input compact-control" value={tmpSite} onChange={(event) => setTmpSite(event.target.value)} type="password" placeholder="未配置 PASSWORDS 就留空" />
          </div>
          <div>
            <label className="form-label">用户管理员 Access Token（可选）</label>
            <textarea className="form-textarea compact-textarea" value={tmpAccessToken} onChange={(event) => setTmpAccessToken(event.target.value)} placeholder="如果 Worker 使用 ADMIN_USER_ROLE，可填 x-user-access-token" />
          </div>
          {turnstileSiteKey ? <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3"><div ref={turnstileRef} /><p className="mt-2 text-xs text-slate-700">{turnstileReady ? 'Turnstile 已加载，请完成校验。' : '正在加载 Turnstile；若无法加载，可在下方手动填 cf_token。'}</p></div> : null}
          <div>
            <label className="form-label">Turnstile cf_token（可选）</label>
            <input className="form-input compact-control" value={cfToken} onChange={(event) => setCfToken(event.target.value)} placeholder="开启 enableGlobalTurnstileCheck 时使用" />
          </div>
        </div>}
        <button onClick={save} disabled={loading || !baseAllowed} className="btn-primary w-full compact">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock size={16} />} 保存并验证</button>
      </div>
    </Modal>}
  </>;
}
