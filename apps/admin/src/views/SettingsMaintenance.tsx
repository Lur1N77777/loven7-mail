import { useCallback, useEffect, useState } from 'react';
import { Bot, Cloud, Database, Edit3, HardDrive, Link, Loader2, RefreshCw, Save, ShieldCheck, Trash2, Webhook } from 'lucide-react';
import type { Requester } from '../lib/api';
import { jsonPretty, safeJsonParse } from '../lib/format';
import { FRONTEND_LOGIN_BASE, STORAGE_KEYS } from '../lib/constants';
import { readStorage, writeLocalStorage } from '../lib/storage';
import { getRuntimeLocale, localeText } from '../lib/locale';
import type { RoleAddressConfigResponse, RoleRecord, TelegramStatus } from '../types/api';
import { EmptyState, LoadingState, Modal, type Notify } from '../components/Common';


function useSettingsLocale() {
  const locale = getRuntimeLocale();
  return {
    locale,
    t: (zh: string, en: string) => localeText(zh, en, locale),
  };
}

type JsonPath = Array<string | number>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function titleFromKey(key: string | number): string {
  return String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function updateJsonAtPath(value: unknown, path: JsonPath, nextValue: unknown): unknown {
  if (!path.length) return nextValue;
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const clone = [...value];
    clone[Number(head)] = updateJsonAtPath(clone[Number(head)], rest, nextValue);
    return clone;
  }
  const clone = isPlainObject(value) ? { ...value } : {};
  clone[String(head)] = updateJsonAtPath(clone[String(head)], rest, nextValue);
  return clone;
}

function primitiveArrayToText(values: unknown[]): string {
  return values.map((item) => String(item ?? '')).join('\n');
}

function textToStringArray(value: string): string[] {
  return value.split(/\n+/).map((item) => item.trim()).filter(Boolean);
}

function JsonVisualField({ fieldKey, value, path, root, onRootChange, depth = 0 }: { fieldKey: string | number; value: unknown; path: JsonPath; root: unknown; onRootChange: (next: unknown) => void; depth?: number }) {
  const { t } = useSettingsLocale();
  const label = titleFromKey(fieldKey);
  const commit = (nextValue: unknown) => onRootChange(updateJsonAtPath(root, path, nextValue));
  if (typeof value === 'boolean') {
    return <label className="json-visual-row json-visual-switch"><span><strong>{label}</strong><small>{String(fieldKey)}</small></span><input type="checkbox" checked={value} onChange={(e) => commit(e.target.checked)} /></label>;
  }
  if (typeof value === 'number') {
    return <label className="json-visual-row"><span><strong>{label}</strong><small>{String(fieldKey)}</small></span><input className="form-input compact-control" type="number" value={Number.isFinite(value) ? value : 0} onChange={(e) => commit(Number(e.target.value))} /></label>;
  }
  if (typeof value === 'string' || value === null || value === undefined) {
    const text = String(value ?? '');
    const multiline = text.length > 88 || text.includes('\n');
    return <label className="json-visual-row block"><span><strong>{label}</strong><small>{String(fieldKey)}</small></span>{multiline ? <textarea className="form-textarea json-visual-textarea" value={text} onChange={(e) => commit(e.target.value)} /> : <input className="form-input compact-control" value={text} onChange={(e) => commit(e.target.value)} />}</label>;
  }
  if (Array.isArray(value)) {
    const primitive = value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item));
    if (primitive) {
      return <label className="json-visual-row block"><span><strong>{label}</strong><small>{t('列表，每行一项', 'List, one item per line')} · {String(fieldKey)}</small></span><textarea className="form-textarea json-visual-textarea" value={primitiveArrayToText(value)} onChange={(e) => commit(textToStringArray(e.target.value))} /></label>;
    }
    return <JsonComplexField fieldKey={fieldKey} value={value} path={path} root={root} onRootChange={onRootChange} depth={depth} />;
  }
  if (isPlainObject(value)) {
    return <JsonComplexField fieldKey={fieldKey} value={value} path={path} root={root} onRootChange={onRootChange} depth={depth} />;
  }
  return <label className="json-visual-row block"><span><strong>{label}</strong><small>{String(fieldKey)}</small></span><textarea className="form-textarea json-visual-textarea" value={jsonPretty(value)} onChange={(e) => commit(safeJsonParse(e.target.value, value))} /></label>;
}

