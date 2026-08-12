#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudflareAdapter, CommandRunner } from './cloudflare.mjs';
import { createInstallPlan, createUpstreamInstallPlan, validateAdminEmail } from './domain.mjs';
import { Installer } from './installer.mjs';
import { ConsoleUi } from './ui.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function printPlan(plan) {
  console.log('\nLoven7 Mail 安装计划');
  console.log(`模式：${plan.mode === 'new-worker' ? '从零部署官方 Worker' : '已有兼容 Worker'}`);
  if (plan.domain) console.log(`邮箱域名：${plan.domain}`);
  if (plan.workerUrl) console.log(`Worker：${plan.workerUrl}`);
  console.log(`项目：${plan.resources.adminProject} / ${plan.resources.webmailProject}`);
  console.log(`KV：${plan.resources.shareKv} / ${plan.resources.mailStateKv}`);
  if (plan.resources.workerName) console.log(`上游 Worker：${plan.resources.workerName}`);
  if (plan.resources.databaseName) console.log(`D1：${plan.resources.databaseName}`);
  console.log('\n自动执行：');
  plan.steps.forEach((step, index) => console.log(`  ${index + 1}. ${step}`));
  console.log('\n仍需人工确认：');
  plan.manual.forEach((step) => console.log(`  - ${step}`));
}

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('安装器要求 Node.js 22 或更高版本。');
  process.exit(1);
}

const planOnly = args.includes('--plan');
if (planOnly) {
  try {
    const prefix = argValue('--prefix') || 'loven7-mail';
    const plan = args.includes('--new-worker')
      ? createUpstreamInstallPlan({ prefix, domain: argValue('--domain') })
      : createInstallPlan({ prefix, workerUrl: argValue('--worker-url') || 'https://worker.example.com' });
    printPlan(plan);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
} else {
  const ui = new ConsoleUi();
  try {
    console.log('\nLoven7 Mail 新手安装器');
    console.log('安装器支持已有 Worker 接入，也支持从锁定的官方 v1.10.0 Worker 开始部署。');
    console.log('输入的密码不会显示，也不会保存到仓库或安装状态文件。\n');
    const mode = args.includes('--new-worker') ? 'new-worker' : args.includes('--existing-worker') ? 'existing-worker' : await ui.mode();
    const prefix = await ui.text('项目名称前缀', argValue('--prefix') || 'loven7-mail');
    const workerUrl = mode === 'existing-worker' ? await ui.text('已有邮件 Worker 根地址', argValue('--worker-url')) : '';
    const domain = mode === 'new-worker' ? await ui.text('邮箱域名（必须已托管到 Cloudflare）', argValue('--domain')) : '';
    const adminPassword = await ui.secret('Worker 管理员口令');
    if (!adminPassword) throw new Error('Worker 管理员口令不能为空。');
    const adminEmail = mode === 'new-worker' ? validateAdminEmail(await ui.text('首个管理员登录邮箱')) : '';
    const adminUserPassword = mode === 'new-worker' ? await ui.secret('首个管理员登录密码') : '';
    if (mode === 'new-worker' && (!adminEmail || !adminUserPassword)) throw new Error('首个管理员账号和登录密码不能为空。');
    const sitePassword = await ui.secret('Worker 站点密码', { optional: true });
    const plan = mode === 'new-worker'
      ? (await import('./domain.mjs')).createUpstreamInstallPlan({ prefix, domain })
      : createInstallPlan({ prefix, workerUrl });
    printPlan(plan);
    if (!await ui.confirm('按此计划开始部署？', true)) throw new Error('安装已取消。');

    const runner = new CommandRunner({ cwd: rootDir });
    const cloudflare = new CloudflareAdapter({ rootDir, runner });
    const installer = new Installer({ rootDir, cloudflare, ui });
    const result = mode === 'new-worker'
      ? await installer.runNewWorker({ prefix, domain, adminPassword, adminEmail, adminUserPassword, sitePassword })
      : await installer.run({ prefix, workerUrl, adminPassword, sitePassword });

    console.log('\n部署完成');
    console.log(`Admin：${result.state.adminOrigin}`);
    console.log(`Webmail：${result.state.webmailOrigin}`);
    console.log('运行时：Webmail /api/runtime 已通过');
    console.log('\n最后请完成真实验收：');
    console.log(mode === 'new-worker'
      ? '  1. 使用刚创建的首个管理员账号登录 Admin。'
      : '  1. 使用已有的管理员角色账号登录 Admin。');
    console.log('  2. 从外部邮箱发送测试邮件，确认 Email Routing Catch-all 正常。');
    console.log('  3. 创建分享并在无痕窗口打开。');
    console.log('  4. 如需发件，再按上游文档配置 Resend、SMTP 或 Cloudflare Send Email；安装器未自动开启发件服务。');
  } catch (error) {
    console.error(`\n安装未完成：${error instanceof Error ? error.message : error}`);
    console.error('修复问题后重新运行 npm run setup；已创建资源会被安全复用。');
    process.exitCode = 1;
  } finally {
    ui.close();
  }
}
