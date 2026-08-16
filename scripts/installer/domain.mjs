import { msg } from './i18n.mjs';
import { UPSTREAM_LOCK } from './upstream.mjs';

const PROJECT_NAME_MAX = 58;

export function normalizePrefix(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error(msg('项目名称前缀不能为空。', 'The project name prefix cannot be empty.'));
  if (normalized.length > PROJECT_NAME_MAX - 8) {
    throw new Error(msg(
      `项目名称前缀不能超过 ${PROJECT_NAME_MAX - 8} 个字符。`,
      `The project name prefix cannot exceed ${PROJECT_NAME_MAX - 8} characters.`,
    ));
  }
  return normalized;
}

export function validateWorkerUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(msg('Worker 地址不是有效 URL。', 'The Worker URL is not valid.'));
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error(msg('生产 Worker 必须使用 HTTPS。', 'A production Worker must use HTTPS.'));
  }
  if (url.username || url.password) {
    throw new Error(msg('Worker 地址不能包含用户名或密码。', 'The Worker URL cannot contain a username or password.'));
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(msg(
      '请填写 Worker 根地址，不要包含路径、查询参数或锚点。',
      'Enter the Worker root URL without a path, query string, or fragment.',
    ));
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
    throw new Error(msg(
      '安装器管理的 Worker 地址必须是公开的 HTTPS *.workers.dev 根地址。',
      'An installer-managed Worker URL must be a public HTTPS *.workers.dev root URL.',
    ));
  }
  return url.origin;
}

export function validateMailDomain(value) {
  const domain = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    throw new Error(msg(
      '邮箱域名格式无效，请输入已经托管到 Cloudflare 的完整域名。',
      'The mail domain is invalid. Enter a complete domain already managed by Cloudflare.',
    ));
  }
  if (domain === 'example.com' || domain.endsWith('.example.com')) {
    throw new Error(msg('请填写真实邮箱域名，不要使用示例域名。', 'Enter a real mail domain, not an example domain.'));
  }
  return domain;
}

export function validateMailDomains(value) {
  const items = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item ?? '').split(/[,，\r\n]+/))
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length) {
    throw new Error(msg(
      '至少需要填写一个已经托管到 Cloudflare 的邮箱域名。',
      'Enter at least one mail domain already managed by Cloudflare.',
    ));
  }

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
    throw new Error(msg('首个管理员登录邮箱格式无效。', 'The first administrator login email is invalid.'));
  }
  const local = email.slice(0, separator);
  if (local.length > 64 || /[\s\u0000-\u001f\u007f]/.test(local)) {
    throw new Error(msg('首个管理员登录邮箱格式无效。', 'The first administrator login email is invalid.'));
  }
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
  if (!pagesDomain) {
    throw new Error(msg(
      `无法确定 Pages 项目 ${projectName} 的公开地址。`,
      `Could not determine the public URL for Pages project ${projectName}.`,
    ));
  }
  return `https://${pagesDomain}`;
}