function JsonComplexField({ fieldKey, value, path, root, onRootChange, depth = 0 }: { fieldKey: string | number; value: unknown; path: JsonPath; root: unknown; onRootChange: (next: unknown) => void; depth?: number }) {
  const { t } = useSettingsLocale();
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const entries = isPlainObject(value) ? Object.entries(value) : [];
  const jsonValue = jsonPretty(value);
  const commitRaw = (raw: string) => onRootChange(updateJsonAtPath(root, path, safeJsonParse(raw, value)));
  return <section className="json-visual-group" style={{ marginLeft: depth ? Math.min(depth * 10, 28) : 0 }}>
    <div className="json-visual-group-head">
      <div><strong>{titleFromKey(fieldKey)}</strong><small>{Array.isArray(value) ? t(`${value.length} 项`, `${value.length} items`) : `${entries.length} fields`}</small></div>
      <div className="json-visual-mini-tabs"><button type="button" className={mode === 'form' ? 'active' : ''} onClick={() => setMode('form')}>{t('表单', 'Form')}</button><button type="button" className={mode === 'json' ? 'active' : ''} onClick={() => setMode('json')}>JSON</button></div>
    </div>
    {mode === 'json' || Array.isArray(value) ? <textarea className="code-area json-visual-code" value={jsonValue} onChange={(e) => commitRaw(e.target.value)} /> : <div className="json-visual-fields">{entries.map(([key, child]) => <div key={key}><JsonVisualField fieldKey={key} value={child} path={[...path, key]} root={root} onRootChange={onRootChange} depth={depth + 1} /></div>)}</div>}
  </section>;
}

function JsonVisualEditor({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const { t } = useSettingsLocale();
  if (!isPlainObject(value)) {
    return <div className="json-visual-empty">{t('当前配置不是对象结构，请使用 JSON 高级模式编辑。', 'This config is not an object; use advanced JSON mode.')}</div>;
  }
  const entries = Object.entries(value);
  if (!entries.length) return <div className="json-visual-empty">{t('当前配置为空。可切换到 JSON 高级模式添加新字段。', 'This config is empty. Switch to advanced JSON mode to add fields.')}</div>;
  return <div className="json-visual-editor">{entries.map(([key, child]) => <div key={key}><JsonVisualField fieldKey={key} value={child} path={[key]} root={value} onRootChange={onChange} /></div>)}</div>;
}

function GenericSettingsCard({ title, description, endpoint, request, notify, testEndpoint }: { title: string; description: string; endpoint: string; request: Requester; notify: Notify; testEndpoint?: string; key?: string }) {
  const { locale, t } = useSettingsLocale();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editorMode, setEditorMode] = useState<'visual' | 'json'>('visual');
  const [body, setBody] = useState('{}');
  const load = async () => { setLoading(true); try { const res = await request(endpoint); setBody(jsonPretty(res || {})); setOpen(true); } catch (error) { notify('error', error instanceof Error ? error.message : locale === 'en-US' ? `${title} load failed` : `${title} 加载失败`); } finally { setLoading(false); } };
  const save = async () => { try { const parsed = JSON.parse(body || '{}'); await request(endpoint, { method: 'POST', body: parsed }); notify('success', locale === 'en-US' ? `${title} saved` : `${title} 已保存`); } catch (error) { notify('error', error instanceof Error ? error.message : locale === 'en-US' ? `${title} save failed` : `${title} 保存失败`); } };
  const parsedBody = safeJsonParse(body, {});
  const updateVisual = (next: unknown) => setBody(jsonPretty(next || {}));
  return <div className="panel settings-card"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-slate-800">{title}</h3><p className="mt-1 text-xs leading-5 text-slate-400">{description}</p><code className="mt-2 inline-block rounded-lg bg-slate-100 px-2 py-1 text-[11px] text-slate-500">{endpoint}</code></div><button className="icon-btn compact" onClick={load}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Edit3 size={16} />}</button></div>{open && <Modal title={title} onClose={() => setOpen(false)} wide><div className="settings-editor-toolbar"><div><strong>{t('编辑方式', 'Editor mode')}</strong><span>{t('普通字段可直接点选，复杂配置仍可切到 JSON。', 'Edit common fields directly; switch to JSON for advanced config.')}</span></div><div className="settings-editor-tabs"><button type="button" className={editorMode === 'visual' ? 'active' : ''} onClick={() => setEditorMode('visual')}>{t('可视化表单', 'Visual form')}</button><button type="button" className={editorMode === 'json' ? 'active' : ''} onClick={() => setEditorMode('json')}>JSON</button></div></div>{editorMode === 'visual' ? <JsonVisualEditor value={parsedBody} onChange={updateVisual} /> : <textarea className="code-area h-[50vh]" value={body} onChange={(e) => setBody(e.target.value)} />}<div className="mt-5 flex justify-end gap-3">{testEndpoint && <button className="btn-secondary" onClick={async () => { await request(testEndpoint, { method: 'POST', body: safeJsonParse(body, {}) }); notify('success', t('测试请求已发送', 'Test request sent')); }}><Webhook size={16} /> {t('测试', 'Test')}</button>}<button className="btn-primary" onClick={save}><Save size={16} /> {t('保存', 'Save')}</button></div></Modal>}</div>;
}

