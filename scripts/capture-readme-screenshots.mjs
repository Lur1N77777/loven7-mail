import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminDir = path.join(repoDir, 'apps', 'admin');
const webmailDir = path.join(repoDir, 'apps', 'webmail');
const screenshotDir = path.join(repoDir, 'docs', 'screenshots');
const npmCmd = 'npm';
const adminRequire = createRequire(path.join(adminDir, 'package.json'));

function npmSpawnArgs(args) {
  if (process.platform !== 'win32') return { command: npmCmd, args };
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', [npmCmd, ...args].join(' ')] };
}

function loadPlaywright() {
  try {
    return adminRequire('playwright-core');
  } catch (error) {
    throw new Error(
      [
        'playwright-core is required to capture README screenshots.',
        'Run: npm --prefix apps/admin install',
        error instanceof Error ? error.message : String(error),
      ].join('\n')
    );
  }
}

function run(command, args, options = {}) {
  const prepared = command === npmCmd ? npmSpawnArgs(args) : { command, args };
  const result = spawnSync(prepared.command, prepared.args, {
    cwd: repoDir,
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
}

function findChromeExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((item) => existsSync(item));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

function startPreview(label, cwd, port) {
  const prepared = npmSpawnArgs(['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort']);
  const child = spawn(prepared.command, prepared.args, {
    cwd,
    env: { ...process.env, BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  child.stdout.on('data', (data) => process.stdout.write(`[${label}] ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`[${label}] ${data}`));
  return child;
}

function stopProcess(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function clickAdminNav(page, label) {
  await page.getByLabel('后台导航').getByRole('button', { name: label }).first().click();
  await page.waitForTimeout(900);
}

async function captureAdminScreenshots(browser, adminUrl) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`${adminUrl}/?preview=admin&readme=desktop-${Date.now()}`, { waitUntil: 'networkidle' });

  await clickAdminNav(page, '仪表盘');
  await page.screenshot({ path: path.join(screenshotDir, 'admin-dashboard.png'), fullPage: false });

  await clickAdminNav(page, '系统设置');
  await page.screenshot({ path: path.join(screenshotDir, 'admin-connection-settings.png'), fullPage: false });

  await clickAdminNav(page, '收件箱');
  await page.screenshot({ path: path.join(screenshotDir, 'admin-inbox.png'), fullPage: false });

  await page.close();
}

async function captureMobileAdminScreenshot(browser, adminUrl) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(`${adminUrl}/?preview=admin&readme=mobile-${Date.now()}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /地址管理/ }).first().click();
  await page.waitForTimeout(1000);
  await page.locator('.mobile-address-more').first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(screenshotDir, 'mobile-address-actions.png'), fullPage: false });
  await page.close();
}

function mailRaw({ from, to, subject, code, date }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<p>你的验证码是 <strong>${code}</strong>，请在 10 分钟内完成验证。</p>`,
  ].join('\r\n');
}

async function setupWebmailShareMocks(page) {
  const addresses = [
    { id: '501', address: 'openai@loven7.test' },
    { id: '502', address: 'github@loven7.test' },
    { id: '503', address: 'cloudflare@loven7.test' },
  ];
  const mailsByMailbox = {
    '501': [
      {
        id: 9101,
        created_at: '2026-06-27T09:20:00.000Z',
        raw: mailRaw({
          from: 'OpenAI <noreply@openai.com>',
          to: addresses[0].address,
          subject: '你的登录验证码 472913',
          code: '472913',
          date: 'Sat, 27 Jun 2026 17:20:00 +0800',
        }),
      },
      {
        id: 9102,
        created_at: '2026-06-27T08:45:00.000Z',
        raw: mailRaw({
          from: 'Linear <hello@linear.app>',
          to: addresses[0].address,
          subject: 'Workspace invite',
          code: 'A19KQ2',
          date: 'Sat, 27 Jun 2026 16:45:00 +0800',
        }),
      },
    ],
    '502': [
      {
        id: 9201,
        created_at: '2026-06-27T08:10:00.000Z',
        raw: mailRaw({
          from: 'GitHub <noreply@github.com>',
          to: addresses[1].address,
          subject: 'GitHub verification code 884201',
          code: '884201',
          date: 'Sat, 27 Jun 2026 16:10:00 +0800',
        }),
      },
    ],
    '503': [
      {
        id: 9301,
        created_at: '2026-06-27T07:50:00.000Z',
        raw: mailRaw({
          from: 'Cloudflare <no-reply@cloudflare.com>',
          to: addresses[2].address,
          subject: 'Security code',
          code: 'CF2048',
          date: 'Sat, 27 Jun 2026 15:50:00 +0800',
        }),
      },
    ],
  };

  await page.route('**/api/share/demo-readme', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        token: 'demo-readme',
        expiresAt: null,
        mailVisibility: 'all',
        permissions: { hideMail: true },
        addresses,
      }),
    });
  });
  await page.route('**/api/share/demo-readme/settings?**', async (route) => {
    const url = new URL(route.request().url());
    const mailbox = url.searchParams.get('mailbox') || '501';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        address: addresses.find((item) => item.id === mailbox)?.address || addresses[0].address,
        enableSendMail: false,
        domains: ['loven7.test'],
      }),
    });
  });
  await page.route('**/api/share/demo-readme/mails?**', async (route) => {
    const url = new URL(route.request().url());
    const mailbox = url.searchParams.get('mailbox') || '501';
    const results = mailsByMailbox[mailbox] || mailsByMailbox['501'];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results, count: results.length }),
    });
  });
}

async function captureWebmailScreenshots(browser, webmailUrl) {
  const loginPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await loginPage.goto(`${webmailUrl}/?readme=login-${Date.now()}`, { waitUntil: 'networkidle' });
  await loginPage.waitForSelector('.account-portal-shell, .mailbox-direct-shell');
  await loginPage.waitForTimeout(600);
  await loginPage.screenshot({ path: path.join(screenshotDir, 'webmail-login.png'), fullPage: false });
  await loginPage.close();

  const sharePage = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await setupWebmailShareMocks(sharePage);
  await sharePage.goto(`${webmailUrl}/s/demo-readme?readme=share-${Date.now()}`, { waitUntil: 'networkidle' });
  await sharePage.waitForSelector('.app-shell.share-mode, .mail-list');
  await sharePage.waitForTimeout(1200);
  await sharePage.screenshot({ path: path.join(screenshotDir, 'webmail-share.png'), fullPage: false });
  await sharePage.close();
}

async function main() {
  const adminUrlFromEnv = process.env.ADMIN_SCREENSHOT_URL?.replace(/\/+$/, '');
  const webmailUrlFromEnv = process.env.WEBMAIL_SCREENSHOT_URL?.replace(/\/+$/, '');
  const shouldBuild = process.env.README_SCREENSHOTS_SKIP_BUILD !== '1' && (!adminUrlFromEnv || !webmailUrlFromEnv);
  const children = [];

  mkdirSync(screenshotDir, { recursive: true });

  if (shouldBuild) {
    run(npmCmd, ['run', 'build'], {
      cwd: adminDir,
      env: { ...process.env, VITE_API_BASE: '', VITE_FRONTEND_LOGIN_BASE: process.env.VITE_FRONTEND_LOGIN_BASE || 'https://webmail.example.com' },
    });
    run(npmCmd, ['run', 'build'], {
      cwd: webmailDir,
      env: { ...process.env, VITE_API_BASE: '' },
    });
  }

  const adminPort = adminUrlFromEnv ? 0 : await freePort();
  const webmailPort = webmailUrlFromEnv ? 0 : await freePort();
  const adminUrl = adminUrlFromEnv || `http://127.0.0.1:${adminPort}`;
  const webmailUrl = webmailUrlFromEnv || `http://127.0.0.1:${webmailPort}`;

  try {
    if (!adminUrlFromEnv) {
      children.push(startPreview('admin', adminDir, adminPort));
      await waitForHttp(adminUrl);
    }
    if (!webmailUrlFromEnv) {
      children.push(startPreview('webmail', webmailDir, webmailPort));
      await waitForHttp(webmailUrl);
    }

    const executablePath = findChromeExecutable();
    if (!executablePath) {
      throw new Error('Chrome/Chromium was not found. Set CHROME_PATH or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.');
    }

    const { chromium } = loadPlaywright();
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      await captureAdminScreenshots(browser, adminUrl);
      await captureMobileAdminScreenshot(browser, adminUrl);
      await captureWebmailScreenshots(browser, webmailUrl);
    } finally {
      await browser.close();
    }

    console.log(JSON.stringify({
      ok: true,
      screenshotDir,
      files: [
        'admin-dashboard.png',
        'admin-connection-settings.png',
        'admin-inbox.png',
        'mobile-address-actions.png',
        'webmail-login.png',
        'webmail-share.png',
      ],
    }, null, 2));
  } finally {
    for (const child of children.reverse()) stopProcess(child);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
