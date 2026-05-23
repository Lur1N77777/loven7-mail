import { useCallback, useEffect, useState } from 'react';
import { Bot, Cloud, Database, Edit3, HardDrive, Link, Loader2, RefreshCw, Save, ShieldCheck, Trash2, Webhook } from 'lucide-react';
import type { Requester } from '../lib/api';
import { jsonPretty, safeJsonParse } from '../lib/format';
import { FRONTEND_LOGIN_BASE, STORAGE_KEYS } from '../lib/constants';
import { readStorage, writeLocalStorage } from '../lib/storage';
import type { RoleAddressConfigResponse, RoleRecord, TelegramStatus } from '../types/api';
import { EmptyState, LoadingState, Modal, type Notify } from '../components/Common';

function GenericSettingsCard({ title, description, endpoint, request, notify, testEndpoint }: { title: string; description: string; endpoint: string; request: Requester; notify: Notify; testEndpoint?: string; key?: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [body, setBody] = useState('{}');
  const load = async () => { setLoading(true); try { const res = await request(endpoint); setBody(jsonPretty(res || {})); setOpen(true); } catch (error) { notify('error', error instanceof Error ? error.message : `${title} 加载失败`); } finally { setLoading(false); } };
  const save = async () => { try { const parsed = JSON.parse(body || '{}'); await request(endpoint, { method: 'POST', body: parsed }); notify('success', `${title} 已保存`); } catch (error) { notify('error', error instanceof Error ? error.message : `${title} 保存失败`); } };
  return <div className="panel settings-card"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-slate-800">{title}</h3><p className="mt-1 text-xs leading-5 text-slate-400">{description}</p><code className="mt-2 inline-block rounded-lg bg-slate-100 px-2 py-1 text-[11px] text-slate-500">{endpoint}</code></div><button className="icon-btn compact" onClick={load}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Edit3 size={16} />}</button></div>{open && <Modal title={title} onClose={() => setOpen(false)} wide><textarea className="code-area h-[50vh]" value={body} onChange={(e) => setBody(e.target.value)} /><div className="mt-5 flex justify-end gap-3">{testEndpoint && <button className="btn-secondary" onClick={async () => { await request(testEndpoint, { method: 'POST', body: safeJsonParse(body, {}) }); notify('success', '测试请求已发送'); }}><Webhook size={16} /> 测试</button>}<button className="btn-primary" onClick={save}><Save size={16} /> 保存</button></div></Modal>}</div>;
}

export function SettingsView({ request, notify }: { request: Requester; notify: Notify }) {
  const cards = [
    ['账户设置 JSON', '账户规则的完整 JSON 高级编辑入口。', '/admin/account_settings'],
    ['用户设置', '注册、登录、验证码、默认角色与用户邮箱策略。', '/admin/user_settings'],
    ['OAuth2 设置', '第三方登录配置。', '/admin/user_oauth2_settings'],
    ['全局 Webhook', '管理员控制的 Webhook allow list 和推送规则。', '/admin/webhook/settings'],
    ['管理员邮件 Webhook', '管理员级邮件通知 Webhook。', '/admin/mail_webhook/settings', '/admin/mail_webhook/test'],
    ['IP / ASN / 指纹黑名单', '请求来源限制和每日限制策略。', '/admin/ip_blacklist/settings'],
    ['AI 提取设置', '邮件信息提取 Agent 设置。', '/admin/ai_extract/settings'],
    ['Telegram 设置 JSON', 'Telegram Bot / Mini App 集成配置；初始化和状态见下方专用面板。', '/admin/telegram/settings'],
  ] as const;
  return <div className="h-full overflow-y-auto p-3 md:p-4 xl:p-6"><div className="space-y-3"><div><h2 className="text-2xl font-bold text-slate-800">系统设置</h2><p className="mt-1 text-sm text-slate-400">常用项改为紧凑设置，高级 JSON 仍保留。</p></div><div className="grid gap-2.5 xl:grid-cols-2"><RoleAddressConfigPanel request={request} notify={notify} /><MailRefreshPreferenceCard notify={notify} /><FrontendLoginBaseCard notify={notify} /><AccountRulesPanel request={request} notify={notify} /><TelegramPanel request={request} notify={notify} />{cards.map(([title, desc, endpoint, test]) => <GenericSettingsCard key={endpoint} title={title} description={desc} endpoint={endpoint} request={request} notify={notify} testEndpoint={test} />)}</div></div></div>;
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
      notify('error', error instanceof Error ? error.message : '账户规则加载失败');
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
      notify('success', '账户规则已保存');
      await load();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '账户规则保存失败');
    }
  };
  return <div className="panel settings-card compact-settings xl:col-span-2">
    <div className="settings-card-head">
      <div><h3 className="font-semibold text-slate-800"><ShieldCheck className="mr-2 inline h-4 w-4 text-slate-600" />账户规则设置</h3><p className="panel-subtitle">黑名单、发信额度、未知地址拦截、子域名匹配。</p></div>
      <button className="icon-btn compact" onClick={load}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw size={16} />}</button>
    </div>
    <div className="mt-3 grid gap-3 lg:grid-cols-5">
      <label className="lg:col-span-1"><span className="form-label">地址黑名单</span><textarea className="form-textarea compact-textarea" value={toLineText(state.blockList)} onChange={(e) => setList('blockList', e.target.value)} placeholder="每行一个" /></label>
      <label className="lg:col-span-1"><span className="form-label">发件黑名单</span><textarea className="form-textarea compact-textarea" value={toLineText(state.sendBlockList)} onChange={(e) => setList('sendBlockList', e.target.value)} placeholder="每行一个" /></label>
      <label className="lg:col-span-1"><span className="form-label">免限制发件</span><textarea className="form-textarea compact-textarea" value={toLineText(state.noLimitSendAddressList)} onChange={(e) => setList('noLimitSendAddressList', e.target.value)} placeholder="每行一个" /></label>
      <label className="lg:col-span-1"><span className="form-label">验证地址</span><textarea className="form-textarea compact-textarea" value={toLineText(state.verifiedAddressList)} onChange={(e) => setList('verifiedAddressList', e.target.value)} placeholder="每行一个" /></label>
      <label className="lg:col-span-1"><span className="form-label">来源黑名单</span><textarea className="form-textarea compact-textarea" value={toLineText(state.fromBlockList)} onChange={(e) => setList('fromBlockList', e.target.value)} placeholder="每行一个" /></label>
    </div>
    <div className="mt-3 grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
      <label className="check-row rounded-xl bg-slate-50 px-3 py-2"><input type="checkbox" checked={state.blockReceiveUnknowAddressEmail} onChange={(e) => setState((current) => ({ ...current, blockReceiveUnknowAddressEmail: e.target.checked }))} />拦截未知地址收件</label>
      <div><label className="form-label">子域名匹配</label><select className="form-select compact-control" value={state.subdomainMode} onChange={(e) => setState((current) => ({ ...current, subdomainMode: e.target.value as AccountSettingsState['subdomainMode'] }))}><option value="follow_env">跟随环境变量</option><option value="force_enable">强制开启</option><option value="force_disable">强制关闭</option></select></div>
      <div className="grid grid-cols-2 gap-2">
        <label><span className="form-label">日额度</span><input className="form-input compact-control" type="number" disabled={!state.dailyEnabled} value={state.dailyLimit} onChange={(e) => setState((current) => ({ ...current, dailyLimit: Number(e.target.value) }))} /></label>
        <label><span className="form-label">月额度</span><input className="form-input compact-control" type="number" disabled={!state.monthlyEnabled} value={state.monthlyLimit} onChange={(e) => setState((current) => ({ ...current, monthlyLimit: Number(e.target.value) }))} /></label>
      </div>
      <div className="flex flex-wrap gap-2 md:justify-end">
        <label className="check-row text-xs"><input type="checkbox" checked={state.dailyEnabled} onChange={(e) => setState((current) => ({ ...current, dailyEnabled: e.target.checked }))} />日</label>
        <label className="check-row text-xs"><input type="checkbox" checked={state.monthlyEnabled} onChange={(e) => setState((current) => ({ ...current, monthlyEnabled: e.target.checked }))} />月</label>
        <button className="btn-primary compact" onClick={save}><Save size={15} /> 保存</button>
      </div>
    </div>
  </div>;
}