export function SettingsView({ request, notify }: { request: Requester; notify: Notify }) {
  const { t } = useSettingsLocale();
  const cards = [
    [t('账户设置 JSON', 'Account settings JSON'), t('账户规则的完整 JSON 高级编辑入口。', 'Full JSON editor for account rules.'), '/admin/account_settings'],
    [t('用户设置', 'User settings'), t('注册、登录、验证码、默认角色与用户邮箱策略。', 'Registration, login, verification codes, default roles, and user mailbox policy.'), '/admin/user_settings'],
    [t('OAuth2 设置', 'OAuth2 settings'), t('第三方登录配置。', 'Third-party login configuration.'), '/admin/user_oauth2_settings'],
    [t('全局 Webhook', 'Global Webhook'), t('管理员控制的 Webhook allow list 和推送规则。', 'Admin-controlled webhook allow list and push rules.'), '/admin/webhook/settings'],
    [t('管理员邮件 Webhook', 'Admin mail Webhook'), t('管理员级邮件通知 Webhook。', 'Admin-level mail notification webhook.'), '/admin/mail_webhook/settings', '/admin/mail_webhook/test'],
    [t('IP / ASN / 指纹黑名单', 'IP / ASN / fingerprint blacklist'), t('请求来源限制和每日限制策略。', 'Request-origin restrictions and daily limit policy.'), '/admin/ip_blacklist/settings'],
    [t('AI 提取设置', 'AI extraction settings'), t('邮件信息提取 Agent 设置。', 'Mail information extraction agent settings.'), '/admin/ai_extract/settings'],
    [t('Telegram 设置 JSON', 'Telegram settings JSON'), t('Telegram Bot / Mini App 集成配置；初始化和状态见下方专用面板。', 'Telegram Bot / Mini App integration config; initialization and status are below.'), '/admin/telegram/settings'],
  ] as const;
  return <div className="h-full overflow-y-auto p-3 md:p-4 xl:p-6"><div className="space-y-3"><div><h2 className="text-2xl font-bold text-slate-800">{t('系统设置', 'System settings')}</h2><p className="mt-1 text-sm text-slate-400">{t('常用项支持可视化表单编辑；复杂字段仍保留 JSON 高级模式。', 'Common settings support visual form editing; complex fields still keep advanced JSON mode.')}</p></div><div className="grid gap-2.5 xl:grid-cols-2"><RoleAddressConfigPanel request={request} notify={notify} /><MailRefreshPreferenceCard notify={notify} /><FrontendLoginBaseCard notify={notify} /><AccountRulesPanel request={request} notify={notify} /><TelegramPanel request={request} notify={notify} />{cards.map(([title, desc, endpoint, test]) => <GenericSettingsCard key={endpoint} title={title} description={desc} endpoint={endpoint} request={request} notify={notify} testEndpoint={test} />)}</div></div></div>;
}

