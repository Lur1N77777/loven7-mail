import { UPSTREAM_LOCK } from './upstream.mjs';

const PROJECT_NAME_MAX = 58;

export function normalizePrefix(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('项目名称前缀不能为空。');
  if (normalized.length > PROJECT_NAME_MAX - 8) {
    throw new Error(`项目名称前缀不能超过 ${PROJECT_NAME_MAX - 8} 个字符。`);
  }
  return normalized;
}

export function validateWorkerUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Worker 地址不是有效 URL。');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('生产 Worker 必须使用 HTTPS。');
  }
  if (url.username || url.password) {
    throw new Error('Worker 地址不能包含用户名或密码。');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请填写 Worker 根地址，不要包含路径、查询参数或锚点。');
  }
  return `${url.protocol}//${url.host}`;
}

export function validateManagedWorkerOrigin(value) {
  const origin = validateWorkerUrl(value);
  const url = new URL(origin);
  if (
    url.protocol !== 'https:'
    || url.port
    || url.hostname === 'workers.dev'
    || !url.hostname.endsWith('.workers.dev')
  ) {
    throw new Error('安装器管理的 Worker 地址必须是公开的 HTTPS *.workers.dev 根地址。');
  }
  return url.origin;
}

export function validateMailDomain(value) {
  const domain = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    throw new Error('邮箱域名格式无效，请输入已经托管到 Cloudflare 的完整域名。');
  }
  if (domain === 'example.com' || domain.endsWith('.example.com')) throw new Error('请填写真实邮箱域名，不要使用示例域名。');
  return domain;
}

export function validateMailDomains(value) {
  const items = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item ?? '').split(/[,，\r\n]+/))
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length) throw new Error('至少需要填写一个已经托管到 Cloudflare 的邮箱域名。');

  const seen = new Set();
  return items.map(validateMailDomain).filter((domain) => {
    if (seen.has(domain)) return false;
    seen.add(domain);
    return true;
  });
}

export function validateAdminEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  const separator = email.lastIndexOf('@');
  if (separator <= 0 || separator === email.length - 1 || email.length > 254) {
    throw new Error('首个管理员登录邮箱格式无效。');
  }
  const local = email.slice(0, separator);
  if (local.length > 64 || /[\s\u0000-\u001f\u007f]/.test(local)) throw new Error('首个管理员登录邮箱格式无效。');
  validateMailDomain(email.slice(separator + 1));
  return email;
}

export function createResourceNames(prefixValue) {
  const prefix = normalizePrefix(prefixValue);
  return {
    prefix,
    adminProject: `${prefix}-admin`,
    webmailProject: `${prefix}-webmail`,
    shareKv: `${prefix}-share`,
    mailStateKv: `${prefix}-mail-state`,
  };
}

export function parseProjectDomains(project) {
  const raw = project?.['Project Domains'] ?? project?.domains ?? project?.subdomain ?? '';
  const domains = Array.isArray(raw) ? raw : String(raw).split(',');
  return domains.map((item) => String(item).trim()).filter(Boolean);
}

export function projectOrigin(project, projectName) {
  const domains = parseProjectDomains(project);
  const pagesDomain = domains.find((domain) => domain.endsWith('.pages.dev')) || domains[0];
  if (!pagesDomain) throw new Error(`无法确定 Pages 项目 ${projectName} 的公开地址。`);
  return `https://${pagesDomain}`;
}

export function createInstallPlan({ prefix = 'loven7-mail', workerUrl = 'https://worker.example.com' } = {}) {
  const names = createResourceNames(prefix);
  return {
    mode: 'existing-worker',
    workerUrl: validateWorkerUrl(workerUrl),
    resources: names,
    steps: [
      '检查 Node.js 版本和 Wrangler OAuth 登录状态',
      `构建 Admin 与 Webmail`,
      '只读验证 Worker 健康状态、站点密码和管理员口令',
      `创建或复用 Pages 项目 ${names.adminProject}、${names.webmailProject}`,
      `创建或复用 KV ${names.shareKv}、${names.mailStateKv}`,
      '生成分享加密密钥并通过标准输入写入 Cloudflare Secret',
      '写入 Pages 变量和 KV binding，依次部署 Admin、Webmail',
      '检查 Admin 代理链路和 Webmail /api/runtime',
    ],
    manual: [
      '兼容 Worker、D1 和 Email Routing 必须已经部署完成',
      '使用真实管理员账号完成登录验收',
      '从外部邮箱发送测试邮件，确认 Catch-all 路由能够收件',
      '如需发件，另行配置 Resend、SMTP 或 Cloudflare Send Email',
    ],
  };
}