function MailRefreshPreferenceCard({ notify }: { notify: Notify }) {
  const [enabled, setEnabled] = useState(() => readStorage(STORAGE_KEYS.mailAutoRefreshEnabled, 'true') !== 'false');
  const [seconds, setSeconds] = useState(() => Math.max(15, Number(readStorage(STORAGE_KEYS.mailAutoRefreshSeconds, '60')) || 60));
  const save = () => {
    const normalizedSeconds = Math.max(15, Number(seconds) || 60);
    writeLocalStorage(STORAGE_KEYS.mailAutoRefreshEnabled, enabled ? 'true' : 'false');
    writeLocalStorage(STORAGE_KEYS.mailAutoRefreshSeconds, String(normalizedSeconds));
    setSeconds(normalizedSeconds);
    window.dispatchEvent(new Event('loven7-mail-refresh-settings'));
    notify('success', '邮件自动刷新设置已保存');
  };
  return <div className="panel settings-card"><div className="settings-card-head"><div><h3 className="font-semibold text-slate-800"><RefreshCw className="mr-2 inline h-4 w-4 text-slate-600" />邮件自动刷新</h3><p className="panel-subtitle">后台增量轮询，列表不闪白。</p></div></div><div className="mt-3 grid gap-2 sm:grid-cols-[1fr_96px_auto]"><label className="check-row rounded-xl bg-slate-50 px-3 py-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />启用</label><input className="form-input compact-control" type="number" min={15} value={seconds} onChange={(e) => setSeconds(Math.max(15, Number(e.target.value) || 60))} /><button className="btn-primary compact" onClick={save}><Save size={15} /> 保存</button></div></div>;
}