type AccountSettingsState = {
  blockList: string[];
  sendBlockList: string[];
  noLimitSendAddressList: string[];
  verifiedAddressList: string[];
  fromBlockList: string[];
  blockReceiveUnknowAddressEmail: boolean;
  subdomainMode: 'follow_env' | 'force_enable' | 'force_disable';
  dailyEnabled: boolean;
  monthlyEnabled: boolean;
  dailyLimit: number;
  monthlyLimit: number;
  raw?: any;
};

const defaultAccountSettings: AccountSettingsState = {
  blockList: [],
  sendBlockList: [],
  noLimitSendAddressList: [],
  verifiedAddressList: [],
  fromBlockList: [],
  blockReceiveUnknowAddressEmail: false,
  subdomainMode: 'follow_env',
  dailyEnabled: false,
  monthlyEnabled: false,
  dailyLimit: 100,
  monthlyLimit: 3000,
};

function toLineText(values: string[]): string {
  return values.filter(Boolean).join('\n');
}

function fromLineText(value: string): string[] {
  return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

function modeFromStored(value: unknown): AccountSettingsState['subdomainMode'] {
  if (value === true) return 'force_enable';
  if (value === false) return 'force_disable';
  return 'follow_env';
}

function storedFromMode(mode: AccountSettingsState['subdomainMode']): boolean | null {
  if (mode === 'force_enable') return true;
  if (mode === 'force_disable') return false;
  return null;
}

function AccountRulesPanel({ request, notify }: { request: Requester; notify: Notify }) {
  const { t } = useSettingsLocale();
  const [state, setState] = useState<AccountSettingsState>(defaultAccountSettings);
  const [loading, setLoading] = useState(false);
  const setList = (key: keyof Pick<AccountSettingsState, 'blockList' | 'sendBlockList' | 'noLimitSendAddressList' | 'verifiedAddressList' | 'fromBlockList'>, value: string) => setState((current) => ({ ...current, [key]: fromLineText(value) }));
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await request('/admin/account_settings');
      const sendLimit = res?.sendMailLimitConfig || {};
      setState({
        blockList: res?.blockList || [],
        sendBlockList: res?.sendBlockList || [],
        noLimitSendAddressList: res?.noLimitSendAddressList || [],
        verifiedAddressList: res?.verifiedAddressList || [],
        fromBlockList: res?.fromBlockList || [],
        blockReceiveUnknowAddressEmail: Boolean(res?.emailRuleSettings?.blockReceiveUnknowAddressEmail),
        subdomainMode: modeFromStored(res?.addressCreationSubdomainMatchStatus?.storedEnabled),
        dailyEnabled: Boolean(sendLimit.dailyEnabled),
        monthlyEnabled: Boolean(sendLimit.monthlyEnabled),
        dailyLimit: Number(sendLimit.dailyLimit ?? 100),
        monthlyLimit: Number(sendLimit.monthlyLimit ?? 3000),
        raw: res || {},
      });
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('账户规则加载失败', 'Failed to load account rules'));
    } finally {
      setLoading(false);
    }
  }, [notify, request]);
  useEffect(() => { load(); }, [load]);
  const save = async () => {
    try {
      const raw = state.raw || {};
      await request('/admin/account_settings', {
        method: 'POST',
        body: {
          ...raw,
          blockList: state.blockList,
          sendBlockList: state.sendBlockList,
          noLimitSendAddressList: state.noLimitSendAddressList,
          verifiedAddressList: state.verifiedAddressList,
          fromBlockList: state.fromBlockList,
          emailRuleSettings: {
            ...(raw.emailRuleSettings || {}),
            blockReceiveUnknowAddressEmail: state.blockReceiveUnknowAddressEmail,
          },
          addressCreationSettings: {
            ...(raw.addressCreationSettings || {}),
            enableSubdomainMatch: storedFromMode(state.subdomainMode),
          },
          sendMailLimitConfig: {
            dailyEnabled: state.dailyEnabled,
            monthlyEnabled: state.monthlyEnabled,
            dailyLimit: state.dailyEnabled ? Number(state.dailyLimit) : null,
            monthlyLimit: state.monthlyEnabled ? Number(state.monthlyLimit) : null,
          },
        },
      });
      notify('success', t('账户规则已保存', 'Account rules saved'));
      await load();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('账户规则保存失败', 'Failed to save account rules'));
    }
  };
  return <div className="panel settings-card compact-settings xl:col-span-2">
    <div className="settings-card-head">
      <div><h3 className="font-semibold text-slate-800"><ShieldCheck className="mr-2 inline h-4 w-4 text-slate-600" />{t('账户规则设置', 'Account rules')}</h3><p className="panel-subtitle">{t('黑名单、发信额度、未知地址拦截、子域名匹配。', 'Blacklists, sending quota, unknown-address blocking, and subdomain matching.')}</p></div>
      <button className="icon-btn compact" onClick={load}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw size={16} />}</button>
    </div>
    <div className="mt-3 grid gap-3 lg:grid-cols-5">
      <label className="lg:col-span-1"><span className="form-label">{t('地址黑名单', 'Address blacklist')}</span><textarea className="form-textarea compact-textarea" value={toLineText(state.blockList)} onChange={(e) => setList('blockList', e.target.value)} placeholder={t('每行一个', 'One per line')} /></label>
      <label className="lg:col-span-1"><span className="form-label">{t('发件黑名单', 'Sender blacklist')}</span><textarea className="form-textarea compact-textarea" value={toLineText(state.sendBlockList)} onChange={(e) => setList('sendBlockList', e.target.value)} placeholder={t('每行一个', 'One per line')} /></label>
      <label className="lg:col-span-1"><span className="form-label">{t('免限制发件', 'Unlimited senders')}</span><textarea className="form-textarea compact-textarea" value={toLineText(state.noLimitSendAddressList)} onChange={(e) => setList('noLimitSendAddressList', e.target.value)} placeholder={t('每行一个', 'One per line')} /></label>
      <label className="lg:col-span-1"><span className="form-label">{t('验证地址', 'Verified addresses')}</span><textarea className="form-textarea compact-textarea" value={toLineText(state.verifiedAddressList)} onChange={(e) => setList('verifiedAddressList', e.target.value)} placeholder={t('每行一个', 'One per line')} /></label>
      <label className="lg:col-span-1"><span className="form-label">{t('来源黑名单', 'From blacklist')}</span><textarea className="form-textarea compact-textarea" value={toLineText(state.fromBlockList)} onChange={(e) => setList('fromBlockList', e.target.value)} placeholder={t('每行一个', 'One per line')} /></label>
    </div>
    <div className="mt-3 grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
      <label className="check-row rounded-xl bg-slate-50 px-3 py-2"><input type="checkbox" checked={state.blockReceiveUnknowAddressEmail} onChange={(e) => setState((current) => ({ ...current, blockReceiveUnknowAddressEmail: e.target.checked }))} />{t('拦截未知地址收件', 'Block unknown-address inbound mail')}</label>
      <div><label className="form-label">{t('子域名匹配', 'Subdomain matching')}</label><select className="form-select compact-control" value={state.subdomainMode} onChange={(e) => setState((current) => ({ ...current, subdomainMode: e.target.value as AccountSettingsState['subdomainMode'] }))}><option value="follow_env">{t('跟随环境变量', 'Follow environment')}</option><option value="force_enable">{t('强制开启', 'Force on')}</option><option value="force_disable">{t('强制关闭', 'Force off')}</option></select></div>
      <div className="grid grid-cols-2 gap-2">
        <label><span className="form-label">{t('日额度', 'Daily limit')}</span><input className="form-input compact-control" type="number" disabled={!state.dailyEnabled} value={state.dailyLimit} onChange={(e) => setState((current) => ({ ...current, dailyLimit: Number(e.target.value) }))} /></label>
        <label><span className="form-label">{t('月额度', 'Monthly limit')}</span><input className="form-input compact-control" type="number" disabled={!state.monthlyEnabled} value={state.monthlyLimit} onChange={(e) => setState((current) => ({ ...current, monthlyLimit: Number(e.target.value) }))} /></label>
      </div>
      <div className="flex flex-wrap gap-2 md:justify-end">
        <label className="check-row text-xs"><input type="checkbox" checked={state.dailyEnabled} onChange={(e) => setState((current) => ({ ...current, dailyEnabled: e.target.checked }))} />{t('日', 'Daily')}</label>
        <label className="check-row text-xs"><input type="checkbox" checked={state.monthlyEnabled} onChange={(e) => setState((current) => ({ ...current, monthlyEnabled: e.target.checked }))} />{t('月', 'Monthly')}</label>
        <button className="btn-primary compact" onClick={save}><Save size={15} /> {t('保存', 'Save')}</button>
      </div>
    </div>
  </div>;
}

