import { useCallback, useEffect, useState } from 'react';
import { Bot, Cloud, Database, Edit3, HardDrive, Link, Loader2, RefreshCw, Save, ShieldCheck, Trash2, Webhook } from 'lucide-react';
import type { Requester } from '../lib/api';
import { jsonPretty, safeJsonParse } from '../lib/format';
import { FRONTEND_LOGIN_BASE, STORAGE_KEYS } from '../lib/constants';
import { readStorage, writeLocalStorage } from '../lib/storage';
import { getRuntimeLocale, localeText, type AppLocale } from '../lib/locale';
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

const settingsKeyLabels: Record<string, { zh: string; en: string; hintZh?: string; hintEn?: string }> = {
  title: { zh: '站点标题', en: 'Site title' },
  prefix: { zh: '邮箱前缀', en: 'Mailbox prefix' },
  addressRegex: { zh: '地址清理规则', en: 'Address sanitizing regex', hintZh: '用于限制邮箱 local-part 可保留的字符', hintEn: 'Controls which local-part characters are kept' },
  minAddressLen: { zh: '地址最小长度', en: 'Minimum address length' },
  maxAddressLen: { zh: '地址最大长度', en: 'Maximum address length' },
  domains: { zh: '可用域名', en: 'Available domains' },
  domainLabels: { zh: '域名显示名称', en: 'Domain display labels' },
  defaultDomains: { zh: '默认域名', en: 'Default domains' },
  randomSubdomainDomains: { zh: '随机二级域名范围', en: 'Random subdomain domains' },
  needAuth: { zh: '访问需要认证', en: 'Require authentication' },
  adminContact: { zh: '管理员联系方式', en: 'Admin contact' },
  copyright: { zh: '版权文案', en: 'Copyright text' },
  statusUrl: { zh: '状态页地址', en: 'Status page URL' },
  defaultRole: { zh: '默认用户角色', en: 'Default user role' },
  role: { zh: '角色', en: 'Role' },
  label: { zh: '显示名称', en: 'Display label' },
  value: { zh: '配置值', en: 'Value' },
  enabled: { zh: '启用状态', en: 'Enabled state' },

  enableUserCreateEmail: { zh: '允许用户创建邮箱', en: 'Allow users to create mailboxes' },
  disableAnonymousUserCreateEmail: { zh: '禁止匿名用户创建邮箱', en: 'Disable anonymous mailbox creation' },
  disableCustomAddressName: { zh: '禁止自定义邮箱名', en: 'Disable custom mailbox names' },
  enableUserDeleteEmail: { zh: '允许用户删除邮件', en: 'Allow users to delete mail' },
  enableAutoReply: { zh: '启用自动回复', en: 'Enable auto-reply' },
  enableIndexAbout: { zh: '启用首页介绍', en: 'Enable landing about section' },
  enableWebhook: { zh: '启用 Webhook', en: 'Enable Webhook' },
  isS3Enabled: { zh: '启用 R2/S3 附件', en: 'Enable R2/S3 attachments' },
  enableSendMail: { zh: '启用发信功能', en: 'Enable sending mail' },
  enableAddressPassword: { zh: '启用邮箱地址密码', en: 'Enable mailbox passwords' },
  enableAgentEmailInfo: { zh: '启用 AI 邮件信息提取', en: 'Enable AI mail extraction' },
  enableGlobalTurnstileCheck: { zh: '启用全局 Turnstile', en: 'Enable global Turnstile' },
  disableAdminPasswordCheck: { zh: '关闭管理员密码校验', en: 'Disable admin password check' },
  cfTurnstileSiteKey: { zh: 'Turnstile Site Key', en: 'Turnstile site key' },
  cfTurnstileSecretKey: { zh: 'Turnstile Secret Key', en: 'Turnstile secret key' },
  enableUserRegister: { zh: '允许用户注册', en: 'Allow user registration' },
  enableUserLogin: { zh: '允许用户登录', en: 'Allow user login' },
  enableEmailVerify: { zh: '启用邮箱验证', en: 'Enable email verification' },
  requireEmailVerify: { zh: '强制邮箱验证', en: 'Require email verification' },
  defaultUserRole: { zh: '默认用户角色', en: 'Default user role' },
  maxUserAddressCount: { zh: '用户最大地址数', en: 'Max addresses per user' },
  userAddressLimit: { zh: '用户地址额度', en: 'User address limit' },
  passwordMinLength: { zh: '密码最小长度', en: 'Minimum password length' },
  passwordMaxLength: { zh: '密码最大长度', en: 'Maximum password length' },
  jwtExpire: { zh: 'JWT 有效期', en: 'JWT expiration' },
  jwtSecret: { zh: 'JWT 密钥', en: 'JWT secret' },
  jwtPrivateKey: { zh: 'JWT 私钥', en: 'JWT private key' },
  jwtPublicKey: { zh: 'JWT 公钥', en: 'JWT public key' },
  sessionExpire: { zh: '会话有效期', en: 'Session expiration' },
  sessionSecret: { zh: '会话密钥', en: 'Session secret' },

  emailRuleSettings: { zh: '邮件规则设置', en: 'Mail rule settings' },
  addressCreationSettings: { zh: '地址创建设置', en: 'Address creation settings' },
  addressCreationSubdomainMatchStatus: { zh: '子域名匹配状态', en: 'Subdomain matching status' },
  sendMailLimitConfig: { zh: '发信额度配置', en: 'Sending quota config' },
  sendMailAccountDailyLimit: { zh: '发信账号额度', en: 'Sending account quota' },
  blockList: { zh: '地址黑名单', en: 'Address blacklist' },
  sendBlockList: { zh: '发件黑名单', en: 'Sender blacklist' },
  noLimitSendAddressList: { zh: '免限制发件地址', en: 'Unlimited sender addresses' },
  verifiedAddressList: { zh: '已验证地址', en: 'Verified addresses' },
  fromBlockList: { zh: '来源黑名单', en: 'From blacklist' },
  blockReceiveUnknowAddressEmail: { zh: '拦截未知地址收件', en: 'Block unknown-address inbound mail' },
  enableSubdomainMatch: { zh: '启用子域名匹配', en: 'Enable subdomain matching' },
  storedEnabled: { zh: '保存的启用状态', en: 'Stored enabled state' },
  dailyEnabled: { zh: '启用每日额度', en: 'Enable daily quota' },
  monthlyEnabled: { zh: '启用每月额度', en: 'Enable monthly quota' },
  dailyLimit: { zh: '每日额度', en: 'Daily quota' },
  monthlyLimit: { zh: '每月额度', en: 'Monthly quota' },

  webhookUrl: { zh: 'Webhook 地址', en: 'Webhook URL' },
  webhookUrls: { zh: 'Webhook 地址列表', en: 'Webhook URLs' },
  allowList: { zh: '允许列表', en: 'Allow list' },
  denyList: { zh: '拒绝列表', en: 'Deny list' },
  secret: { zh: '密钥', en: 'Secret' },
  token: { zh: '令牌', en: 'Token' },
  apiKey: { zh: 'API 密钥', en: 'API key' },
  apiBase: { zh: 'API 基础地址', en: 'API base URL' },
  baseUrl: { zh: '基础地址', en: 'Base URL' },
  endpoint: { zh: '接口地址', en: 'Endpoint' },
  headers: { zh: '请求头', en: 'Headers' },
  timeout: { zh: '超时时间', en: 'Timeout' },
  retry: { zh: '重试次数', en: 'Retry count' },
  retries: { zh: '重试次数', en: 'Retries' },
  corsOrigins: { zh: 'CORS 允许来源', en: 'CORS allowed origins' },
  allowedOrigins: { zh: '允许访问来源', en: 'Allowed origins' },
  frontendUrl: { zh: '前端地址', en: 'Frontend URL' },
  frontendBaseUrl: { zh: '前端基础地址', en: 'Frontend base URL' },
  loginUrl: { zh: '登录地址', en: 'Login URL' },
  workerBaseUrl: { zh: 'Worker 基础地址', en: 'Worker base URL' },
  workerUrl: { zh: 'Worker 地址', en: 'Worker URL' },
  mailWorkerBaseUrl: { zh: '邮件 Worker 地址', en: 'Mail Worker base URL' },
  adminPassword: { zh: '管理员密码', en: 'Admin password' },
  sitePassword: { zh: '站点访问密码', en: 'Site password' },
  accessPassword: { zh: '访问密码', en: 'Access password' },

  botToken: { zh: 'Bot Token', en: 'Bot token' },
  botUsername: { zh: 'Bot 用户名', en: 'Bot username' },
  chatId: { zh: '聊天 ID', en: 'Chat ID' },
  webhookSecret: { zh: 'Webhook Secret', en: 'Webhook secret' },
  miniAppUrl: { zh: 'Mini App 地址', en: 'Mini App URL' },
  botApiToken: { zh: 'Bot API 令牌', en: 'Bot API token' },
  allowedUpdates: { zh: '允许的更新类型', en: 'Allowed update types' },

  provider: { zh: '服务商', en: 'Provider' },
  clientId: { zh: 'Client ID', en: 'Client ID' },
  clientSecret: { zh: 'Client Secret', en: 'Client secret' },
  redirectUri: { zh: '回调地址', en: 'Redirect URI' },
  scopes: { zh: '授权范围', en: 'Scopes' },

  bucket: { zh: '存储桶', en: 'Bucket' },
  region: { zh: '区域', en: 'Region' },
  accessKeyId: { zh: 'Access Key ID', en: 'Access key ID' },
  secretAccessKey: { zh: 'Secret Access Key', en: 'Secret access key' },
  publicUrl: { zh: '公开访问地址', en: 'Public URL' },
  accountId: { zh: '账户 ID', en: 'Account ID' },
  namespaceId: { zh: '命名空间 ID', en: 'Namespace ID' },
  kvNamespaceId: { zh: 'KV 命名空间 ID', en: 'KV namespace ID' },
  databaseId: { zh: '数据库 ID', en: 'Database ID' },
  d1DatabaseId: { zh: 'D1 数据库 ID', en: 'D1 database ID' },
  shareKv: { zh: '共享 KV', en: 'Share KV' },
  shareKV: { zh: '共享 KV', en: 'Share KV' },
  shareEncryptionSecret: { zh: '共享链接加密密钥', en: 'Share encryption secret' },
  shareTokenExpireDays: { zh: '共享链接默认有效天数', en: 'Default share expiry days' },
  shareDefaultVisibility: { zh: '共享邮件默认范围', en: 'Default share visibility' },
  shareDefaultPermission: { zh: '共享默认权限', en: 'Default share permission' },

  model: { zh: '模型', en: 'Model' },
  prompt: { zh: '提示词', en: 'Prompt' },
  systemPrompt: { zh: '系统提示词', en: 'System prompt' },
  temperature: { zh: '温度', en: 'Temperature' },
  maxTokens: { zh: '最大 Token 数', en: 'Max tokens' },
  openaiApiKey: { zh: 'OpenAI API 密钥', en: 'OpenAI API key' },
  openaiBaseUrl: { zh: 'OpenAI 基础地址', en: 'OpenAI base URL' },
  aiProvider: { zh: 'AI 服务商', en: 'AI provider' },
  extractionModel: { zh: '提取模型', en: 'Extraction model' },

  cleanType: { zh: '清理类型', en: 'Cleanup type' },
  cleanDays: { zh: '保留天数', en: 'Retention days' },
  enabledCleanup: { zh: '启用自动清理', en: 'Enable auto cleanup' },
  cleanupInterval: { zh: '清理间隔', en: 'Cleanup interval' },
  retentionDays: { zh: '保留天数', en: 'Retention days' },
  maxAgeDays: { zh: '最大保留天数', en: 'Maximum age in days' },
  raw_mails: { zh: '收件原始表', en: 'Inbox raw mails' },
  sendbox: { zh: '发件箱', en: 'Sent mailbox' },
  address: { zh: '地址表', en: 'Address table' },
  custom_sql: { zh: '自定义 SQL', en: 'Custom SQL' },
};