function FrontendLoginBaseCard({ notify }: { notify: Notify }) {
  const defaultBase = FRONTEND_LOGIN_BASE || (typeof window !== 'undefined' ? window.location.origin : '');
  const [value, setValue] = useState(() => readStorage(STORAGE_KEYS.frontendLoginBase, defaultBase));
  const normalized = (value || defaultBase).trim().replace(/\/$/, '');
  const save = () => {
    writeLocalStorage(STORAGE_KEYS.frontendLoginBase, normalized);
    setValue(normalized);
    notify('success', '前端登录链接前缀已保存');
  };
  return <div className="panel settings-card"><div className="settings-card-head"><div><h3 className="font-semibold text-slate-800"><Link className="mr-2 inline h-4 w-4 text-slate-600" />前端登录链接前缀</h3><p className="panel-subtitle">用于 <code>/?JWT=</code> 登录链接。</p></div></div><div className="mt-3 flex flex-col gap-2 sm:flex-row"><input className="form-input compact-control" value={value} onChange={(e) => setValue(e.target.value)} placeholder={defaultBase || 'https://your-frontend.example.com'} /><button className="btn-primary compact shrink-0" onClick={save}><Save size={15} /> 保存</button></div><p className="mt-2 truncate rounded-xl bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">示例：{normalized || defaultBase}/?JWT=...</p></div>;
}