function MailRefreshPreferenceCard({ notify }: { notify: Notify }) {
  const { t } = useSettingsLocale();
  const [enabled, setEnabled] = useState(() => readStorage(STORAGE_KEYS.mailAutoRefreshEnabled, 'true') !== 'false');
  const [seconds, setSeconds] = useState(() => Math.max(15, Number(readStorage(STORAGE_KEYS.mailAutoRefreshSeconds, '60')) || 60));
  const save = () => {
    const normalizedSeconds = Math.max(15, Number(seconds) || 60);
    writeLocalStorage(STORAGE_KEYS.mailAutoRefreshEnabled, enabled ? 'true' : 'false');
    writeLocalStorage(STORAGE_KEYS.mailAutoRefreshSeconds, String(normalizedSeconds));
    setSeconds(normalizedSeconds);
    window.dispatchEvent(new Event('loven7-mail-refresh-settings'));
    notify('success', t('邮件自动刷新设置已保存', 'Mail auto-refresh settings saved'));
  };
  return <div className="panel settings-card"><div className="settings-card-head"><div><h3 className="font-semibold text-slate-800"><RefreshCw className="mr-2 inline h-4 w-4 text-slate-600" />{t('邮件自动刷新', 'Mail auto refresh')}</h3><p className="panel-subtitle">{t('后台增量轮询，列表不闪白。', 'Incremental background polling without list flicker.')}</p></div></div><div className="mt-3 grid gap-2 sm:grid-cols-[1fr_96px_auto]"><label className="check-row rounded-xl bg-slate-50 px-3 py-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{t('启用', 'Enabled')}</label><input className="form-input compact-control" type="number" min={15} value={seconds} onChange={(e) => setSeconds(Math.max(15, Number(e.target.value) || 60))} /><button className="btn-primary compact" onClick={save}><Save size={15} /> {t('保存', 'Save')}</button></div></div>;
}