const keyTokenLabels: Record<string, string> = {
  enable: '启用',
  enabled: '启用',
  disable: '禁用',
  disabled: '禁用',
  user: '用户',
  admin: '管理员',
  anonymous: '匿名',
  create: '创建',
  creation: '创建',
  delete: '删除',
  mail: '邮件',
  mails: '邮件',
  email: '邮箱',
  address: '地址',
  password: '密码',
  default: '默认',
  role: '角色',
  setting: '设置',
  settings: '设置',
  webhook: 'Webhook',
  telegram: 'Telegram',
  bot: 'Bot',
  token: '令牌',
  secret: '密钥',
  url: '地址',
  uri: '地址',
  domain: '域名',
  domains: '域名',
  regex: '正则规则',
  min: '最小',
  max: '最大',
  len: '长度',
  length: '长度',
  prefix: '前缀',
  random: '随机',
  subdomain: '子域名',
  contact: '联系方式',
  copyright: '版权',
  site: '站点',
  key: 'Key',
  global: '全局',
  turnstile: 'Turnstile',
  check: '校验',
  client: 'Client',
  callback: '回调',
  redirect: '跳转',
  oauth: 'OAuth',
  google: 'Google',
  github: 'GitHub',
  code: '代码',
  limit: '限制',
  daily: '每日',
  monthly: '每月',
  ip: 'IP',
  asn: 'ASN',
  fingerprint: '指纹',
  black: '黑',
  block: '拦截',
  allow: '允许',
  list: '列表',
  from: '来源',
  send: '发信',
  receive: '收信',
  unknown: '未知',
  raw: '原始',
  cleanup: '清理',
  days: '天数',
  s3: 'S3',
  r2: 'R2',
  bucket: '存储桶',
  endpoint: '接口地址',
  access: '访问',
  region: '区域',
  public: '公开',
  ai: 'AI',
  extract: '提取',
  agent: 'Agent',
  model: '模型',
  prompt: '提示词',
  base: '基础',
  api: 'API',
  open: '开放',
  status: '状态',
  title: '标题',
  need: '需要',
  auth: '认证',
  require: '要求',
  required: '必填',
  custom: '自定义',
  name: '名称',
  auto: '自动',
  interval: '间隔',
  expire: '过期',
  expires: '过期',
  expiration: '有效期',
  retention: '保留',
  age: '时长',
  hour: '小时',
  hours: '小时',
  minute: '分钟',
  minutes: '分钟',
  reply: '回复',
  index: '首页',
  about: '介绍',
  verified: '已验证',
  verification: '验证',
  verify: '验证',
  captcha: '验证码',
  quota: '额度',
  count: '数量',
  size: '大小',
  mode: '模式',
  type: '类型',
  config: '配置',
  configs: '配置',
  rule: '规则',
  rules: '规则',
  oauth2: 'OAuth2',
  smtp: 'SMTP',
  imap: 'IMAP',
  pop3: 'POP3',
  cors: 'CORS',
  origin: '来源',
  origins: '来源',
  frontend: '前端',
  backend: '后端',
  worker: 'Worker',
  cloudflare: 'Cloudflare',
  kv: 'KV',
  namespace: '命名空间',
  database: '数据库',
  d1: 'D1',
  share: '共享',
  sharing: '共享',
  encryption: '加密',
  private: '私有',
  publickey: '公钥',
  privatekey: '私钥',
  session: '会话',
  expireday: '有效天数',
  visibility: '可见范围',
  permission: '权限',
  permissions: '权限',
  attachment: '附件',
  attachments: '附件',
  storage: '存储',
  object: '对象',
  proxy: '代理',
  host: '主机',
  port: '端口',
  ssl: 'SSL',
  tls: 'TLS',
  sender: '发件人',
  recipient: '收件人',
  subject: '主题',
  template: '模板',
};

