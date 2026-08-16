import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEmailRoutingConflictError } from './cloudflare.mjs';
import { createInstallPlan, projectOrigin, renderPagesConfig } from './domain.mjs';
import { createUpstreamInstallPlan, renderUpstreamWorkerConfig, validateAdminEmail, validateMailDomains, validateManagedWorkerOrigin } from './domain.mjs';
import { joinList, msg } from './i18n.mjs';
import { readState, writeState } from './state.mjs';

const DEFAULT_PROBE_ATTEMPTS = 8;
const DEFAULT_PROBE_DELAY_MS = 2_500;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

function findProject(projects, name) {
  return projects.find((project) => (project['Project Name'] ?? project.name) === name);
}

function findNamespace(namespaces, title) {
  return namespaces.find((namespace) => namespace.title === title);
}

function wait(milliseconds) {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

function stateDomains(state) {
  try {
    return validateMailDomains(state?.domains ?? state?.domain);
  } catch {
    return [];
  }
}

function sameDomains(left, right) {
  return left.length === right.length && left.every((domain, index) => domain === right[index]);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function probeFailure(error, label) {
  if (error?.name === 'AbortError') return new Error(msg(`${label} 请求超时。`, `${label} timed out.`));
  return error instanceof Error ? error : new Error(String(error));
}

async function probe(url, predicate, label, init = {}, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0
    ? options.attempts
    : DEFAULT_PROBE_ATTEMPTS;
  const delayMs = Number.isFinite(options.delayMs) && options.delayMs >= 0
    ? options.delayMs
    : DEFAULT_PROBE_DELAY_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, redirect: 'follow', signal: controller.signal });
      const body = await response.text();
      if (!response.ok) throw new Error(msg(`${label} 返回 HTTP ${response.status}。`, `${label} returned HTTP ${response.status}.`));
      const result = predicate(body, response);
      if (!result.ok) throw new Error(result.message || msg(`${label} 验收失败。`, `${label} verification failed.`));
      return result.value;
    } catch (error) {
      lastError = probeFailure(error, label);
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < attempts) {
      options.onRetry?.({ attempt, attempts, delayMs, error: lastError });
      await wait(delayMs);
    }
  }

  throw new Error(
    msg(
      `${label} 在 ${attempts} 次尝试后仍未就绪：${lastError?.message || '未知错误'}`,
      `${label} was not ready after ${attempts} attempts: ${lastError?.message || 'unknown error'}`,
    ),
    { cause: lastError },
  );
}