export function createUpstreamInstallPlan({ prefix = 'loven7-mail', domain = 'example.com', domains } = {}) {
  const names = createResourceNames(prefix);
  const workerName = `${names.prefix}-worker`;
  const databaseName = `${names.prefix}-db`;
  const mailDomains = validateMailDomains(domains ?? domain);
  return {
    mode: 'new-worker',
    domain: mailDomains[0],
    domains: mailDomains,
    resources: { ...names, workerName, databaseName },
    upstream: {
      repository: UPSTREAM_LOCK.repositoryUrl,
      release: UPSTREAM_LOCK.release,
      commit: UPSTREAM_LOCK.commit,
    },
    steps: [
      '检查 Node.js、npm/npx 和 Wrangler OAuth 登录状态',
      '下载锁定版本的兼容 Worker 源码并安装依赖',
      `创建 D1 数据库 ${databaseName} 并远程执行 schema.sql`,
      `生成 Worker ${workerName} 配置并安全写入 Secret`,
      `部署 Worker ${workerName}`,
      '验证 Worker 健康状态和管理员 API',
      '部署 Admin、Webmail、分享 KV 和邮件状态 KV',
      '检查三个运行单元并等待 Email Routing 确认',
    ],
    manual: [
      '确认每个邮箱域名都在即将登录的 Cloudflare 账号中为 Active，并允许配置邮件 MX 和 Catch-all',
      '已有企业邮箱或其他收件服务的域名必须先规划迁移，避免直接替换 MX 导致原邮箱中断',
      `在 Cloudflare Email Routing 中为每个邮箱域名配置 DNS 记录，并将 Catch-all 指向 ${workerName}`,
      '使用安装时创建的首个管理员账号登录 Admin',
      '从外部邮箱发送测试邮件并创建分享链接',
      '如需发件，另行配置 Resend、SMTP 或 Cloudflare Send Email',
    ],
  };
}

export function renderUpstreamWorkerConfig({ workerName, domain, domains, databaseName, databaseId }) {
  const mailDomains = validateMailDomains(domains ?? domain);
  const domainList = mailDomains.map((item) => JSON.stringify(item)).join(', ');
  return [
    `name = ${JSON.stringify(workerName)}`,
    'main = "src/worker.ts"',
    'workers_dev = true',
    'compatibility_date = "2025-04-01"',
    'compatibility_flags = ["nodejs_compat"]',
    'keep_vars = true',
    '',
    '[vars]',
    'PREFIX = "tmp"',
    `DEFAULT_DOMAINS = [${domainList}]`,
    `DOMAINS = [${domainList}]`,
    'ADMIN_USER_ROLE = "admin"',
    'ENABLE_USER_CREATE_EMAIL = true',
    'ENABLE_USER_DELETE_EMAIL = true',
    `USER_ROLES = [{ domains = [${domainList}], role = "admin", prefix = "" }]`,
    '',
    '[[d1_databases]]',
    'binding = "DB"',
    `database_name = ${JSON.stringify(databaseName)}`,
    `database_id = ${JSON.stringify(databaseId)}`,
    '',
  ].join('\n');
}

export function renderPagesConfig({ name, app, adminOrigin, shareKvId, mailStateKvId }) {
  const lines = [
    `name = ${JSON.stringify(name)}`,
    'pages_build_output_dir = "./dist"',
    'compatibility_date = "2026-05-11"',
  ];
  if (app === 'webmail') {
    lines.push('', '[vars]', `SHARE_ADMIN_CORS_ORIGINS = ${JSON.stringify(adminOrigin)}`);
    lines.push('', '[[kv_namespaces]]', 'binding = "SHARE_KV"', `id = ${JSON.stringify(shareKvId)}`);
  }
  lines.push('', '[[kv_namespaces]]', 'binding = "MAIL_READ_STATE_KV"', `id = ${JSON.stringify(mailStateKvId)}`);
  return `${lines.join('\n')}\n`;
}

export function redactInstallState(state) {
  const allowed = [
    'version', 'accountId', 'prefix', 'installMode', 'domain', 'domains', 'adminProject', 'webmailProject',
    'workerProject', 'workerDeploymentConfirmed', 'databaseName', 'databaseId', 'upstreamCommit',
    'shareKvId', 'mailStateKvId', 'adminOrigin', 'webmailOrigin', 'phase', 'updatedAt',
  ];
  const redacted = Object.fromEntries(allowed.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
  if (state.managedWorkerOrigin !== undefined) {
    try {
      redacted.managedWorkerOrigin = validateManagedWorkerOrigin(state.managedWorkerOrigin);
    } catch {
      // Never persist arbitrary existing-worker URLs or a tampered checkpoint value.
    }
  }
  return redacted;
}