function FrontendLoginBaseCard({ notify }: { notify: Notify }) {
  const { t } = useSettingsLocale();
  const defaultBase = FRONTEND_LOGIN_BASE || (typeof window !== 'undefined' ? window.location.origin : '');
  const [value, setValue] = useState(() => readStorage(STORAGE_KEYS.frontendLoginBase, defaultBase));
  const normalized = (value || defaultBase).trim().replace(/\/$/, '');
  const save = () => {
    writeLocalStorage(STORAGE_KEYS.frontendLoginBase, normalized);
    setValue(normalized);
    notify('success', t('前端登录链接前缀已保存', 'Frontend login link prefix saved'));
  };
  return <div className="panel settings-card"><div className="settings-card-head"><div><h3 className="font-semibold text-slate-800"><Link className="mr-2 inline h-4 w-4 text-slate-600" />{t('前端登录链接前缀', 'Frontend login link prefix')}</h3><p className="panel-subtitle">{t('用于', 'Used for')} <code>/?JWT=</code>{t(' 登录链接。', ' login links.')}</p></div></div><div className="mt-3 flex flex-col gap-2 sm:flex-row"><input className="form-input compact-control" value={value} onChange={(e) => setValue(e.target.value)} placeholder={defaultBase || 'https://your-frontend.example.com'} /><button className="btn-primary compact shrink-0" onClick={save}><Save size={15} /> {t('保存', 'Save')}</button></div><p className="mt-2 truncate rounded-xl bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">{t('示例：', 'Example: ')}{normalized || defaultBase}/?JWT=...</p></div>;
}

