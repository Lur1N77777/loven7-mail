#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudflareAdapter, CommandRunner } from './cloudflare.mjs';
import { createInstallPlan, createUpstreamInstallPlan, validateAdminEmail } from './domain.mjs';
import { joinList, msg, setInstallerLanguage } from './i18n.mjs';
import { Installer } from './installer.mjs';
import { ConsoleUi } from './ui.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);

function argValue(name) {
  const inline = args.find((item) => item.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : '';
}

function printPlan(plan) {
  console.log(msg('\nLoven7 Mail 安装计划', '\nLoven7 Mail installation plan'));
  console.log(`${msg('模式：', 'Mode: ')}${plan.mode === 'new-worker' ? msg('从零部署兼容 Worker', 'Deploy a compatible Worker from scratch') : msg('已有兼容 Worker', 'Use an existing compatible Worker')}`);
  if (plan.domains) {
    console.log(`${msg('邮箱域名：', 'Mail domains: ')}${joinList(plan.domains)}`);
    console.log(`${msg('默认域名：', 'Default domain: ')}${plan.domain}`);
  } else if (plan.domain) console.log(`${msg('邮箱域名：', 'Mail domain: ')}${plan.domain}`);
  if (plan.workerUrl) console.log(`${msg('Worker：', 'Worker: ')}${plan.workerUrl}`);
  console.log(`${msg('项目：', 'Projects: ')}${plan.resources.adminProject} / ${plan.resources.webmailProject}`);
  console.log(`${msg('KV：', 'KV: ')}${plan.resources.shareKv} / ${plan.resources.mailStateKv}`);
  if (plan.resources.workerName) console.log(`${msg('邮件 Worker：', 'Mail Worker: ')}${plan.resources.workerName}`);
  if (plan.resources.databaseName) console.log(`${msg('D1：', 'D1: ')}${plan.resources.databaseName}`);
  console.log(msg('\n自动执行：', '\nAutomated steps:'));
  plan.steps.forEach((step, index) => console.log(`  ${index + 1}. ${step}`));
  console.log(msg('\n仍需人工确认：', '\nManual verification still required:'));
  plan.manual.forEach((step) => console.log(`  - ${step}`));
}

const planOnly = args.includes('--plan');
const inheritedLanguage = process.env.LOVEN7_MAIL_LANG || '';
const hasLanguageOption = args.some((item) => item === '--lang' || item.startsWith('--lang='));
const languageOption = argValue('--lang');
try {
  if (hasLanguageOption && !languageOption) {
    throw new Error('参数 --lang 需要 zh-CN 或 en。 / --lang requires zh-CN or en.');
  }
  setInstallerLanguage(languageOption || inheritedLanguage || 'zh-CN');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(msg('安装器要求 Node.js 22 或更高版本。', 'The installer requires Node.js 22 or later.'));
  process.exit(1);
}

if (planOnly) {
  try {
    const prefix = argValue('--prefix') || 'loven7-mail';
    const domains = argValue('--domains') || argValue('--domain');
    const plan = args.includes('--new-worker')
      ? createUpstreamInstallPlan({ prefix, domains })
      : createInstallPlan({ prefix, workerUrl: argValue('--worker-url') || 'https://worker.example.com' });
    printPlan(plan);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
} else {
  const ui = new ConsoleUi();
  try {
    if (!hasLanguageOption && !inheritedLanguage) setInstallerLanguage(await ui.language());
    console.log(msg('\nLoven7 Mail 新手安装器', '\nLoven7 Mail beginner installer'));
    console.log(msg(
      '安装器支持已有 Worker 接入，也支持从锁定的兼容 Worker v1.10.0 开始部署。',
      'You can connect an existing Worker or deploy from the pinned compatible Worker v1.10.0.',
    ));
    console.log(msg(
      '输入的密码不会显示，也不会保存到仓库或安装状态文件。\n',
      'Passwords are hidden and are never saved to the repository or installer state.\n',
    ));
    const mode = args.includes('--new-worker') ? 'new-worker' : args.includes('--existing-worker') ? 'existing-worker' : await ui.mode();
    const prefix = await ui.text(msg('项目名称前缀', 'Project name prefix'), argValue('--prefix') || 'loven7-mail');
    const workerUrl = mode === 'existing-worker' ? await ui.text(msg('已有邮件 Worker 根地址', 'Existing mail Worker root URL'), argValue('--worker-url')) : '';
    const runner = new CommandRunner({ cwd: rootDir });
    const cloudflare = new CloudflareAdapter({ rootDir, runner });
    const installer = new Installer({ rootDir, cloudflare, ui });
    const authenticatedAccount = mode === 'new-worker'
      ? await installer.ensureAuthentication()
      : undefined;
    const domains = mode === 'new-worker'
      ? await ui.text(msg(
        '邮箱域名（多个用逗号分隔，第一个为默认域名；请输入刚才账号中已 Active 的域名）',
        'Mail domains (comma-separated; the first is the default; enter Active domains from the Cloudflare account selected above)',
      ), argValue('--domains') || argValue('--domain'))
      : '';
    const adminPassword = await ui.secret(msg('Worker 管理员口令', 'Worker administrator secret'));
    if (!adminPassword) throw new Error(msg('Worker 管理员口令不能为空。', 'The Worker administrator secret cannot be empty.'));
    const adminEmail = mode === 'new-worker' ? validateAdminEmail(await ui.text(msg('首个管理员登录邮箱', 'First administrator login email'))) : '';
    const adminUserPassword = mode === 'new-worker' ? await ui.secret(msg('首个管理员登录密码', 'First administrator login password')) : '';
    if (mode === 'new-worker' && (!adminEmail || !adminUserPassword)) {
      throw new Error(msg('首个管理员账号和登录密码不能为空。', 'The first administrator email and login password cannot be empty.'));
    }
    const sitePassword = await ui.secret(msg('Worker 站点密码', 'Worker site password'), { optional: true });
    const plan = mode === 'new-worker'
      ? createUpstreamInstallPlan({ prefix, domains })
      : createInstallPlan({ prefix, workerUrl });
    printPlan(plan);
    const confirmation = mode === 'new-worker'
      ? msg(
        '确认这些域名没有正在使用的其他邮箱，并允许安装器启用 Email Routing、更新必要 MX、自动接管 Catch-all？已有冲突规则不会被静默覆盖。',
        'Confirm that these domains do not use another mail service and allow the installer to enable Email Routing, update required MX records, and take over Catch-all? Conflicting rules will never be overwritten silently.',
      )
      : msg('按此计划开始部署？', 'Start deployment with this plan?');
    if (!await ui.confirm(confirmation, mode !== 'new-worker')) throw new Error(msg('安装已取消。', 'Installation cancelled.'));

    const result = mode === 'new-worker'
      ? await installer.runNewWorker({
        prefix,
        domains,
        adminPassword,
        adminEmail,
        adminUserPassword,
        sitePassword,
        emailRoutingConsent: true,
      }, { authenticatedAccount })
      : await installer.run({ prefix, workerUrl, adminPassword, sitePassword });

    console.log(msg('\n应用基础设施部署完成', '\nApplication infrastructure deployment completed'));
    console.log(`${msg('Admin：', 'Admin: ')}${result.state.adminOrigin}`);
    console.log(`${msg('Webmail：', 'Webmail: ')}${result.state.webmailOrigin}`);
    console.log(msg('运行时：Webmail /api/runtime 已通过', 'Runtime: Webmail /api/runtime passed'));
    if (mode === 'new-worker') {
      console.log(`${msg('邮件 Worker：', 'Mail Worker: ')}${result.state.managedWorkerOrigin}`);
      const routingDomains = Array.isArray(result.state.emailRoutingDomains) ? result.state.emailRoutingDomains : [];
      const routingConfigured = routingDomains.length === result.plan.domains.length
        && routingDomains.every((domain, index) => domain === result.plan.domains[index])
        && result.state.emailRoutingWorker === result.plan.resources.workerName;
      console.log(routingConfigured
        ? msg(
          `Email Routing：已自动启用 ${joinList(result.plan.domains)}，Catch-all 已绑定到 ${result.plan.resources.workerName}`,
          `Email Routing: enabled automatically for ${joinList(result.plan.domains)}; Catch-all is bound to ${result.plan.resources.workerName}`,
        )
        : msg(
          `Email Routing：本次续装保留了已有 Worker 配置；请按 docs/EMAIL_ROUTING.md 核对 Catch-all 是否指向 ${result.plan.resources.workerName}`,
          `Email Routing: this resumed installation kept the existing Worker configuration; follow docs/EMAIL_ROUTING.md to verify that Catch-all targets ${result.plan.resources.workerName}`,
        ));
    }
    console.log(msg('\n最后请完成真实验收：', '\nComplete these final real-world checks:'));
    console.log(mode === 'new-worker'
      ? msg('  1. 使用刚创建的首个管理员账号登录 Admin。', '  1. Sign in to Admin with the first administrator account you just created.')
      : msg('  1. 使用已有的管理员角色账号登录 Admin。', '  1. Sign in to Admin with an existing administrator account.'));
    console.log(msg(
      '  2. 从外部邮箱发送测试邮件，确认自动配置的 Email Routing Catch-all 正常。',
      '  2. Send a test message from an external mailbox and verify the automatically configured Email Routing Catch-all.',
    ));
    console.log(msg('  3. 创建分享并在无痕窗口打开。', '  3. Create a share link and open it in a private browser window.'));
    console.log(msg(
      '  4. 如需发件，再按兼容后端文档配置 Resend、SMTP 或 Cloudflare Send Email；安装器未自动开启发件服务。',
      '  4. To send mail, configure Resend, SMTP, or Cloudflare Send Email using the compatible backend documentation; the installer does not enable outbound mail automatically.',
    ));
  } catch (error) {
    console.error(`\n${msg('安装未完成', 'Installation did not complete')}: ${error instanceof Error ? error.message : error}`);
    console.error(msg(
      '修复问题后重新运行 npm run setup；已创建资源会被安全复用。',
      'Fix the issue and run npm run setup again; resources already created will be reused safely.',
    ));
    process.exitCode = 1;
  } finally {
    ui.close();
  }
}