export function createInstallPlan({ prefix = 'loven7-mail', workerUrl = 'https://worker.example.com' } = {}) {
  const names = createResourceNames(prefix);
  return {
    mode: 'existing-worker',
    workerUrl: validateWorkerUrl(workerUrl),
    resources: names,
    steps: [
      msg('检查 Node.js 版本和 Wrangler OAuth 登录状态', 'Check the Node.js version and Wrangler OAuth session'),
      msg('构建 Admin 与 Webmail', 'Build Admin and Webmail'),
      msg('只读验证 Worker 健康状态、站点密码和管理员口令', 'Read-only verification of Worker health, site password, and administrator secret'),
      msg(
        `创建或复用 Pages 项目 ${names.adminProject}、${names.webmailProject}`,
        `Create or reuse Pages projects ${names.adminProject} and ${names.webmailProject}`,
      ),
      msg(
        `创建或复用 KV ${names.shareKv}、${names.mailStateKv}`,
        `Create or reuse KV namespaces ${names.shareKv} and ${names.mailStateKv}`,
      ),
      msg('生成分享加密密钥并通过标准输入写入 Cloudflare Secret', 'Generate a share encryption key and write it to Cloudflare Secret through standard input'),
      msg('写入 Pages 变量和 KV binding，依次部署 Admin、Webmail', 'Write Pages variables and KV bindings, then deploy Admin and Webmail'),
      msg('检查 Admin 代理链路和 Webmail /api/runtime', 'Verify the Admin proxy chain and Webmail /api/runtime'),
    ],
    manual: [
      msg('兼容 Worker、D1 和 Email Routing 必须已经部署完成', 'A compatible Worker, D1 database, and Email Routing must already be deployed'),
      msg('使用真实管理员账号完成登录验收', 'Verify sign-in with a real administrator account'),
      msg('从外部邮箱发送测试邮件，确认 Catch-all 路由能够收件', 'Send a test message from an external mailbox and verify Catch-all delivery'),
      msg('如需发件，另行配置 Resend、SMTP 或 Cloudflare Send Email', 'Configure Resend, SMTP, or Cloudflare Send Email separately if outbound mail is required'),
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
      msg('检查 Node.js、npm/npx 和 Wrangler OAuth 登录状态', 'Check Node.js, npm/npx, and the Wrangler OAuth session'),
      msg('验证邮箱域名属于当前 Cloudflare 账号且状态为 Active', 'Verify that each mail domain belongs to the selected Cloudflare account and is Active'),
      msg('下载锁定版本的兼容 Worker 源码并安装依赖', 'Download the pinned compatible Worker source and install its dependencies'),
      msg(
        `创建 D1 数据库 ${databaseName} 并远程执行 schema.sql`,
        `Create D1 database ${databaseName} and execute schema.sql remotely`,
      ),
      msg(
        `先部署不接管邮件的核心 Worker ${workerName}，安全写入 Secret 并取得 workers.dev 地址`,
        `Deploy core Worker ${workerName} without mail takeover first, write Secrets securely, and obtain its workers.dev URL`,
      ),
      msg('验证 Worker 健康状态、域名配置和首个管理员账号', 'Verify Worker health, domain configuration, and the first administrator account'),
      msg('再自动启用 Email Routing（必要时更新邮件 MX）', 'Then enable Email Routing automatically, updating mail MX records when required'),
      msg(
        `第二次声明式部署，把每个域名的 Catch-all 绑定到 ${workerName}`,
        `Run a second declarative deployment to bind each domain's Catch-all to ${workerName}`,
      ),
      msg('在线读取规则并确认 Catch-all 指向正确 Worker', 'Read routing rules online and verify that Catch-all targets the correct Worker'),
      msg('部署 Admin、Webmail、分享 KV 和邮件状态 KV', 'Deploy Admin, Webmail, the share KV, and the mail-state KV'),
      msg('检查 Worker、Admin、Webmail 和 Email Routing 闭环', 'Verify the complete Worker, Admin, Webmail, and Email Routing flow'),
    ],
    manual: [
      msg(
        '确认每个邮箱域名没有正在使用的企业邮箱或其他收件服务；安装器会在确认后更新邮件 MX',
        'Confirm that no mail domain currently uses business email or another receiving service; the installer updates mail MX records after confirmation',
      ),
      msg(
        '已有企业邮箱或其他收件服务的域名必须先规划迁移，避免直接替换 MX 导致原邮箱中断',
        'Plan migration first for domains using business email or another receiving service, because replacing MX records can interrupt existing mailboxes',
      ),
      msg('使用安装时创建的首个管理员账号登录 Admin', 'Sign in to Admin with the first administrator account created during installation'),
      msg(
        '从外部邮箱发送测试邮件，确认自动配置的 Catch-all 收件正常，并创建分享链接',
        'Send a test message from an external mailbox, verify automatic Catch-all delivery, and create a share link',
      ),
      msg('如需发件，另行配置 Resend、SMTP 或 Cloudflare Send Email', 'Configure Resend, SMTP, or Cloudflare Send Email separately if outbound mail is required'),
    ],
  };
}

export function renderUpstreamWorkerConfig({
  workerName,
  domain,
  domains,
  databaseName,
  databaseId,
  includeEmailRouting = true,
}) {
  const mailDomains = validateMailDomains(domains ?? domain);
  const domainList = mailDomains.map((item) => JSON.stringify(item)).join(', ');
  const addressList = mailDomains.map((item) => JSON.stringify(`*@${item}`)).join(', ');
  const lines = [
    `name = ${JSON.stringify(workerName)}`,
    'main = "src/worker.ts"',
    'workers_dev = true',
    'compatibility_date = "2025-04-01"',
    'compatibility_flags = ["nodejs_compat"]',
    'keep_vars = true',
  ];
  if (includeEmailRouting) lines.push(`addresses = [${addressList}]`);
  lines.push(
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
  );
  return lines.join('\n');
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
    'emailRoutingDomains', 'emailRoutingWorker',
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