function joinLocalizedTokens(parts: string[]) {
  return parts.reduce((text, part, index) => {
    if (!index) return part;
    const prev = parts[index - 1];
    const needsSpace = /[A-Za-z0-9]/.test(prev) || /[A-Za-z0-9]/.test(part);
    return `${text}${needsSpace ? ' ' : ''}${part}`;
  }, '');
}

function splitKeyTokens(key: string): string[] {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function localizedKeyLabel(key: string | number, locale: AppLocale) {
  if (typeof key === 'number') {
    const indexLabel = locale === 'en-US' ? `Item ${key + 1}` : `第 ${key + 1} 项`;
    return { title: indexLabel, meta: String(key) };
  }
  const raw = String(key);
  const mapped = settingsKeyLabels[raw];
  if (mapped) {
    return {
      title: localeText(mapped.zh, mapped.en, locale),
      meta: `${localeText('原字段', 'Key', locale)}: ${raw}${mapped.hintZh || mapped.hintEn ? ` · ${localeText(mapped.hintZh || mapped.zh, mapped.hintEn || mapped.en, locale)}` : ''}`,
    };
  }
  const human = titleFromKey(raw);
  if (locale === 'en-US') return { title: human, meta: `Key: ${raw}` };
  const tokens = splitKeyTokens(raw);
  const translated = joinLocalizedTokens(tokens.map((token) => keyTokenLabels[token.toLowerCase()] || token));
  return { title: translated || human, meta: `原字段: ${raw}` };
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
  const { locale, t } = useSettingsLocale();
  const label = localizedKeyLabel(fieldKey, locale);
  const commit = (nextValue: unknown) => onRootChange(updateJsonAtPath(root, path, nextValue));
  if (typeof value === 'boolean') {
    return <label className="json-visual-row json-visual-switch"><span><strong>{label.title}</strong><small>{label.meta}</small></span><input type="checkbox" checked={value} onChange={(e) => commit(e.target.checked)} /></label>;
  }
  if (typeof value === 'number') {
    return <label className="json-visual-row"><span><strong>{label.title}</strong><small>{label.meta}</small></span><input className="form-input compact-control" type="number" value={Number.isFinite(value) ? value : 0} onChange={(e) => commit(Number(e.target.value))} /></label>;
  }
  if (typeof value === 'string' || value === null || value === undefined) {
    const text = String(value ?? '');
    const multiline = text.length > 88 || text.includes('\n');
    return <label className="json-visual-row block"><span><strong>{label.title}</strong><small>{label.meta}</small></span>{multiline ? <textarea className="form-textarea json-visual-textarea" value={text} onChange={(e) => commit(e.target.value)} /> : <input className="form-input compact-control" value={text} onChange={(e) => commit(e.target.value)} />}</label>;
  }
  if (Array.isArray(value)) {
    const primitive = value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item));
    if (primitive) {
      return <label className="json-visual-row block"><span><strong>{label.title}</strong><small>{t('列表，每行一项', 'List, one item per line')} · {label.meta}</small></span><textarea className="form-textarea json-visual-textarea" value={primitiveArrayToText(value)} onChange={(e) => commit(textToStringArray(e.target.value))} /></label>;
    }
    return <JsonComplexField fieldKey={fieldKey} value={value} path={path} root={root} onRootChange={onRootChange} depth={depth} />;
  }
  if (isPlainObject(value)) {
    return <JsonComplexField fieldKey={fieldKey} value={value} path={path} root={root} onRootChange={onRootChange} depth={depth} />;
  }
  return <label className="json-visual-row block"><span><strong>{label.title}</strong><small>{label.meta}</small></span><textarea className="form-textarea json-visual-textarea" value={jsonPretty(value)} onChange={(e) => commit(safeJsonParse(e.target.value, value))} /></label>;
}