async function requestJson(url, { method = 'GET', headers = {}, body, label }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { response, data, text, label };
  } finally {
    clearTimeout(timeout);
  }
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class Installer {
  constructor({ rootDir, cloudflare, ui, probeOptions = {} }) {
    this.rootDir = rootDir;
    this.cloudflare = cloudflare;
    this.ui = ui;
    this.probeOptions = probeOptions;
  }

  async probe(url, predicate, label, init = {}) {
    const externalOnRetry = this.probeOptions.onRetry;
    return probe(url, predicate, label, init, {
      ...this.probeOptions,
      onRetry: (details) => {
        const retryText = details.delayMs > 0
          ? msg(`${Math.ceil(details.delayMs / 1_000)} 秒后重试`, `retrying in ${Math.ceil(details.delayMs / 1_000)}s`)
          : msg('立即重试', 'retrying now');
        this.ui.info(msg(
          `${label} 尚未就绪（${details.attempt}/${details.attempts}）：${details.error.message}；${retryText}。`,
          `${label} is not ready (${details.attempt}/${details.attempts}): ${details.error.message}; ${retryText}.`,
        ));
        externalOnRetry?.(details);
      },
    });
  }

  async verifyWorkerAccess({ workerUrl, adminPassword, sitePassword }) {
    const siteHeaders = sitePassword ? { 'x-custom-auth': sitePassword } : {};
    await this.probe(`${workerUrl}/health_check`, (body) => {
      const value = body.trim();
      return value === 'OK'
        ? { ok: true, value }
        : { ok: false, message: msg(
          `Worker 健康检查返回异常：${value.slice(0, 160) || '空响应'}`,
          `Worker health check returned an unexpected response: ${value.slice(0, 160) || 'empty response'}`,
        ) };
    }, msg('Worker 健康检查', 'Worker health check'), { headers: siteHeaders });

    const admin = await requestJson(`${workerUrl}/admin/users?limit=1&offset=0`, {
      headers: { ...siteHeaders, 'x-admin-auth': adminPassword },
      label: msg('Worker 管理员 API', 'Worker administrator API'),
    });
    if (!admin.response.ok) {
      const hint = admin.response.status === 401 || admin.response.status === 403
        ? msg('请检查 Worker 管理员口令和站点密码。', 'Check the Worker administrator secret and site password.')
        : msg('请确认 Worker API 与锁定上游兼容。', 'Confirm that the Worker API is compatible with the pinned upstream.');
      throw new Error(msg(
        `Worker 管理员 API 验收失败：HTTP ${admin.response.status} ${admin.text.slice(0, 160)} ${hint}`,
        `Worker administrator API verification failed: HTTP ${admin.response.status} ${admin.text.slice(0, 160)} ${hint}`,
      ));
    }
  }

  async verifyManagedWorkerDomains({ workerUrl, adminPassword, sitePassword, domains }) {
    const siteHeaders = sitePassword ? { 'x-custom-auth': sitePassword } : {};
    await this.probe(`${workerUrl}/admin/worker/configs`, (body) => {
      let data;
      try { data = JSON.parse(body); } catch {
        return { ok: false, message: msg('Worker 域名配置没有返回 JSON。', 'Worker domain configuration did not return JSON.') };
      }
      let actualDomains;
      let actualDefaults;
      try {
        actualDomains = validateMailDomains(data?.DOMAINS);
        actualDefaults = validateMailDomains(data?.DEFAULT_DOMAINS);
      } catch (error) {
        return { ok: false, message: msg(
          `Worker 域名配置验收失败：${error instanceof Error ? error.message : error}`,
          `Worker domain configuration verification failed: ${error instanceof Error ? error.message : error}`,
        ) };
      }
      return sameDomains(actualDomains, domains) && sameDomains(actualDefaults, domains)
        ? { ok: true, value: data }
        : {
            ok: false,
            message: msg(
              `Worker 线上域名与安装计划不一致：计划 ${joinList(domains)}；DOMAINS ${joinList(actualDomains)}；DEFAULT_DOMAINS ${joinList(actualDefaults)}。`,
              `Live Worker domains do not match the installation plan: planned ${joinList(domains)}; DOMAINS ${joinList(actualDomains)}; DEFAULT_DOMAINS ${joinList(actualDefaults)}.`,
            ),
          };
    }, msg('Worker 域名配置', 'Worker domain configuration'), { headers: { ...siteHeaders, 'x-admin-auth': adminPassword } });
  }

  async ensureAuthentication() {
    let identity;
    try {
      identity = this.cloudflare.whoami();
    } catch {
      this.ui.info(msg('浏览器即将打开 Cloudflare 官方授权页面。', 'Your browser will open the official Cloudflare authorization page.'));
      this.cloudflare.login();
      identity = this.cloudflare.whoami();
    }
    if (!identity.loggedIn || !identity.accounts?.length) {
      throw new Error(msg(
        'Cloudflare 登录成功，但当前账号没有可用账户。',
        'Cloudflare login succeeded, but the account has no available Cloudflare accounts.',
      ));
    }
    const account = identity.accounts.length === 1
      ? identity.accounts[0]
      : await this.ui.select(msg('选择要部署到的 Cloudflare 账户', 'Choose the Cloudflare account to deploy to'), identity.accounts, (item) => item.name);
    this.cloudflare.useAccount(account.id);
    this.ui.success(msg(`Cloudflare 已连接：${account.name}`, `Connected to Cloudflare: ${account.name}`));
    return account;
  }

  async verifyEmailRoutingDomains(domains) {
    this.ui.step(msg('核对邮箱域名归属', 'Verify mail domain ownership'));
    for (const domain of domains) {
      try {
        if (typeof this.cloudflare.checkEmailRoutingDomain === 'function') {
          try {
            this.cloudflare.checkEmailRoutingDomain(domain);
          } catch (error) {
            const detail = String(error?.message || error);
            if (!/403|401|unauthori[sz]ed|authentication|permission|scope|code\s*10000/i.test(detail) || typeof this.cloudflare.login !== 'function') throw error;
            this.ui.info(msg(
              '当前 Wrangler 授权缺少 Email Routing 权限，正在重新打开 Cloudflare 官方授权页面。',
              'The current Wrangler authorization lacks Email Routing permission. Reopening the official Cloudflare authorization page.',
            ));
            this.cloudflare.login();
            this.cloudflare.checkEmailRoutingDomain(domain);
          }
        }
        this.ui.info(msg(`已确认域名可用于当前 Cloudflare 账号：${domain}`, `Domain confirmed for the current Cloudflare account: ${domain}`));
      } catch (error) {
        throw new Error(
          msg(
            `域名 ${domain} 无法在当前 Cloudflare 账号启用 Email Routing。请确认它已托管到此账号且状态为 Active，再重新运行。${error instanceof Error ? ` 原因：${error.message}` : ''}`,
            `Email Routing cannot be enabled for ${domain} in the current Cloudflare account. Confirm that it is managed by this account and is Active, then try again.${error instanceof Error ? ` Reason: ${error.message}` : ''}`,
          ),
          { cause: error },
        );
      }
    }
  }

  async obtainEmailRoutingConsent(domains, input) {
    if (input.emailRoutingConsent === true) return;
    const confirmed = await this.ui.confirm(
      msg(
        `即将为 ${joinList(domains)} 接管邮件接收：启用 Email Routing、更新必要 MX，并把 Catch-all 交给安装器 Worker。已有邮件服务可能中断，是否继续？`,
        `The installer is about to take over mail reception for ${joinList(domains)}: enable Email Routing, update required MX records, and assign Catch-all to the installer Worker. Existing mail services may be interrupted. Continue?`,
      ),
      false,
    );
    if (!confirmed) {
      throw new Error(msg(
        '未授权安装器配置 Email Routing。未修改邮件 MX，也未创建部署资源。',
        'You did not authorize the installer to configure Email Routing. Mail MX records were not changed and deployment resources were not created.',
      ));
    }
  }

  async enableEmailRouting(domains) {
    this.ui.step(msg('启用 Cloudflare Email Routing', 'Enable Cloudflare Email Routing'));
    for (const domain of domains) {
      try {
        if (typeof this.cloudflare.enableEmailRouting === 'function') {
          this.cloudflare.enableEmailRouting(domain);
        }
        this.ui.info(msg(`Email Routing 已启用：${domain}`, `Email Routing enabled: ${domain}`));
      } catch (error) {
        throw new Error(
          msg(
            `域名 ${domain} 的 Email Routing 启用失败。核心 Worker 不受影响，安装器没有继续接管邮件；请检查域名 Active 状态和现有 MX 后重试。${error instanceof Error ? ` 原因：${error.message}` : ''}`,
            `Email Routing could not be enabled for ${domain}. The core Worker is unaffected and the installer did not continue taking over mail. Check the domain's Active status and existing MX records, then retry.${error instanceof Error ? ` Reason: ${error.message}` : ''}`,
          ),
          { cause: error },
        );
      }
    }
  }

  async verifyEmailRoutingBindings(domains, workerName) {
    if (typeof this.cloudflare.getEmailRoutingRules !== 'function') return;
    this.ui.step(msg('在线核验 Email Routing Catch-all', 'Verify Email Routing Catch-all online'));
    const expected = new RegExp(
      `Catch-all rule:\\s*enabled,\\s*action:\\s*worker:${escapeRegExp(workerName)}(?:\\s|,|$)`,
      'i',
    );
    for (const domain of domains) {
      const output = stripAnsi(this.cloudflare.getEmailRoutingRules(domain));
      if (!expected.test(output)) {
        throw new Error(
          msg(
            `域名 ${domain} 的 Catch-all 在线验收失败：没有确认它已启用并指向 ${workerName}。请打开 Cloudflare Email Routing 核对规则后重试。`,
            `Online Catch-all verification failed for ${domain}: it was not confirmed as enabled and targeting ${workerName}. Open Cloudflare Email Routing, check the rule, and retry.`,
          ),
        );
      }
      this.ui.info(msg(`Catch-all 已确认：${domain} → ${workerName}`, `Catch-all confirmed: ${domain} -> ${workerName}`));
    }
  }

  async deployWorkerWithRouting(upstreamDir, workerName) {
    try {
      return this.cloudflare.deployUpstreamWorker(upstreamDir, { routing: true });
    } catch (error) {
      if (!isEmailRoutingConflictError(error)) throw error;
      const confirmed = await this.ui.confirm(
        msg(
          `检测到 ${workerName} 的 Email Routing 已有 Catch-all 或其他规则。继续会接管这些冲突规则，是否确认？`,
          `${workerName} already has a Catch-all or other Email Routing rules. Continuing will take over these conflicting rules. Confirm?`,
        ),
        false,
      );
      if (!confirmed) {
        throw new Error(msg(
          '未确认接管已有 Catch-all。Worker 可能已上传，但邮件路由没有被修改；重新运行时可再次确认。',
          'Takeover of the existing Catch-all was not confirmed. The Worker may be uploaded, but mail routing was not changed. You can confirm it when rerunning.',
        ), { cause: error });
      }
      this.ui.info(msg(
        '已确认接管冲突规则，正在以交互方式重试 Email Routing 部署；请在 Wrangler 提示中再次确认。',
        'Conflicting-rule takeover confirmed. Retrying Email Routing deployment interactively; confirm it again in the Wrangler prompt.',
      ));
      const retryOutput = this.cloudflare.deployUpstreamWorker(upstreamDir, { routing: true, interactive: true });
      return [error?.output, error?.stdout, error?.stderr, error?.message, retryOutput].filter(Boolean).join('\n');
    }
  }

  async ensureProject(name, existingState) {
    const projects = this.cloudflare.listProjects();
    const existing = findProject(projects, name);
    if (existing) {
      const known = [existingState?.adminProject, existingState?.webmailProject].includes(name);
      if (!known && !await this.ui.confirm(msg(`Pages 项目 ${name} 已存在，是否复用？`, `Pages project ${name} already exists. Reuse it?`), false)) {
        throw new Error(msg(
          `未复用已有 Pages 项目 ${name}。请换一个项目名称前缀后重试。`,
          `Existing Pages project ${name} was not reused. Choose a different project prefix and retry.`,
        ));
      }
      this.ui.info(msg(`复用 Pages 项目：${name}`, `Reusing Pages project: ${name}`));
      return existing;
    }
    this.ui.info(msg(`创建 Pages 项目：${name}`, `Creating Pages project: ${name}`));
    this.cloudflare.createProject(name);
    const created = findProject(this.cloudflare.listProjects(), name);
    if (!created) {
      throw new Error(msg(
        `Pages 项目 ${name} 创建后未出现在项目列表中。`,
        `Pages project ${name} was created but is missing from the project list.`,
      ));
    }
    return created;
  }

  async ensureKv(title, knownId) {
    const namespaces = this.cloudflare.listKvNamespaces();
    if (knownId) {
      const known = namespaces.find((item) => item.id === knownId);
      if (known) {
        this.ui.info(msg(`复用 KV：${known.title || title}`, `Reusing KV: ${known.title || title}`));
        return known;
      }
      this.ui.info(msg(
        `断点记录的 KV ${title}（${knownId}）已不存在，将重新检查同名资源。`,
        `The checkpointed KV ${title} (${knownId}) no longer exists; checking for a resource with the same name.`,
      ));
    }

    const existing = findNamespace(namespaces, title);
    if (existing) {
      if (!await this.ui.confirm(msg(`KV ${title} 已存在，但与当前断点 ID 不一致，是否复用？`, `KV ${title} exists but has a different checkpoint ID. Reuse it?`), false)) {
        throw new Error(msg(
          `未复用已有 KV ${title}。请换一个项目名称前缀后重试。`,
          `Existing KV ${title} was not reused. Choose a different project prefix and retry.`,
        ));
      }
      this.ui.info(msg(`复用 KV：${existing.title}`, `Reusing KV: ${existing.title}`));
      return existing;
    }
    this.ui.info(msg(`创建 KV：${title}`, `Creating KV: ${title}`));
    return this.cloudflare.createKvNamespace(title);
  }

  async reuseVerifiedWorker({ previous, plan, input, requireEmailRouting = true }) {
    if (
      previous?.workerDeploymentConfirmed !== true
      || previous?.workerProject !== plan.resources.workerName
      || !sameDomains(stateDomains(previous), plan.domains)
      || previous?.upstreamCommit !== plan.upstream.commit
      || !previous?.databaseId
      || !previous?.managedWorkerOrigin
    ) return null;

    let workerUrl;
    try {
      workerUrl = validateManagedWorkerOrigin(previous.managedWorkerOrigin);
    } catch {
      this.ui.info(msg(
        '断点中的 Worker 公开地址不可信，将重新部署 Worker。',
        'The checkpointed Worker URL is not trusted; redeploying the Worker.',
      ));
      return null;
    }

    const databases = this.cloudflare.listD1Databases();
    const database = databases.find((item) => (item?.uuid ?? item?.id) === previous.databaseId);
    if (!database) {
      this.ui.info(msg(
        `已保存的 D1 ${previous.databaseName || plan.resources.databaseName} 不再存在，将重新部署 Worker。`,
        `The saved D1 database ${previous.databaseName || plan.resources.databaseName} no longer exists; redeploying the Worker.`,
      ));
      return null;
    }

    const workerExists = typeof this.cloudflare.workerExistsByName === 'function'
      ? this.cloudflare.workerExistsByName(plan.resources.workerName)
      : false;
    if (!workerExists) {
      this.ui.info(msg(
        `已保存的 Worker ${plan.resources.workerName} 不再存在，将重新创建。`,
        `The saved Worker ${plan.resources.workerName} no longer exists; creating it again.`,
      ));
      return null;
    }

    const existingSecrets = typeof this.cloudflare.listWorkerSecretsByName === 'function'
      ? this.cloudflare.listWorkerSecretsByName(plan.resources.workerName)
      : new Set();
    if (!existingSecrets.has('JWT_SECRET') || !existingSecrets.has('ADMIN_PASSWORDS')) {
      this.ui.info(msg(
        `Worker ${plan.resources.workerName} 缺少安装器必需的 Secret，将重新部署并修复。`,
        `Worker ${plan.resources.workerName} is missing installer-required Secrets; redeploying to repair it.`,
      ));
      return null;
    }
    if (existingSecrets.has('PASSWORDS') && !input.sitePassword) {
      throw new Error(msg(
        '现有 Worker 已配置站点密码。为安全续装，请重新运行并输入当前 Worker 站点密码；安装器不会读取、移除或猜测现有 PASSWORDS Secret。',
        'The existing Worker has a site password. Rerun and enter the current Worker site password to resume safely; the installer will not read, remove, or guess the existing PASSWORDS Secret.',
      ));
    }
    if (!existingSecrets.has('PASSWORDS') && input.sitePassword) {
      const confirmed = await this.ui.confirm(msg(
        '现有 Worker 未启用站点密码。本次输入会重新部署 Worker 并启用站点密码，是否继续？',
        'The existing Worker has no site password. This input will redeploy the Worker and enable one. Continue?',
      ), false);
      if (!confirmed) {
        throw new Error(msg(
          '未确认启用 Worker 站点密码。请留空重试，或在确认后重新运行。',
          'Enabling the Worker site password was not confirmed. Leave it blank and retry, or rerun after confirming.',
        ));
      }
      return null;
    }

    await this.verifyWorkerAccess({
      workerUrl,
      adminPassword: input.adminPassword,
      sitePassword: input.sitePassword,
    });
    try {
      await this.verifyManagedWorkerDomains({
        workerUrl,
        adminPassword: input.adminPassword,
        sitePassword: input.sitePassword,
        domains: plan.domains,
      });
    } catch (error) {
      this.ui.info(msg(
        `已保存的 Worker 域名配置未通过验收，将重新部署修复：${error instanceof Error ? error.message : error}`,
        `The saved Worker domain configuration failed verification; redeploying to repair it: ${error instanceof Error ? error.message : error}`,
      ));
      return null;
    }
    if (requireEmailRouting) {
      await this.verifyEmailRoutingBindings(plan.domains, plan.resources.workerName);
    }
    await this.bootstrapAdminUser({
      workerUrl,
      adminPassword: input.adminPassword,
      email: input.adminEmail,
      password: input.adminUserPassword,
      sitePassword: input.sitePassword,
    });
    this.ui.info(requireEmailRouting
      ? msg(
        `复用已验证的 Worker：${plan.resources.workerName}；不会覆盖后来手工增加的发件或其他 binding。`,
        `Reusing verified Worker ${plan.resources.workerName}; later manual outbound-mail settings and other bindings will not be overwritten.`,
      )
      : msg(
        `核心 Worker ${plan.resources.workerName} 已重新验收，将从 Email Routing 阶段继续。`,
        `Core Worker ${plan.resources.workerName} was verified again; resuming from the Email Routing phase.`,
      ));
    return {
      workerUrl,
      database: {
        name: database.name || previous.databaseName || plan.resources.databaseName,
        id: previous.databaseId,
      },
    };
  }

  async run(input, { authenticatedAccount, workerVerified = false, installMode = 'existing-worker' } = {}) {
    const plan = createInstallPlan(input);
    const saved = readState(this.rootDir);
    const account = authenticatedAccount || await this.ensureAuthentication();
    if (authenticatedAccount) this.cloudflare.useAccount(account.id);
    const previous = saved?.accountId === account.id && saved?.prefix === plan.resources.prefix ? saved : null;
    let state = writeState(this.rootDir, {
      ...previous,
      accountId: account.id,
      prefix: plan.resources.prefix,
      installMode,
      ...(installMode === 'existing-worker' ? {
        domain: undefined,
        domains: undefined,
        workerProject: undefined,
        workerDeploymentConfirmed: undefined,
        databaseName: undefined,
        databaseId: undefined,
        upstreamCommit: undefined,
        managedWorkerOrigin: undefined,
      } : {}),
      phase: 'authenticated',
    });

    this.ui.step(msg('安装依赖并检查公开配置', 'Install dependencies and check public configuration'));
    this.cloudflare.installDependencies();
    this.cloudflare.validateAndBuild();
    state = writeState(this.rootDir, { ...state, phase: 'built' });

    if (!workerVerified) {
      this.ui.step(msg('检查邮件 Worker 与管理员口令', 'Check the mail Worker and administrator secret'));
      await this.verifyWorkerAccess({
        workerUrl: plan.workerUrl,
        adminPassword: input.adminPassword,
        sitePassword: input.sitePassword,
      });
      state = writeState(this.rootDir, { ...state, phase: 'worker-verified' });
    }

    this.ui.step(msg('创建或复用 Cloudflare 资源', 'Create or reuse Cloudflare resources'));
    const adminProject = await this.ensureProject(plan.resources.adminProject, previous);
    const webmailProject = await this.ensureProject(plan.resources.webmailProject, previous);
    const shareKv = await this.ensureKv(plan.resources.shareKv, previous?.shareKvId);
    const mailStateKv = await this.ensureKv(plan.resources.mailStateKv, previous?.mailStateKvId);
    const adminOrigin = projectOrigin(adminProject, plan.resources.adminProject);
    const webmailOrigin = projectOrigin(webmailProject, plan.resources.webmailProject);
    state = writeState(this.rootDir, {
      ...state,
      adminProject: plan.resources.adminProject,
      webmailProject: plan.resources.webmailProject,
      shareKvId: shareKv.id,
      mailStateKvId: mailStateKv.id,
      adminOrigin,
      webmailOrigin,
      phase: 'resources-ready',
    });

    this.ui.step(msg('安全写入 Pages Secret', 'Write Pages Secrets securely'));
    const webmailSecrets = this.cloudflare.listPagesSecrets(state.webmailProject);
    this.cloudflare.putPagesSecret(state.adminProject, 'MAIL_WORKER_BASE_URL', plan.workerUrl);
    this.cloudflare.putPagesSecret(state.adminProject, 'ADMIN_PASSWORD', input.adminPassword);
    this.cloudflare.putPagesSecret(state.webmailProject, 'MAIL_WORKER_BASE_URL', plan.workerUrl);
    if (!webmailSecrets.has('SHARE_ENCRYPTION_SECRET_V2')) {
      this.cloudflare.putPagesSecret(state.webmailProject, 'SHARE_ENCRYPTION_SECRET_V2', randomBytes(32).toString('hex'));
    } else {
      this.ui.info(msg(
        '保留现有 SHARE_ENCRYPTION_SECRET_V2，旧分享链接不会因重复安装失效。',
        'Keeping the existing SHARE_ENCRYPTION_SECRET_V2; old share links will remain valid after a repeated installation.',
      ));
    }
    if (input.sitePassword) {
      this.cloudflare.putPagesSecret(state.adminProject, 'SITE_PASSWORD', input.sitePassword);
      this.cloudflare.putPagesSecret(state.webmailProject, 'SITE_PASSWORD', input.sitePassword);
    } else {
      const adminSecrets = this.cloudflare.listPagesSecrets(state.adminProject);
      if (adminSecrets.has('SITE_PASSWORD') || webmailSecrets.has('SITE_PASSWORD')) {
        throw new Error(msg(
          'Pages 已保存 SITE_PASSWORD，但本次未输入 Worker 站点密码。请重新运行并输入当前站点密码；如已关闭 Worker 站点密码，请先在两个 Pages 项目中明确删除旧 SITE_PASSWORD Secret。',
          'Pages has a saved SITE_PASSWORD, but no Worker site password was entered this time. Rerun and enter the current site password; if site-password protection was disabled, explicitly delete the old SITE_PASSWORD Secret from both Pages projects first.',
        ));
      }
    }
    state = writeState(this.rootDir, { ...state, phase: 'secrets-ready' });

    this.ui.step(msg('部署 Admin', 'Deploy Admin'));
    this.cloudflare.deployWithConfig({
      app: 'admin',
      projectName: state.adminProject,
      config: renderPagesConfig({
        name: state.adminProject,
        app: 'admin',
        mailStateKvId: state.mailStateKvId,
      }),
    });

    this.ui.step(msg('部署 Webmail', 'Deploy Webmail'));
    this.cloudflare.deployWithConfig({
      app: 'webmail',
      projectName: state.webmailProject,
      config: renderPagesConfig({
        name: state.webmailProject,
        app: 'webmail',
        adminOrigin: state.adminOrigin,
        shareKvId: state.shareKvId,
        mailStateKvId: state.mailStateKvId,
      }),
    });
    state = writeState(this.rootDir, { ...state, phase: 'deployed' });

    this.ui.step(msg('运行在线验收', 'Run online verification'));
    await this.probe(`${state.adminOrigin}/admin/users?limit=1&offset=0`, (body) => {
      let data;
      try { data = JSON.parse(body); } catch {
        return { ok: false, message: msg('Admin 代理没有返回 JSON。', 'The Admin proxy did not return JSON.') };
      }
      const rows = Array.isArray(data) ? data : data?.results;
      return Array.isArray(rows)
        ? { ok: true, value: data }
        : { ok: false, message: msg('Admin 代理返回了无法识别的用户列表。', 'The Admin proxy returned an unrecognized user list.') };
    }, 'Admin proxy', { headers: { 'x-admin-auth': input.adminPassword } });
    const runtime = await this.probe(`${state.webmailOrigin}/api/runtime`, (body) => {
      let data;
      try { data = JSON.parse(body); } catch {
        return { ok: false, message: msg('Webmail /api/runtime 没有返回 JSON。', 'Webmail /api/runtime did not return JSON.') };
      }
      return data.ok === true
        ? { ok: true, value: data }
        : { ok: false, message: msg(
          `Webmail 运行时配置不完整：${(data.missing || []).join(', ') || '未知缺失项'}`,
          `Webmail runtime configuration is incomplete: ${(data.missing || []).join(', ') || 'unknown missing item'}`,
        ) };
    }, 'Webmail runtime');
    state = writeState(this.rootDir, { ...state, phase: 'complete' });
    return { state, runtime, plan };
  }

  async runNewWorker(input, { authenticatedAccount } = {}) {
    const plan = createUpstreamInstallPlan(input);
    const saved = readState(this.rootDir);
    const account = authenticatedAccount || await this.ensureAuthentication();
    if (authenticatedAccount) this.cloudflare.useAccount(account.id);
    const previous = saved?.accountId === account.id && saved?.prefix === plan.resources.prefix ? saved : null;
    const previousDomains = stateDomains(previous);
    if (previousDomains.length && !sameDomains(previousDomains, plan.domains)) {
      const confirmed = await this.ui.confirm(
        msg(
          `此前前缀 ${plan.resources.prefix} 使用域名 ${joinList(previousDomains)}，本次输入为 ${joinList(plan.domains)}。继续会替换现有 Worker 的完整邮箱域名列表；第一个域名是默认域名。是否继续？`,
          `Prefix ${plan.resources.prefix} previously used ${joinList(previousDomains)}, but this run entered ${joinList(plan.domains)}. Continuing will replace the existing Worker mail-domain list; the first domain is the default. Continue?`,
        ),
        false,
      );
      if (!confirmed) {
        throw new Error(msg(
          '未确认修改现有 Worker 的邮箱域名列表。请使用原域名列表或换一个项目名称前缀后重试。',
          'Changing the existing Worker mail-domain list was not confirmed. Use the original domains or choose a different project prefix and retry.',
        ));
      }
    }
    if (previous?.upstreamCommit && previous.upstreamCommit !== plan.upstream.commit) {
      const confirmed = await this.ui.confirm(
        msg(
          `锁定的兼容 Worker 已从 ${previous.upstreamCommit.slice(0, 12)} 更新为 ${plan.upstream.commit.slice(0, 12)}，是否升级现有 Worker？`,
          `The pinned compatible Worker changed from ${previous.upstreamCommit.slice(0, 12)} to ${plan.upstream.commit.slice(0, 12)}. Upgrade the existing Worker?`,
        ),
        false,
      );
      if (!confirmed) {
        throw new Error(msg(
          '未确认升级现有 Worker。请保留原锁定版本或换一个项目名称前缀后重试。',
          'Upgrading the existing Worker was not confirmed. Keep the original pinned version or choose a different project prefix and retry.',
        ));
      }
    }
    await this.verifyEmailRoutingDomains(plan.domains);
    await this.obtainEmailRoutingConsent(plan.domains, input);
    const sameCheckpointPlan = Boolean(previous)
      && sameDomains(previousDomains, plan.domains)
      && previous?.upstreamCommit === plan.upstream.commit;
    const previousRoutingDomains = stateDomains({ domains: previous?.emailRoutingDomains });
    const keepRoutingCheckpoint = sameCheckpointPlan
      && sameDomains(previousRoutingDomains, plan.domains)
      && previous?.emailRoutingWorker === plan.resources.workerName;
    let state = writeState(this.rootDir, {
      ...previous,
      accountId: account.id,
      prefix: plan.resources.prefix,
      installMode: 'new-worker',
      domain: plan.domain,
      domains: plan.domains,
      ...(keepRoutingCheckpoint ? {} : { emailRoutingDomains: undefined, emailRoutingWorker: undefined }),
      ...(!sameCheckpointPlan ? {
        workerProject: undefined,
        workerDeploymentConfirmed: undefined,
        managedWorkerOrigin: undefined,
      } : {}),
      phase: sameCheckpointPlan && previous?.phase ? previous.phase : 'authenticated',
    });

    const coreResumePhases = ['worker-core-ready', 'email-routing-ready'];
    const reusableWorker = sameCheckpointPlan
      && !coreResumePhases.includes(previous?.phase)
      && (['worker-ready', 'complete'].includes(previous?.phase) || keepRoutingCheckpoint)
      ? await this.reuseVerifiedWorker({ previous, plan, input })
      : null;
    if (reusableWorker) {
      const frontendResult = await this.run(
        { ...input, workerUrl: reusableWorker.workerUrl },
        { authenticatedAccount: account, workerVerified: true, installMode: 'new-worker' },
      );
      return {
        ...frontendResult,
        state: writeState(this.rootDir, {
          ...frontendResult.state,
          domain: plan.domain,
          domains: plan.domains,
          workerProject: plan.resources.workerName,
          workerDeploymentConfirmed: true,
          emailRoutingDomains: plan.domains,
          emailRoutingWorker: plan.resources.workerName,
          databaseName: reusableWorker.database.name,
          databaseId: reusableWorker.database.id,
          upstreamCommit: plan.upstream.commit,
          phase: 'complete',
        }),
        plan,
      };
    }

    const resumableCore = sameCheckpointPlan && coreResumePhases.includes(previous?.phase)
      ? await this.reuseVerifiedWorker({ previous, plan, input, requireEmailRouting: false })
      : null;

    const scratch = mkdtempSync(join(this.rootDir, '.loven7-installer-'));
    const upstreamDir = join(scratch, 'upstream');
    try {
      this.ui.step(msg('下载并准备锁定版本的兼容 Worker', 'Download and prepare the pinned compatible Worker'));
      const commit = this.cloudflare.cloneUpstream({
        repository: plan.upstream.repository,
        release: plan.upstream.release,
        destination: upstreamDir,
      });
      if (commit !== plan.upstream.commit) {
        throw new Error(msg(
          `兼容 Worker 版本校验失败：期望 ${plan.upstream.commit}，实际 ${commit}。`,
          `Compatible Worker version verification failed: expected ${plan.upstream.commit}, received ${commit}.`,
        ));
      }
      this.cloudflare.installUpstreamDependencies(upstreamDir);
      state = writeState(this.rootDir, {
        ...state,
        upstreamCommit: commit,
        phase: resumableCore ? previous.phase : 'upstream-ready',
      });

      let database;
      let workerUrl;
      let managedWorkerOrigin;

      if (resumableCore) {
        database = resumableCore.database;
        workerUrl = resumableCore.workerUrl;
        managedWorkerOrigin = validateManagedWorkerOrigin(workerUrl);
        state = writeState(this.rootDir, {
          ...state,
          workerProject: plan.resources.workerName,
          workerDeploymentConfirmed: true,
          databaseName: database.name,
          databaseId: database.id,
          managedWorkerOrigin,
          phase: previous.phase,
        });
      } else {
        this.ui.step(msg('创建或复用 D1 并初始化数据库', 'Create or reuse D1 and initialize the database'));
        database = await this.ensureD1(plan.resources.databaseName, {
          knownId: previous?.databaseId,
          knownName: previous?.databaseName,
        });
        this.cloudflare.executeD1Schema(database.name, join(upstreamDir, 'db', 'schema.sql'), upstreamDir);
        state = writeState(this.rootDir, { ...state, databaseName: database.name, databaseId: database.id, phase: 'database-ready' });

        this.ui.step(msg('部署不接管邮件的核心 Worker', 'Deploy the core Worker without taking over mail'));
        this.cloudflare.writeUpstreamConfig(upstreamDir, renderUpstreamWorkerConfig({
          workerName: plan.resources.workerName,
          domains: plan.domains,
          databaseName: database.name,
          databaseId: database.id,
          includeEmailRouting: false,
        }));
        const workerExists = typeof this.cloudflare.workerExists === 'function'
          ? this.cloudflare.workerExists(upstreamDir, plan.resources.workerName)
          : false;
        const knownWorker = previous?.workerProject === plan.resources.workerName
          && previous?.workerDeploymentConfirmed === true;
        if (workerExists && !knownWorker && !await this.ui.confirm(msg(
          `Worker ${plan.resources.workerName} 已存在，继续会更新它，是否复用？`,
          `Worker ${plan.resources.workerName} already exists and will be updated. Reuse it?`,
        ), false)) {
          throw new Error(msg(
            `未复用已有 Worker ${plan.resources.workerName}。请换一个项目名称前缀后重试。`,
            `Existing Worker ${plan.resources.workerName} was not reused. Choose a different project prefix and retry.`,
          ));
        }
        const existingWorkerSecrets = typeof this.cloudflare.listWorkerSecrets === 'function'
          ? this.cloudflare.listWorkerSecrets(upstreamDir, plan.resources.workerName)
          : new Set();
        if (existingWorkerSecrets.has('PASSWORDS') && !input.sitePassword) {
          throw new Error(msg(
            '现有 Worker 已配置站点密码。为安全续装，请重新运行并输入当前 Worker 站点密码；安装器不会读取、移除或猜测现有 PASSWORDS Secret。',
            'The existing Worker has a site password. Rerun and enter the current Worker site password to resume safely; the installer will not read, remove, or guess the existing PASSWORDS Secret.',
          ));
        }
        const secrets = {
          ADMIN_PASSWORDS: JSON.stringify([input.adminPassword]),
        };
        if (!existingWorkerSecrets.has('JWT_SECRET')) secrets.JWT_SECRET = randomBytes(32).toString('hex');
        if (input.sitePassword) secrets.PASSWORDS = JSON.stringify([input.sitePassword]);

        const deployOutput = this.cloudflare.deployUpstreamWorker(upstreamDir);
        this.cloudflare.putWorkerSecrets(upstreamDir, plan.resources.workerName, secrets);
        workerUrl = typeof this.cloudflare.getWorkerUrl === 'function'
          ? this.cloudflare.getWorkerUrl(plan.resources.workerName, deployOutput)
          : extractWorkerUrl(deployOutput, plan.resources.workerName);
        await this.verifyWorkerAccess({
          workerUrl,
          adminPassword: input.adminPassword,
          sitePassword: input.sitePassword,
        });
        await this.verifyManagedWorkerDomains({
          workerUrl,
          adminPassword: input.adminPassword,
          sitePassword: input.sitePassword,
          domains: plan.domains,
        });
        await this.bootstrapAdminUser({
          workerUrl,
          adminPassword: input.adminPassword,
          email: input.adminEmail,
          password: input.adminUserPassword,
          sitePassword: input.sitePassword,
        });
        managedWorkerOrigin = validateManagedWorkerOrigin(workerUrl);
        state = writeState(this.rootDir, {
          ...state,
          workerProject: plan.resources.workerName,
          workerDeploymentConfirmed: true,
          managedWorkerOrigin,
          phase: 'worker-core-ready',
        });
        this.ui.info(msg(
          `核心 Worker 已验收：${workerUrl}；尚未修改邮件 MX 或 Catch-all。`,
          `Core Worker verified: ${workerUrl}; mail MX and Catch-all have not been changed.`,
        ));
      }

      if (!(resumableCore && previous?.phase === 'email-routing-ready')) {
        await this.enableEmailRouting(plan.domains);
        state = writeState(this.rootDir, { ...state, phase: 'email-routing-ready' });
      } else {
        this.ui.info(msg(
          '断点显示 Email Routing 已启用，将直接继续应用 Catch-all。',
          'The checkpoint shows that Email Routing is enabled; continuing directly with Catch-all application.',
        ));
      }

      this.ui.step(msg('应用并核验 Email Routing Catch-all', 'Apply and verify Email Routing Catch-all'));
      this.cloudflare.writeUpstreamConfig(upstreamDir, renderUpstreamWorkerConfig({
        workerName: plan.resources.workerName,
        domains: plan.domains,
        databaseName: database.name,
        databaseId: database.id,
        includeEmailRouting: true,
      }));
      await this.deployWorkerWithRouting(upstreamDir, plan.resources.workerName);
      await this.verifyEmailRoutingBindings(plan.domains, plan.resources.workerName);
      state = writeState(this.rootDir, {
        ...state,
        workerProject: plan.resources.workerName,
        workerDeploymentConfirmed: true,
        emailRoutingDomains: plan.domains,
        emailRoutingWorker: plan.resources.workerName,
        managedWorkerOrigin,
        phase: 'worker-ready',
      });

      this.ui.info(msg(
        `Worker 与 Email Routing 已完成在线验收：${workerUrl}`,
        `Worker and Email Routing passed online verification: ${workerUrl}`,
      ));
      const frontendResult = await this.run(
        { ...input, workerUrl },
        { authenticatedAccount: account, workerVerified: true, installMode: 'new-worker' },
      );
      return {
        ...frontendResult,
        state: writeState(this.rootDir, {
          ...frontendResult.state,
          domain: plan.domain,
          domains: plan.domains,
          managedWorkerOrigin,
          databaseName: database.name,
          databaseId: database.id,
          workerProject: plan.resources.workerName,
          workerDeploymentConfirmed: true,
          emailRoutingDomains: plan.domains,
          emailRoutingWorker: plan.resources.workerName,
          upstreamCommit: commit,
          phase: 'complete',
        }),
        plan,
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async ensureD1(name, { knownId, knownName = name } = {}) {
    const databases = this.cloudflare.listD1Databases();
    const databaseId = (item) => item?.uuid ?? item?.id;

    if (knownId) {
      const known = databases.find((item) => databaseId(item) === knownId);
      if (known) {
        const actualName = known.name || knownName;
        if (actualName !== knownName && !await this.ui.confirm(msg(
          `断点记录的 D1 ${knownName} 仍存在，但当前名称是 ${actualName}，是否复用？`,
          `The checkpointed D1 ${knownName} still exists, but its current name is ${actualName}. Reuse it?`,
        ), false)) {
          throw new Error(msg(
            `未复用已改名的 D1 ${actualName}。请恢复名称或换一个项目名称前缀后重试。`,
            `Renamed D1 ${actualName} was not reused. Restore its name or choose a different project prefix and retry.`,
          ));
        }
        this.ui.info(msg(`复用 D1：${actualName}`, `Reusing D1: ${actualName}`));
        return { name: actualName, id: knownId };
      }
      this.ui.info(msg(
        `断点记录的 D1 ${knownName}（${knownId}）已不存在，将重新检查同名资源。`,
        `The checkpointed D1 ${knownName} (${knownId}) no longer exists; checking for a resource with the same name.`,
      ));
    }

    const candidateNames = [...new Set([knownName, name].filter(Boolean))];
    const existing = candidateNames
      .map((candidate) => databases.find((item) => item.name === candidate))
      .find(Boolean);
    const existingId = databaseId(existing);
    if (existingId) {
      if (!await this.ui.confirm(msg(
        `D1 ${existing.name} 已存在，但与当前断点 ID 不一致，是否复用并执行兼容 schema？`,
        `D1 ${existing.name} exists but has a different checkpoint ID. Reuse it and run the compatible schema?`,
      ), false)) {
        throw new Error(msg(
          `未复用已有 D1 ${existing.name}。请换一个项目名称前缀后重试。`,
          `Existing D1 ${existing.name} was not reused. Choose a different project prefix and retry.`,
        ));
      }
      this.ui.info(msg(`复用 D1：${existing.name}`, `Reusing D1: ${existing.name}`));
      return { name: existing.name, id: existingId };
    }

    this.ui.info(msg(`创建 D1：${name}`, `Creating D1: ${name}`));
    return this.cloudflare.createD1Database(name);
  }

  async bootstrapAdminUser({ workerUrl, adminPassword, email, password, sitePassword }) {
    const normalizedEmail = validateAdminEmail(email);
    if (!normalizedEmail || !password) {
      throw new Error(msg(
        '首个管理员账号和登录密码不能为空。',
        'The first administrator email and login password cannot be empty.',
      ));
    }
    const passwordHash = await sha256Hex(password);
    const siteHeaders = sitePassword ? { 'x-custom-auth': sitePassword } : {};
    const create = await requestJson(`${workerUrl}/admin/users`, {
      method: 'POST',
      headers: { ...siteHeaders, 'x-admin-auth': adminPassword },
      body: { email: normalizedEmail, password: passwordHash },
      label: msg('首个管理员创建', 'First administrator creation'),
    });
    if (!create.response.ok && create.response.status !== 400) {
      throw new Error(msg(
        `首个管理员创建失败：HTTP ${create.response.status} ${create.text.slice(0, 160)}`,
        `First administrator creation failed: HTTP ${create.response.status} ${create.text.slice(0, 160)}`,
      ));
    }
    const users = await requestJson(`${workerUrl}/admin/users?limit=20&offset=0&query=${encodeURIComponent(normalizedEmail)}`, {
      headers: { ...siteHeaders, 'x-admin-auth': adminPassword },
      label: msg('首个管理员查询', 'First administrator lookup'),
    });
    if (!users.response.ok) {
      throw new Error(msg(
        `首个管理员查询失败：HTTP ${users.response.status} ${users.text.slice(0, 160)}`,
        `First administrator lookup failed: HTTP ${users.response.status} ${users.text.slice(0, 160)}`,
      ));
    }
    const rows = Array.isArray(users.data) ? users.data : Array.isArray(users.data?.results) ? users.data.results : [];
    const user = rows.find((item) => String(item?.user_email || '').trim().toLowerCase() === normalizedEmail);
    if (!user?.id) {
      throw new Error(msg(
        '首个管理员账号创建后未出现在 Worker 用户列表中。',
        'The first administrator account was created but is missing from the Worker user list.',
      ));
    }
    const login = await requestJson(`${workerUrl}/user_api/login`, {
      method: 'POST',
      headers: siteHeaders,
      body: { email: normalizedEmail, password: passwordHash },
      label: msg('首个管理员登录验收', 'First administrator login verification'),
    });
    if (!login.response.ok || !login.data?.jwt) {
      throw new Error(msg(
        '首个管理员账号已存在但登录密码与本次输入不匹配；安装器没有修改角色或覆盖原密码。请使用原密码，或换一个管理员邮箱重试。',
        'The first administrator already exists, but its login password does not match this input. The installer did not change its role or overwrite its password. Use the original password or retry with another administrator email.',
      ));
    }
    const role = await requestJson(`${workerUrl}/admin/user_roles`, {
      method: 'POST',
      headers: { ...siteHeaders, 'x-admin-auth': adminPassword },
      body: { user_id: user.id, role_text: 'admin' },
      label: msg('首个管理员授权', 'First administrator authorization'),
    });
    if (!role.response.ok) {
      throw new Error(msg(
        `首个管理员授权失败：HTTP ${role.response.status} ${role.text.slice(0, 160)}`,
        `First administrator authorization failed: HTTP ${role.response.status} ${role.text.slice(0, 160)}`,
      ));
    }
    const profile = await requestJson(`${workerUrl}/user_api/settings`, {
      headers: {
        ...siteHeaders,
        authorization: `Bearer ${login.data.jwt}`,
        'x-user-token': login.data.jwt,
      },
      label: msg('首个管理员权限验收', 'First administrator permission verification'),
    });
    if (!profile.response.ok || profile.data?.is_admin !== true || !profile.data?.access_token) {
      throw new Error(msg(
        '首个管理员账号已创建，但 Worker 没有返回管理员权限令牌。请检查 ADMIN_USER_ROLE 与 USER_ROLES 配置。',
        'The first administrator was created, but the Worker did not return an administrator permission token. Check ADMIN_USER_ROLE and USER_ROLES.',
      ));
    }
    this.ui.success(msg(`首个管理员账号已就绪：${normalizedEmail}`, `First administrator ready: ${normalizedEmail}`));
  }
}

export function extractWorkerUrl(output, workerName) {
  const match = String(output || '').match(/https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.workers\.dev(?:\/[^\s"'<>]*)?/i);
  if (match?.[0]) return match[0].replace(/[),.;]+$/, '').replace(/\/$/, '');
  throw new Error(msg(
    `Worker ${workerName} 已部署，但无法从 Wrangler 输出中确定公开地址。请在 Cloudflare Dashboard 查看地址后重新运行已有 Worker 模式。`,
    `Worker ${workerName} was deployed, but its public URL could not be determined from Wrangler output. Find it in the Cloudflare Dashboard, then rerun in existing Worker mode.`,
  ));
}