function RoleAddressConfigPanel({ request, notify }: { request: Requester; notify: Notify }) {
  const { t } = useSettingsLocale();
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [values, setValues] = useState<Record<string, number | ''>>({});
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [roleRes, configRes] = await Promise.all([
        request<RoleRecord[]>('/admin/user_roles'),
        request<RoleAddressConfigResponse>('/admin/role_address_config').catch(() => ({ configs: {} })),
      ]);
      const list = Array.isArray(roleRes) ? roleRes : [];
      setRoles(list);
      const next: Record<string, number | ''> = {};
      list.forEach((role) => {
        const value = configRes.configs?.[role.role]?.maxAddressCount;
        next[role.role] = typeof value === 'number' ? value : '';
      });
      setValues(next);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('角色地址额度加载失败', 'Failed to load role address quotas'));
    } finally {
      setLoading(false);
    }
  }, [notify, request]);
  useEffect(() => { load(); }, [load]);
  const save = async () => {
    try {
      const configs: RoleAddressConfigResponse['configs'] = {};
      Object.entries(values).forEach(([role, value]) => { if (value !== '') configs[role] = { maxAddressCount: Number(value) }; });
      await request('/admin/role_address_config', { method: 'POST', body: { configs } });
      notify('success', t('角色地址额度已保存', 'Role address quotas saved'));
      await load();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('保存失败', 'Save failed'));
    }
  };
  return <div className="panel settings-card"><div className="settings-card-head"><div><h3 className="font-semibold text-slate-800"><ShieldCheck className="mr-2 inline h-4 w-4 text-slate-600" />{t('角色地址额度', 'Role address quotas')}</h3><p className="panel-subtitle">{t('限制不同用户角色可创建的邮箱数量。', 'Limit how many mailbox addresses each user role can create.')}</p></div><button className="icon-btn compact" onClick={load}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw size={16} />}</button></div>{loading ? <LoadingState /> : roles.length === 0 ? <EmptyState icon={ShieldCheck} title={t('暂无角色', 'No roles')}  body={t('请先在 Worker 环境中配置用户角色。', 'Configure user roles in the Worker environment first.')}  /> : <div className="mt-3 space-y-1.5">{roles.map((role) => <div key={role.role} className="grid grid-cols-[minmax(0,1fr)_88px] items-center gap-2 rounded-xl bg-slate-50 px-2.5 py-1.5"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-700">{role.label || role.role}</p><p className="truncate text-[11px] text-slate-400">{role.role}</p></div><input className="form-input compact-control h-8 w-[5.5rem] px-2 py-1 text-right" type="number" min={0} max={999} value={values[role.role] ?? ''} placeholder={t('不限', 'Unlimited')} onChange={(e) => setValues((current) => ({ ...current, [role.role]: e.target.value === '' ? '' : Number(e.target.value) }))} /></div>)}<button className="btn-primary compact mt-2 w-full" onClick={save}><Save size={15} /> {t('保存额度', 'Save quotas')}</button></div>}</div>;
}

function TelegramPanel({ request, notify }: { request: Requester; notify: Notify }) {
  const { t } = useSettingsLocale();
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchStatus = async () => {
    setLoading(true);
    try {
      const res = await request<TelegramStatus>('/admin/telegram/status');
      setStatus({ ...res, fetched: true });
      notify('success', t('Telegram 状态已刷新', 'Telegram status refreshed'));
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('Telegram 状态获取失败', 'Failed to fetch Telegram status'));
    } finally {
      setLoading(false);
    }
  };
  const init = async () => {
    setLoading(true);
    try {
      await request('/admin/telegram/init', { method: 'POST' });
      notify('success', t('Telegram webhook 初始化完成', 'Telegram webhook initialized'));
      await fetchStatus();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('Telegram 初始化失败', 'Telegram initialization failed'));
      setLoading(false);
    }
  };
  return <div className="panel settings-card"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-slate-800"><Bot className="mr-2 inline h-4 w-4 text-slate-600" />{t('Telegram 运维', 'Telegram operations')}</h3><p className="panel-subtitle">{t('初始化 Bot webhook 并查看状态。', 'Initialize the bot webhook and inspect status.')}</p></div>{loading && <Loader2 className="h-5 w-5 animate-spin text-slate-600" />}</div><div className="mt-3 flex flex-wrap gap-2"><button className="btn-secondary compact" onClick={fetchStatus}><RefreshCw size={15} /> {t('状态', 'Status')}</button><button className="btn-primary compact" onClick={init}><Bot size={15} /> {t('初始化', 'Initialize')}</button></div>{status && <pre className="code-area mt-3 max-h-72">{jsonPretty(status)}</pre>}</div>;
}