function RoleAddressConfigPanel({ request, notify }: { request: Requester; notify: Notify }) {
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
      notify('error', error instanceof Error ? error.message : '角色地址额度加载失败');
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
      notify('success', '角色地址额度已保存');
      await load();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '保存失败');
    }
  };
  return <div className="panel settings-card"><div className="settings-card-head"><div><h3 className="font-semibold text-slate-800"><ShieldCheck className="mr-2 inline h-4 w-4 text-slate-600" />角色地址额度</h3><p className="panel-subtitle">限制不同用户角色可创建的邮箱数量。</p></div><button className="icon-btn compact" onClick={load}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw size={16} />}</button></div>{loading ? <LoadingState /> : roles.length === 0 ? <EmptyState icon={ShieldCheck} title="暂无角色" body="请先在 Worker 环境中配置用户角色。" /> : <div className="mt-3 space-y-1.5">{roles.map((role) => <div key={role.role} className="grid grid-cols-[minmax(0,1fr)_88px] items-center gap-2 rounded-xl bg-slate-50 px-2.5 py-1.5"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-700">{role.label || role.role}</p><p className="truncate text-[11px] text-slate-400">{role.role}</p></div><input className="form-input compact-control h-8 w-[5.5rem] px-2 py-1 text-right" type="number" min={0} max={999} value={values[role.role] ?? ''} placeholder="不限" onChange={(e) => setValues((current) => ({ ...current, [role.role]: e.target.value === '' ? '' : Number(e.target.value) }))} /></div>)}<button className="btn-primary compact mt-2 w-full" onClick={save}><Save size={15} /> 保存额度</button></div>}</div>;
}

function TelegramPanel({ request, notify }: { request: Requester; notify: Notify }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchStatus = async () => {
    setLoading(true);
    try {
      const res = await request<TelegramStatus>('/admin/telegram/status');
      setStatus({ ...res, fetched: true });
      notify('success', 'Telegram 状态已刷新');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Telegram 状态获取失败');
    } finally {
      setLoading(false);
    }
  };
  const init = async () => {
    setLoading(true);
    try {
      await request('/admin/telegram/init', { method: 'POST' });
      notify('success', 'Telegram webhook 初始化完成');
      await fetchStatus();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Telegram 初始化失败');
      setLoading(false);
    }
  };
  return <div className="panel settings-card"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-slate-800"><Bot className="mr-2 inline h-4 w-4 text-slate-600" />Telegram 运维</h3><p className="panel-subtitle">初始化 Bot webhook 并查看状态。</p></div>{loading && <Loader2 className="h-5 w-5 animate-spin text-slate-600" />}</div><div className="mt-3 flex flex-wrap gap-2"><button className="btn-secondary compact" onClick={fetchStatus}><RefreshCw size={15} /> 状态</button><button className="btn-primary compact" onClick={init}><Bot size={15} /> 初始化</button></div>{status && <pre className="code-area mt-3 max-h-72">{jsonPretty(status)}</pre>}</div>;
}

export function MaintenanceView({ request, notify }: { request: Requester; notify: Notify }) {
  const [db, setDb] = useState<any>(null);
  const [workerConfig, setWorkerConfig] = useState<any>(null);
  const [cleanDays, setCleanDays] = useState(30);
  const [cleanType, setCleanType] = useState('raw_mails');
  const load = useCallback(async () => { try { const [dbRes, workerRes] = await Promise.all([request('/admin/db_version').catch((e) => ({ error: String(e) })), request('/admin/worker/configs').catch((e) => ({ error: String(e) }))]); setDb(dbRes); setWorkerConfig(workerRes); } catch (error) { notify('error', error instanceof Error ? error.message : '维护信息加载失败'); } }, [notify, request]);
  useEffect(() => { load(); }, [load]);
  const action = async (path: string, body?: unknown) => { try { await request(path, { method: 'POST', body }); notify('success', '操作完成'); await load(); } catch (error) { notify('error', error instanceof Error ? error.message : '操作失败'); } };
  return <div className="h-full overflow-y-auto p-4 md:p-8"><div className="space-y-5"><div className="flex items-center justify-between"><div><h2 className="text-2xl font-bold text-slate-800">维护</h2><p className="mt-1 text-sm text-slate-400">数据库版本、初始化、迁移、清理和 Worker 配置只读查看。</p></div><button className="btn-secondary" onClick={load}><RefreshCw size={16} /> 刷新</button></div><div className="grid gap-5 xl:grid-cols-2"><div className="panel p-5"><h3 className="panel-title"><Database className="mr-2 inline h-5 w-5 text-slate-600" />数据库</h3><pre className="code-area mt-4 max-h-80">{jsonPretty(db)}</pre><div className="mt-4 flex flex-wrap gap-3"><button className="btn-secondary" onClick={() => action('/admin/db_initialize')}><HardDrive size={16} /> 初始化</button><button className="btn-secondary" onClick={() => action('/admin/db_migration')}><Database size={16} /> 迁移</button></div></div><div className="panel p-5"><h3 className="panel-title"><Cloud className="mr-2 inline h-5 w-5 text-slate-600" />Worker 配置</h3><pre className="code-area mt-4 max-h-80">{jsonPretty(workerConfig)}</pre></div><div className="panel p-5 xl:col-span-2"><h3 className="panel-title">清理任务</h3><div className="mt-4 grid gap-3 md:grid-cols-[1fr_160px_auto]"><select className="form-select" value={cleanType} onChange={(e) => setCleanType(e.target.value)}><option value="raw_mails">收件 raw_mails</option><option value="sendbox">发件 sendbox</option><option value="address">地址 address</option><option value="custom_sql">自定义 SQL 配置</option></select><input className="form-input" type="number" value={cleanDays} onChange={(e) => setCleanDays(Number(e.target.value))} /><button className="btn-danger" onClick={() => action('/admin/cleanup', { cleanType, cleanDays })}><Trash2 size={16} /> 执行清理</button></div><div className="mt-5"><GenericSettingsCard title="自动清理配置" description="读取并保存 /admin/auto_cleanup 配置。" endpoint="/admin/auto_cleanup" request={request} notify={notify} /></div></div></div></div></div>;
}