function JsonComplexField({ fieldKey, value, path, root, onRootChange, depth = 0 }: { fieldKey: string | number; value: unknown; path: JsonPath; root: unknown; onRootChange: (next: unknown) => void; depth?: number }) {
  const { locale, t } = useSettingsLocale();
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const entries = isPlainObject(value) ? Object.entries(value) : [];
  const jsonValue = jsonPretty(value);
  const commitRaw = (raw: string) => onRootChange(updateJsonAtPath(root, path, safeJsonParse(raw, value)));
  const label = localizedKeyLabel(fieldKey, locale);
  return <section className="json-visual-group" style={{ marginLeft: depth ? Math.min(depth * 10, 28) : 0 }}>
    <div className="json-visual-group-head">
      <div><strong>{label.title}</strong><small>{Array.isArray(value) ? `${t(`${value.length} 项`, `${value.length} items`)} · ${label.meta}` : `${entries.length} ${t('个字段', 'fields')} · ${label.meta}`}</small></div>
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
  return <div className="panel settings-card"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-slate-800">{title}</h3><p className="mt-1 text-xs leading-5 text-slate-400">{description}</p><div className="settings-card-meta mt-2"><span>{t('中文字段名', 'Localized labels')}</span><code>{endpoint}</code></div></div><button className="icon-btn compact" onClick={load}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Edit3 size={16} />}</button></div>{open && <Modal title={title} onClose={() => setOpen(false)} wide><div className="settings-editor-toolbar"><div><strong>{t('编辑方式', 'Editor mode')}</strong><span>{t('表单里左侧显示中文对照，灰色小字保留原始字段名；复杂配置仍可切到 JSON。', 'The form shows localized labels first and keeps the original key in muted text; switch to JSON for advanced config.')}</span></div><div className="settings-editor-tabs"><button type="button" className={editorMode === 'visual' ? 'active' : ''} onClick={() => setEditorMode('visual')}>{t('可视化表单', 'Visual form')}</button><button type="button" className={editorMode === 'json' ? 'active' : ''} onClick={() => setEditorMode('json')}>JSON</button></div></div>{editorMode === 'visual' ? <JsonVisualEditor value={parsedBody} onChange={updateVisual} /> : <textarea className="code-area h-[50vh]" value={body} onChange={(e) => setBody(e.target.value)} />}<div className="mt-5 flex justify-end gap-3">{testEndpoint && <button className="btn-secondary" onClick={async () => { await request(testEndpoint, { method: 'POST', body: safeJsonParse(body, {}) }); notify('success', t('测试请求已发送', 'Test request sent')); }}><Webhook size={16} /> {t('测试', 'Test')}</button>}<button className="btn-primary" onClick={save}><Save size={16} /> {t('保存', 'Save')}</button></div></Modal>}</div>;
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
  return <div className="h-full overflow-y-auto p-3 md:p-4 xl:p-6"><div className="space-y-3"><div><h2 className="page-title">{t('系统设置', 'System settings')}</h2><p className="page-subtitle mt-1">{t('常用项支持可视化表单编辑；字段标题优先显示中文，灰色小字保留原始字段名，复杂配置仍可切到 JSON 高级模式。', 'Common settings support visual form editing; field titles are localized while the muted line keeps the original key, and advanced JSON mode remains available.')}</p></div><div className="grid gap-2.5 xl:grid-cols-2"><RoleAddressConfigPanel request={request} notify={notify} /><MailRefreshPreferenceCard notify={notify} /><FrontendLoginBaseCard notify={notify} /><AccountRulesPanel request={request} notify={notify} /><TelegramPanel request={request} notify={notify} />{cards.map(([title, desc, endpoint, test]) => <GenericSettingsCard key={endpoint} title={title} description={desc} endpoint={endpoint} request={request} notify={notify} testEndpoint={test} />)}</div></div></div>;
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
  const defaultBase = FRONTEND_LOGIN_BASE || '';
  const [value, setValue] = useState(() => readStorage(STORAGE_KEYS.frontendLoginBase, defaultBase));
  const normalized = (value || defaultBase).trim().replace(/\/$/, '');
  const save = () => {
    writeLocalStorage(STORAGE_KEYS.frontendLoginBase, normalized);
    setValue(normalized);
    notify('success', t('前端登录链接前缀已保存', 'Frontend login link prefix saved'));
  };
  return <div className="panel settings-card"><div className="settings-card-head"><div><h3 className="font-semibold text-slate-800"><Link className="mr-2 inline h-4 w-4 text-slate-600" />{t('前端登录链接前缀', 'Frontend login link prefix')}</h3><p className="panel-subtitle">{t('必须填写用户站地址，用于', 'Set the webmail site URL for')} <code>/?JWT=</code>{t(' 登录链接和共享链接接口；不要填写后台管理站地址。', ' login links and share-link APIs; do not use the admin URL.')}</p></div></div><div className="mt-3 flex flex-col gap-2 sm:flex-row"><input className="form-input compact-control" value={value} onChange={(e) => setValue(e.target.value)} placeholder={defaultBase || 'https://your-webmail.example.com'} /><button className="btn-primary compact shrink-0" onClick={save}><Save size={15} /> {t('保存', 'Save')}</button></div><p className="mt-2 truncate rounded-xl bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">{normalized ? `${t('示例：', 'Example: ')}${normalized}/?JWT=...` : t('尚未配置：共享链接管理会提示先填写用户站地址。', 'Not configured: share management will ask for the webmail URL first.')}</p></div>;
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
  return <div className="maintenance-view-shell h-full overflow-y-auto p-4 md:p-8"><div className="space-y-5"><div className="flex items-center justify-between"><div><h2 className="page-title">{t('维护', 'Maintenance')}</h2><p className="page-subtitle mt-1">{t('数据库版本、初始化、迁移、清理和 Worker 配置只读查看。', 'View database version, initialization, migrations, cleanup, and Worker config.')}</p></div><button className="btn-secondary" onClick={load}><RefreshCw size={16} /> {t('刷新', 'Refresh')}</button></div><div className="grid gap-5 xl:grid-cols-2"><div className="panel p-5"><h3 className="panel-title"><Database className="mr-2 inline h-5 w-5 text-slate-600" />{t('数据库', 'Database')}</h3><pre className="code-area mt-4 max-h-80">{jsonPretty(db)}</pre><div className="mt-4 flex flex-wrap gap-3"><button className="btn-secondary" onClick={() => action('/admin/db_initialize')}><HardDrive size={16} /> {t('初始化', 'Initialize')}</button><button className="btn-secondary" onClick={() => action('/admin/db_migration')}><Database size={16} /> {t('迁移', 'Migrate')}</button></div></div><div className="panel p-5"><h3 className="panel-title"><Cloud className="mr-2 inline h-5 w-5 text-slate-600" />{t('Worker 配置', 'Worker config')}</h3><pre className="code-area mt-4 max-h-80">{jsonPretty(workerConfig)}</pre></div><div className="panel p-5 xl:col-span-2"><h3 className="panel-title">{t('清理任务', 'Cleanup task')}</h3><div className="maintenance-cleanup-grid mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_auto]"><label className="maintenance-cleanup-field"><span className="form-label">{t('清理范围', 'Cleanup scope')}</span><select className="form-select compact-control" value={cleanType} onChange={(e) => setCleanType(e.target.value)}><option value="raw_mails">{t('收件 raw_mails', 'Inbox raw_mails')}</option><option value="sendbox">{t('发件 sendbox', 'Sent sendbox')}</option><option value="address">{t('地址 address', 'Address table')}</option><option value="custom_sql">{t('自定义 SQL 配置', 'Custom SQL config')}</option></select></label><label className="maintenance-cleanup-field"><span className="form-label">{t('保留天数', 'Retention days')}</span><input className="form-input compact-control" type="number" min={0} value={cleanDays} onChange={(e) => setCleanDays(Number(e.target.value))} /></label><div className="maintenance-cleanup-action"><span className="form-label maintenance-cleanup-action-label">{t('操作', 'Action')}</span><button className="btn-danger compact maintenance-cleanup-button" onClick={() => action('/admin/cleanup', { cleanType, cleanDays })}><Trash2 size={16} /> {t('执行清理', 'Run cleanup')}</button></div></div><div className="mt-5"><GenericSettingsCard title={t('自动清理配置', 'Auto cleanup config')} description={t('读取并保存 /admin/auto_cleanup 配置。', 'Read and save /admin/auto_cleanup config.')} endpoint="/admin/auto_cleanup" request={request} notify={notify} /></div></div></div></div></div>;
}