export function MaintenanceView({ request, notify }: { request: Requester; notify: Notify }) {
  const { t } = useSettingsLocale();
  const [db, setDb] = useState<any>(null);
  const [workerConfig, setWorkerConfig] = useState<any>(null);
  const [cleanDays, setCleanDays] = useState(30);
  const [cleanType, setCleanType] = useState('raw_mails');
  const load = useCallback(async () => { try { const [dbRes, workerRes] = await Promise.all([request('/admin/db_version').catch((e) => ({ error: String(e) })), request('/admin/worker/configs').catch((e) => ({ error: String(e) }))]); setDb(dbRes); setWorkerConfig(workerRes); } catch (error) { notify('error', error instanceof Error ? error.message : t('维护信息加载失败', 'Failed to load maintenance info')); } }, [notify, request]);
  useEffect(() => { load(); }, [load]);
  const action = async (path: string, body?: unknown) => { try { await request(path, { method: 'POST', body }); notify('success', t('操作完成', 'Operation completed')); await load(); } catch (error) { notify('error', error instanceof Error ? error.message : t('操作失败', 'Operation failed')); } };
  return <div className="h-full overflow-y-auto p-4 md:p-8"><div className="space-y-5"><div className="flex items-center justify-between"><div><h2 className="text-2xl font-bold text-slate-800">{t('维护', 'Maintenance')}</h2><p className="mt-1 text-sm text-slate-400">{t('数据库版本、初始化、迁移、清理和 Worker 配置只读查看。', 'View database version, initialization, migrations, cleanup, and Worker config.')}</p></div><button className="btn-secondary" onClick={load}><RefreshCw size={16} /> {t('刷新', 'Refresh')}</button></div><div className="grid gap-5 xl:grid-cols-2"><div className="panel p-5"><h3 className="panel-title"><Database className="mr-2 inline h-5 w-5 text-slate-600" />{t('数据库', 'Database')}</h3><pre className="code-area mt-4 max-h-80">{jsonPretty(db)}</pre><div className="mt-4 flex flex-wrap gap-3"><button className="btn-secondary" onClick={() => action('/admin/db_initialize')}><HardDrive size={16} /> {t('初始化', 'Initialize')}</button><button className="btn-secondary" onClick={() => action('/admin/db_migration')}><Database size={16} /> {t('迁移', 'Migrate')}</button></div></div><div className="panel p-5"><h3 className="panel-title"><Cloud className="mr-2 inline h-5 w-5 text-slate-600" />{t('Worker 配置', 'Worker config')}</h3><pre className="code-area mt-4 max-h-80">{jsonPretty(workerConfig)}</pre></div><div className="panel p-5 xl:col-span-2"><h3 className="panel-title">{t('清理任务', 'Cleanup task')}</h3><div className="mt-4 grid gap-3 md:grid-cols-[1fr_160px_auto]"><select className="form-select" value={cleanType} onChange={(e) => setCleanType(e.target.value)}><option value="raw_mails">{t('收件 raw_mails', 'Inbox raw_mails')}</option><option value="sendbox">{t('发件 sendbox', 'Sent sendbox')}</option><option value="address">{t('地址 address', 'Address table')}</option><option value="custom_sql">{t('自定义 SQL 配置', 'Custom SQL config')}</option></select><input className="form-input" type="number" value={cleanDays} onChange={(e) => setCleanDays(Number(e.target.value))} /><button className="btn-danger" onClick={() => action('/admin/cleanup', { cleanType, cleanDays })}><Trash2 size={16} /> {t('执行清理', 'Run cleanup')}</button></div><div className="mt-5"><GenericSettingsCard title={t('自动清理配置', 'Auto cleanup config')} description={t('读取并保存 /admin/auto_cleanup 配置。', 'Read and save /admin/auto_cleanup config.')} endpoint="/admin/auto_cleanup" request={request} notify={notify} /></div></div></div></div></div>;
}


