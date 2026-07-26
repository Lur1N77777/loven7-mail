import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';
const port = Number(process.env.WEBMAIL_SMOKE_PORT || 4274);
const cdpPort = Number(process.env.WEBMAIL_SMOKE_CDP_PORT || 9474);
const baseUrl = process.env.WEBMAIL_SMOKE_URL || `http://127.0.0.1:${port}/`;
const artifactDir = String(process.env.WEBMAIL_SMOKE_ARTIFACT_DIR || '').trim();
const tempProfile = mkdtempSync(`${tmpdir()}/loven7-webmail-smoke-`);
let previewProcess;
let chromeProcess;
let messageId = 0;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(condition, message) { if (!condition) throw new Error(message); }

function findChrome() {
  const candidates = isWindows
    ? [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Chrome/Edge executable not found.');
  return found;
}

function spawnPreviewIfNeeded() {
  if (process.env.WEBMAIL_SMOKE_URL) return undefined;
  const command = isWindows ? 'cmd.exe' : 'npm';
  const args = isWindows
    ? ['/d', '/s', '/c', `npm run preview -- --port ${port} --strictPort`]
    : ['run', 'preview', '--', '--port', String(port), '--strictPort'];
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  child.stdout.on('data', (chunk) => process.stdout.write(`[preview] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[preview] ${chunk}`));
  return child;
}

function spawnChrome() {
  return spawn(findChrome(), [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tempProfile}`,
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    'about:blank',
  ], { stdio: 'ignore' });
}

function killProcessTree(child) {
  if (!child) return;
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', timeout: 1500 });
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore', timeout: 2500 });
  }
  else {
    try { child.kill('SIGTERM'); } catch {}
  }
}

async function waitForHttp(url, timeoutMs = 15_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.status < 500) return;
    } catch (error) { last = error; }
    await sleep(250);
  }
  throw last || new Error(`Timed out waiting for ${url}`);
}

async function cdpNewPage(url) {
  const target = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((res) => res.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return ws;
}

async function cdpSend(ws, method, params = {}) {
  const id = ++messageId;
  ws.send(JSON.stringify({ id, method, params }));
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10_000);
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
  });
}

async function evaluate(ws, expression) {
  const result = await cdpSend(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function click(ws, selector) {
  await evaluate(ws, `document.querySelector(${JSON.stringify(selector)})?.click()`);
  await sleep(350);
}

async function setInput(ws, selector, value) {
  await evaluate(ws, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter ? setter.call(input, ${JSON.stringify(value)}) : (input.value = ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function waitUntil(ws, expression, timeoutMs = 6000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await evaluate(ws, expression).catch((error) => String(error));
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${expression}; last=${JSON.stringify(last)}`);
}

function mockFetchScript() {
  const htmlMail = [
    'From: OpenAI <noreply@openai.com>',
    'To: qa@example.test',
    'Subject: Verify your account',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<div><h2>Code <b>884211</b></h2><p>HTML rendered cleanly.</p><img src="https://static.example.test/logo.png" /></div>',
  ].join('\r\n');
  const textMail = [
    'From: Apple <no-reply@apple.com>',
    'To: qa@example.test',
    'Subject: Security notice',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your verification code is 512399.',
  ].join('\r\n');
  const oldStaleMail = [
    'From: Old Session <old@example.test>',
    'To: old@example.test',
    'Subject: OLD_STALE_MAIL',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This stale message belongs to the old session.',
  ].join('\r\n');
  const newOnlyMail = [
    'From: New Session <new@example.test>',
    'To: new@example.test',
    'Subject: NEW_ONLY_MAIL',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This message belongs to the new session only.',
  ].join('\r\n');
  const boxAInitialMail = [
    'From: Box A <a@example.test>',
    'To: a@example.test',
    'Subject: BOX_A_INITIAL',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Initial shared mailbox A message.',
  ].join('\r\n');
  const boxAStaleMail = [
    'From: Box A <a@example.test>',
    'To: a@example.test',
    'Subject: BOX_A_STALE',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Late refresh message from mailbox A.',
  ].join('\r\n');
  const boxBOnlyMail = [
    'From: Box B <b@example.test>',
    'To: b@example.test',
    'Subject: BOX_B_ONLY',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Mailbox B current message.',
  ].join('\r\n');
  return `(() => {
    const mailPages = {
      populated: [{ id: 101, raw: ${JSON.stringify(htmlMail)}, created_at: '2026-05-09T10:35:00.000Z' }, { id: 100, raw: ${JSON.stringify(textMail)}, created_at: '2026-05-09T10:30:00.000Z' }],
      empty: [],
      old: [{ id: 201, raw: ${JSON.stringify(oldStaleMail)}, created_at: '2026-05-09T10:25:00.000Z' }],
      newOnly: [{ id: 301, raw: ${JSON.stringify(newOnlyMail)}, created_at: '2026-05-09T10:40:00.000Z' }],
      boxAInitial: [{ id: 401, raw: ${JSON.stringify(boxAInitialMail)}, created_at: '2026-05-09T10:10:00.000Z' }],
      boxAStale: [{ id: 402, raw: ${JSON.stringify(boxAStaleMail)}, created_at: '2026-05-09T10:45:00.000Z' }, { id: 401, raw: ${JSON.stringify(boxAInitialMail)}, created_at: '2026-05-09T10:10:00.000Z' }],
      boxBOnly: [{ id: 501, raw: ${JSON.stringify(boxBOnlyMail)}, created_at: '2026-05-09T10:50:00.000Z' }]
    };
    let shareDeleted = false;
    const raceHolds = new Map();
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
    const readHeader = (headers, name) => {
      const lowerName = name.toLowerCase();
      if (!headers) return '';
      if (typeof headers.get === 'function') return headers.get(name) || headers.get(lowerName) || '';
      const match = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
      return match ? String(match[1]) : '';
    };
    const waitForRace = async (key) => {
      const hold = raceHolds.get(key);
      if (!hold) return;
      hold.count += 1;
      await new Promise((resolve) => hold.waiters.push(resolve));
    };
    window.__webmailSmokeRace = {
      hold(key) {
        raceHolds.set(key, { count: 0, waiters: [] });
      },
      release(key) {
        const hold = raceHolds.get(key);
        if (!hold) return false;
        raceHolds.delete(key);
        hold.waiters.splice(0).forEach((resolve) => resolve());
        return true;
      },
      count(key) {
        return raceHolds.get(key)?.count || 0;
      },
      pending(key) {
        return raceHolds.get(key)?.waiters.length || 0;
      }
    };
    window.confirm = () => true;
    window.fetch = async (input, init = {}) => {
      const rawUrl = typeof input === 'string' ? input : input.url;
      const url = new URL(rawUrl, location.origin);
      const path = url.pathname;
      if (path === '/api/session') {
        const body = JSON.parse(init.body || '{}');
        if (body.password === 'bad') return json({ error: { code: 'invalid_login', message: '邮箱或密码错误' } }, 401);
        const address = body.email || 'qa@example.test';
        const jwt = address.includes('empty') ? 'jwt-empty' : address.includes('old') ? 'jwt-old' : address.includes('new') ? 'jwt-new' : 'jwt-populated';
        return json({ ok: true, jwt, address, settings: { address } });
      }
      if (path === '/api/settings') return json({ address: 'qa@example.test' });
      if (path === '/api/mails') {
        const auth = readHeader(init.headers, 'authorization');
        if (String(auth).includes('jwt-old')) await waitForRace('mails:jwt-old');
        const list = String(auth).includes('jwt-empty')
          ? mailPages.empty
          : String(auth).includes('jwt-old')
            ? mailPages.old
            : String(auth).includes('jwt-new')
              ? mailPages.newOnly
              : mailPages.populated;
        return json({ results: list, count: list.length });
      }
      if (path === '/api/mail/101' || path === '/api/mail/100') return json({ ok: true });
      if (path === '/api/image') return new Response('not really an image', { status: 415, headers: { 'content-type': 'text/plain' } });
      if (path === '/api/share/no-config') return json({ error: { code: 'share_not_configured', message: 'SHARE_KV is not configured' } }, 500);
      if (path === '/api/share/no-config-kv') return json({ error: { code: 'share_kv_not_configured', message: 'SHARE_KV is not configured' } }, 500);
      if (path === '/api/share/no-config-secret') return json({ error: { code: 'share_secret_not_configured', message: 'SHARE_ENCRYPTION_SECRET is not configured' } }, 500);
      if (path === '/api/share/no-worker') return json({ ok: true, token: 'no-worker', permissions: { hideMail: true }, addresses: [{ id: 'box-worker', address: 'worker@example.test' }] });
      if (path === '/api/share/no-worker/settings') return json({ error: { code: 'mail_worker_not_configured', message: 'MAIL_WORKER_BASE_URL is not configured' } }, 500);
      if (path === '/api/share/no-worker/mails') return json({ error: { code: 'mail_worker_not_configured', message: 'MAIL_WORKER_BASE_URL is not configured' } }, 500);
      if (path === '/api/share/share-token') return json({ ok: true, token: 'share-token', permissions: { hideMail: true }, addresses: [{ id: 'box1', address: 'shared@example.test' }] });
      if (path === '/api/share/share-token/settings') return json({ address: 'shared@example.test' });
      if (path === '/api/share/share-token/mails') return json({ results: shareDeleted ? [] : mailPages.populated.slice(0, 1), count: shareDeleted ? 0 : 1 });
      if (path === '/api/share/share-token/mail/101') { shareDeleted = true; return json({ ok: true }); }
      if (path === '/api/share/race-token') return json({ ok: true, token: 'race-token', permissions: { hideMail: true }, addresses: [{ id: 'box-a', address: 'a@example.test' }, { id: 'box-b', address: 'b@example.test' }] });
      if (path === '/api/share/race-token/settings') {
        const mailbox = url.searchParams.get('mailbox') || 'box-a';
        return json({ address: mailbox === 'box-b' ? 'b@example.test' : 'a@example.test' });
      }
      if (path === '/api/share/race-token/mails') {
        const mailbox = url.searchParams.get('mailbox') || 'box-a';
        if (mailbox === 'box-b') return json({ results: mailPages.boxBOnly, count: mailPages.boxBOnly.length });
        const key = 'share-mails:race-token:box-a';
        if (raceHolds.has(key)) {
          await waitForRace(key);
          return json({ results: mailPages.boxAStale, count: mailPages.boxAStale.length });
        }
        return json({ results: mailPages.boxAInitial, count: mailPages.boxAInitial.length });
      }
      return json({ error: { code: 'not_found', message: 'mock route not found: ' + path } }, 404);
    };
  })()`;
}

async function openApp(pathname = '/', { width = 390, height = 844, locale = 'zh-CN', colorScheme = 'light' } = {}) {
  const ws = await cdpNewPage('about:blank');
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Runtime.enable');
  await cdpSend(ws, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  await cdpSend(ws, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] });
  await cdpSend(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: mockFetchScript() });
  await cdpSend(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('loven7.locale', ${JSON.stringify(locale)}); localStorage.setItem('loven7.uiTheme', ${JSON.stringify(colorScheme)}); sessionStorage.clear(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__webmailCopiedText = String(value); } } });` });
  await cdpSend(ws, 'Page.navigate', { url: new URL(pathname, baseUrl).toString() });
  await cdpSend(ws, 'Page.loadEventFired').catch(() => undefined);
  await sleep(900);
  return ws;
}

async function captureScreenshot(ws, name) {
  if (!artifactDir) return;
  mkdirSync(artifactDir, { recursive: true });
  const result = await cdpSend(ws, 'Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  writeFileSync(join(artifactDir, `${name}.png`), Buffer.from(result.data, 'base64'));
}

async function loginWithMockMailbox(ws) {
  await waitUntil(ws, `document.body.innerText.includes('请输入管理员提供的邮箱与密码')`);
  await setInput(ws, 'input[type="email"]', 'qa@example.test');
  await setInput(ws, '.password-input-wrap input', 'good');
  await click(ws, '.login-button');
  await waitUntil(ws, `document.querySelectorAll('.mail-row').length >= 2`);
  await waitUntil(ws, `document.querySelector('.mail-html-view')?.srcdoc?.includes('HTML rendered cleanly')`);
}

async function captureVisualSnapshots() {
  if (!artifactDir) return [];

  const captured = [];
  const desktop = await openApp('/', { width: 1440, height: 960, colorScheme: 'light' });
  await waitUntil(desktop, `document.body.innerText.includes('请输入管理员提供的邮箱与密码')`);
  await captureScreenshot(desktop, 'desktop-login-light');
  captured.push('desktop-login-light.png');
  await loginWithMockMailbox(desktop);
  await captureScreenshot(desktop, 'desktop-inbox-light');
  captured.push('desktop-inbox-light.png');
  await click(desktop, '.mail-list-item .verification-code-button');
  await waitUntil(desktop, `document.querySelector('.mail-list-item .verification-code-button')?.classList.contains('copied')`);
  await captureScreenshot(desktop, 'desktop-code-copied-light');
  captured.push('desktop-code-copied-light.png');
  await click(desktop, '.webmail-locale-toggle');
  await waitUntil(desktop, `!!document.querySelector('.webmail-locale-menu')`);
  await captureScreenshot(desktop, 'desktop-language-menu-light');
  captured.push('desktop-language-menu-light.png');
  await evaluate(desktop, `document.querySelector('.webmail-locale-menu button:not(.active)')?.click()`);
  await waitUntil(desktop, `document.documentElement.lang === 'en-US' && document.body.innerText.includes('Inbox')`);
  assert(!await evaluate(desktop, `document.body.innerText.includes('修改密码') || document.body.innerText.includes('Change password')`), '登录后的左栏不应提供修改密码入口');
  await captureScreenshot(desktop, 'desktop-inbox-english-light');
  captured.push('desktop-inbox-english-light.png');

  const desktopDark = await openApp('/', { width: 1440, height: 960, colorScheme: 'dark' });
  await waitUntil(desktopDark, `document.body.innerText.includes('请输入管理员提供的邮箱与密码')`);
  await captureScreenshot(desktopDark, 'desktop-login-dark');
  captured.push('desktop-login-dark.png');
  await loginWithMockMailbox(desktopDark);
  await captureScreenshot(desktopDark, 'desktop-inbox-dark');
  captured.push('desktop-inbox-dark.png');

  const mobile = await openApp('/', { width: 390, height: 844, colorScheme: 'light' });
  await waitUntil(mobile, `document.body.innerText.includes('请输入管理员提供的邮箱与密码')`);
  await captureScreenshot(mobile, 'mobile-login-light');
  captured.push('mobile-login-light.png');
  await loginWithMockMailbox(mobile);
  await captureScreenshot(mobile, 'mobile-inbox-light');
  captured.push('mobile-inbox-light.png');
  await click(mobile, '.mail-row');
  await waitUntil(mobile, `document.querySelector('.app-shell')?.classList.contains('pane-reader')`);
  await captureScreenshot(mobile, 'mobile-reader-light');
  captured.push('mobile-reader-light.png');

  const mobileDark = await openApp('/', { width: 390, height: 844, colorScheme: 'dark' });
  await waitUntil(mobileDark, `document.body.innerText.includes('请输入管理员提供的邮箱与密码')`);
  await captureScreenshot(mobileDark, 'mobile-login-dark');
  captured.push('mobile-login-dark.png');
  await loginWithMockMailbox(mobileDark);
  await captureScreenshot(mobileDark, 'mobile-inbox-dark');
  captured.push('mobile-inbox-dark.png');
  await click(mobileDark, '.mail-row');
  await waitUntil(mobileDark, `document.querySelector('.app-shell')?.classList.contains('pane-reader')`);
  await captureScreenshot(mobileDark, 'mobile-reader-dark');
  captured.push('mobile-reader-dark.png');

  return captured;
}

async function run() {
  previewProcess = spawnPreviewIfNeeded();
  await waitForHttp(baseUrl);
  chromeProcess = spawnChrome();
  await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`);

  const results = [];
  const login = await openApp('/');
  await waitUntil(login, `document.body.innerText.includes('请输入管理员提供的邮箱与密码')`);
  const loginMetrics = JSON.parse(await evaluate(login, `JSON.stringify({
    xOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    passwordType: document.querySelector('.password-input-wrap input')?.type,
    toggle: !!document.querySelector('.password-toggle'),
    loginButtonHeight: document.querySelector('.login-button')?.getBoundingClientRect().height || 0
  })`));
  assert(!loginMetrics.xOverflow, '登录页不应横向溢出');
  assert(loginMetrics.toggle, '密码框需要内嵌眼睛按钮');
  assert(loginMetrics.loginButtonHeight >= 44, '登录按钮触控高度不足');
  await click(login, '.password-toggle');
  assert(await evaluate(login, `document.querySelector('.password-input-wrap input')?.type === 'text'`), '密码眼睛按钮应切换到明文');
  await setInput(login, 'input[type="email"]', 'qa@example.test');
  await setInput(login, '.password-input-wrap input', 'bad');
  await click(login, '.login-button');
  await waitUntil(login, `document.body.innerText.includes('邮箱或密码错误')`);
  assert(await evaluate(login, `document.activeElement === document.querySelector('.password-input-wrap input')`), '登录失败后应自动聚焦密码框');
  await setInput(login, '.password-input-wrap input', 'good');
  await click(login, '.login-button');
  await waitUntil(login, `document.querySelectorAll('.mail-row').length >= 2`);
  await waitUntil(login, `document.querySelector('.mail-html-view')?.srcdoc?.includes('HTML rendered cleanly')`);
  const inboxMetrics = JSON.parse(await evaluate(login, `JSON.stringify({
    xOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    rows: document.querySelectorAll('.mail-row').length,
    hasRawMime: /Content-Type:|MIME-Version:/.test(document.body.innerText),
    htmlText: document.querySelector('.mail-html-view')?.srcdoc || '',
    hasRemoteImageButton: [...document.querySelectorAll('button')].some((button) => /显示远程图片|Show remote images/.test(button.textContent || '')),
    hasLoadingText: document.body.innerText.includes('正在优化') || document.body.innerText.includes('Loading images'),
    signedInBrandLogo: !!document.querySelector('.mail-list-header .brand-logo'),
    emptyHuge: false
  })`));
  assert(!inboxMetrics.xOverflow, '用户站收件箱不应横向溢出');
  assert(inboxMetrics.rows >= 2, '登录后应显示邮件列表');
  assert(!inboxMetrics.hasRawMime, '邮件正文不应暴露 MIME 头');
  assert(inboxMetrics.htmlText.includes('HTML rendered cleanly'), `HTML 邮件应渲染在阅读区: ${inboxMetrics.htmlText}`);
  assert(inboxMetrics.htmlText.includes('/api/image?url='), `远程邮件图片应自动改写为同源代理地址: ${inboxMetrics.htmlText}`);
  assert(!inboxMetrics.hasRemoteImageButton, '远程邮件图片应自动通过代理加载，不应再要求手动允许');
  assert(!inboxMetrics.hasLoadingText, '切换/加载邮件时不应显示冗余图片优化文案');
  assert(!inboxMetrics.signedInBrandLogo, `登录后的邮箱左栏不应继续堆叠品牌 Logo: ${JSON.stringify(inboxMetrics)}`);
  const initialTheme = await evaluate(login, `document.documentElement.dataset.theme`);
  assert(initialTheme === 'light' || initialTheme === 'dark', `页面应在首屏应用明确主题: ${initialTheme}`);
  await click(login, '.sidebar-header-actions .webmail-theme-toggle');
  await waitUntil(login, `document.documentElement.dataset.theme === '${initialTheme === 'dark' ? 'light' : 'dark'}'`);
  const themeToggleMetrics = JSON.parse(await evaluate(login, `JSON.stringify({
    theme: document.documentElement.dataset.theme,
    stored: localStorage.getItem('loven7.uiTheme'),
    background: getComputedStyle(document.documentElement).backgroundColor,
    label: document.querySelector('.sidebar-header-actions .webmail-theme-toggle')?.getAttribute('aria-label') || ''
  })`));
  assert(themeToggleMetrics.stored === themeToggleMetrics.theme, `手动主题应立即持久化: ${JSON.stringify(themeToggleMetrics)}`);
  assert(themeToggleMetrics.label, `主题按钮必须提供清晰的辅助说明: ${JSON.stringify(themeToggleMetrics)}`);
  await click(login, '.sidebar-header-actions .webmail-theme-toggle');
  await waitUntil(login, `document.documentElement.dataset.theme === '${initialTheme}'`);

  const codeButtonMetrics = JSON.parse(await evaluate(login, `JSON.stringify((() => {
    const button = document.querySelector('.mail-list-item .verification-code-button');
    const value = button?.querySelector('.verification-code-value');
    const detail = document.querySelector('.mail-detail-code-strip .verification-code-button');
    if (!button || !value || !detail) return { exists: false };
    const buttonRect = button.getBoundingClientRect();
    const valueRect = value.getBoundingClientRect();
    const detailRect = detail.getBoundingClientRect();
    const detailValueRect = detail.querySelector('.verification-code-value').getBoundingClientRect();
    const detailStyle = getComputedStyle(detail);
    return {
      exists: true,
      listCenterDelta: Math.abs((buttonRect.left + buttonRect.width / 2) - (valueRect.left + valueRect.width / 2)),
      detailCenterDelta: detailRect.width ? Math.abs((detailRect.left + detailRect.width / 2) - (detailValueRect.left + detailValueRect.width / 2)) : 0,
      listHeight: buttonRect.height,
      detailHeight: detailRect.height || Number.parseFloat(detailStyle.height),
      hasTrailingAction: !!button.querySelector('.verification-code-action, .mail-ui-icon')
    };
  })())`));
  assert(codeButtonMetrics.exists && !codeButtonMetrics.hasTrailingAction, `验证码快捷复制组件不应在右侧附加图标造成失重: ${JSON.stringify(codeButtonMetrics)}`);
  assert(codeButtonMetrics.listCenterDelta <= 1 && codeButtonMetrics.detailCenterDelta <= 1, `验证码必须在按钮几何中心: ${JSON.stringify(codeButtonMetrics)}`);
  assert(codeButtonMetrics.listHeight >= 27 && codeButtonMetrics.detailHeight >= 34, `验证码控件高度不符合紧凑布局: ${JSON.stringify(codeButtonMetrics)}`);
  await click(login, '.mail-list-item .verification-code-button');
  await waitUntil(login, `document.querySelector('.mail-list-item .verification-code-button')?.classList.contains('copied')`);
  assert(await evaluate(login, `window.__webmailCopiedText === document.querySelector('.mail-list-item .verification-code-value')?.textContent?.trim()`), '验证码快捷复制应只写入验证码文本');
  await evaluate(login, `document.querySelectorAll('.mail-row')[1]?.click()`);
  await waitUntil(login, `document.querySelector('main h1')?.textContent?.includes('Security notice') && document.querySelectorAll('.mail-row')[1]?.classList.contains('selected') && document.querySelectorAll('.mail-row')[1]?.classList.contains('read')`);
  const mailInteractionMetrics = JSON.parse(await evaluate(login, `JSON.stringify((() => {
    const rows = [...document.querySelectorAll('.mail-row')];
    const selected = rows.find((row) => row.classList.contains('selected'));
    const subject = selected?.querySelector('.mail-subject');
    const preview = selected?.querySelector('.mail-row-preview');
    return {
      selectedIndex: rows.indexOf(selected),
      detailSubject: document.querySelector('main h1')?.textContent || '',
      cursor: selected ? getComputedStyle(selected).cursor : '',
      selectedBackground: selected ? getComputedStyle(selected).backgroundColor : '',
      subjectColor: subject ? getComputedStyle(subject).color : '',
      previewColor: preview ? getComputedStyle(preview).color : ''
    };
  })())`));
  assert(mailInteractionMetrics.selectedIndex === 1 && mailInteractionMetrics.detailSubject.includes('Security notice'), `点击邮件后应切换选中项和详情: ${JSON.stringify(mailInteractionMetrics)}`);
  assert(mailInteractionMetrics.cursor === 'pointer', `邮件行应保持明确的可交互指针: ${JSON.stringify(mailInteractionMetrics)}`);
  assert(mailInteractionMetrics.selectedBackground !== 'rgba(0, 0, 0, 0)', `已读邮件选中态不应被基础样式覆盖: ${JSON.stringify(mailInteractionMetrics)}`);
  assert(mailInteractionMetrics.subjectColor !== mailInteractionMetrics.previewColor, `已读邮件标题不应与摘要一起灰化: ${JSON.stringify(mailInteractionMetrics)}`);
  await click(login, '.webmail-locale-toggle');
  const localeMenu = JSON.parse(await evaluate(login, `JSON.stringify((() => {
    const menu = document.querySelector('.webmail-locale-menu');
    const rect = menu?.getBoundingClientRect();
    return { exists: !!menu, z: Number(getComputedStyle(menu).zIndex), top: rect?.top, bottom: rect?.bottom, innerHeight };
  })())`));
  assert(localeMenu.exists && localeMenu.z > 1000, `语言菜单应在最上层: ${JSON.stringify(localeMenu)}`);

  const desktopLayout = await openApp('/', { width: 1440, height: 960 });
  await loginWithMockMailbox(desktopLayout);
  const desktopReaderMetrics = JSON.parse(await evaluate(desktopLayout, `JSON.stringify((() => {
    const card = document.querySelector('.mail-detail-card');
    const header = document.querySelector('.mail-detail-header');
    const topbar = document.querySelector('.mail-detail-topbar');
    const cardRect = card?.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    return {
      topbarPosition: topbar ? getComputedStyle(topbar).position : '',
      headerGap: cardRect && headerRect ? headerRect.top - cardRect.top : 999
    };
  })())`));
  assert(desktopReaderMetrics.topbarPosition === 'absolute' && desktopReaderMetrics.headerGap <= 32, `桌面详情工具栏不应占据标题上方整行空白: ${JSON.stringify(desktopReaderMetrics)}`);
  results.push({ name: 'webmail-login-inbox', loginMetrics, inboxMetrics, themeToggleMetrics, codeButtonMetrics, mailInteractionMetrics, localeMenu, desktopReaderMetrics });

  const empty = await openApp('/');
  await setInput(empty, 'input[type="email"]', 'empty@example.test');
  await setInput(empty, '.password-input-wrap input', 'good');
  await click(empty, '.login-button');
  await waitUntil(empty, `document.body.innerText.includes('暂无邮件')`);
  const emptyMetrics = JSON.parse(await evaluate(empty, `JSON.stringify({
    listEmpty: document.querySelector('.list-empty')?.textContent || '',
    readerEmpty: document.querySelector('.reader > .empty-state')?.textContent || '',
    readerTitleFont: getComputedStyle(document.querySelector('.reader > .empty-state h1')).fontSize,
    xOverflow: document.documentElement.scrollWidth > innerWidth + 1
  })`));
  assert(emptyMetrics.listEmpty.includes('暂无邮件') && emptyMetrics.listEmpty.includes('等待刷新新邮件'), `左侧空状态文案不正确: ${JSON.stringify(emptyMetrics)}`);
  assert(emptyMetrics.readerEmpty.includes('暂无邮件') && emptyMetrics.readerEmpty.includes('等待刷新新邮件'), `右侧空状态文案不正确: ${JSON.stringify(emptyMetrics)}`);
  assert(!emptyMetrics.xOverflow, '空状态不应横向溢出');
  results.push({ name: 'webmail-empty-state', emptyMetrics });

  const share = await openApp('/s/share-token');
  await waitUntil(share, `document.querySelectorAll('.mail-row').length === 1`);
  await click(share, '.mail-row');
  await waitUntil(share, `document.querySelector('.mail-detail-icon-action.danger')?.getAttribute('aria-label')?.includes('删除')`);
  const shareBefore = await evaluate(share, `document.body.innerText`);
  const shareDeleteLabel = await evaluate(share, `document.querySelector('.mail-detail-icon-action.danger')?.getAttribute('aria-label') || ''`);
  assert(shareDeleteLabel === '删除邮件', `共享模式详情删除按钮需要准确的无障碍标签: ${shareDeleteLabel}`);
  assert(!shareBefore.includes('隐藏邮件'), '共享模式不应向用户显示“隐藏邮件”');
  await click(share, '.mail-detail-icon-action.danger');
  await waitUntil(share, `document.body.innerText.includes('邮件已删除') || document.querySelectorAll('.mail-row').length === 0`);
  const shareAfter = await evaluate(share, `document.body.innerText`);
  assert(shareAfter.includes('暂无邮件'), '共享删除后当前链接应隐藏该邮件并显示空状态');
  results.push({ name: 'webmail-share-delete-copy', ok: true });

  const raceLogin = await openApp('/');
  await waitUntil(raceLogin, `!!window.__webmailSmokeRace && document.body.innerText.includes('请输入管理员提供的邮箱与密码')`);
  await evaluate(raceLogin, `window.__webmailSmokeRace.hold('mails:jwt-old')`);
  await setInput(raceLogin, 'input[type="email"]', 'old@example.test');
  await setInput(raceLogin, '.password-input-wrap input', 'good');
  await click(raceLogin, '.login-button');
  await waitUntil(raceLogin, `window.__webmailSmokeRace.pending('mails:jwt-old') >= 1 && document.body.innerText.includes('old@example.test')`);
  await click(raceLogin, '.sidebar-logout-button');
  await waitUntil(raceLogin, `document.body.innerText.includes('请输入管理员提供的邮箱与密码') && !document.querySelector('.mail-row')`);
  await setInput(raceLogin, 'input[type="email"]', 'new@example.test');
  await setInput(raceLogin, '.password-input-wrap input', 'good');
  await click(raceLogin, '.login-button');
  await waitUntil(raceLogin, `document.body.innerText.includes('NEW_ONLY_MAIL')`);
  await evaluate(raceLogin, `window.__webmailSmokeRace.release('mails:jwt-old')`);
  await sleep(700);
  const raceLoginMetrics = JSON.parse(await evaluate(raceLogin, `JSON.stringify({
    address: document.querySelector('.address-copy-button')?.textContent || '',
    rows: document.querySelectorAll('.mail-row').length,
    text: document.body.innerText
  })`));
  assert(raceLoginMetrics.address.includes('new@example.test'), `旧登录请求晚到后不应覆盖当前地址: ${JSON.stringify(raceLoginMetrics)}`);
  assert(raceLoginMetrics.text.includes('NEW_ONLY_MAIL'), '旧登录请求晚到后仍应保留新会话邮件');
  assert(!raceLoginMetrics.text.includes('OLD_STALE_MAIL'), '旧登录请求晚到后不应回写旧会话邮件');
  assert(raceLoginMetrics.rows === 1, `旧登录请求晚到后邮件列表数量应保持新会话结果: ${JSON.stringify(raceLoginMetrics)}`);
  results.push({ name: 'webmail-race-login-logout-stale-mails', raceLoginMetrics: { address: raceLoginMetrics.address, rows: raceLoginMetrics.rows } });

  const raceShare = await openApp('/s/race-token');
  await waitUntil(raceShare, `document.body.innerText.includes('BOX_A_INITIAL')`);
  await evaluate(raceShare, `window.__webmailSmokeRace.hold('share-mails:race-token:box-a')`);
  await click(raceShare, '.refresh-button');
  await waitUntil(raceShare, `window.__webmailSmokeRace.pending('share-mails:race-token:box-a') >= 1`);
  await click(raceShare, '.mailbox-menu-button');
  await waitUntil(raceShare, `document.querySelectorAll('.mailbox-menu-option').length >= 2`);
  await evaluate(raceShare, `(() => {
    const option = [...document.querySelectorAll('.mailbox-menu-option')].find((item) => item.textContent.includes('b@example.test'));
    option?.click();
  })()`);
  await waitUntil(raceShare, `document.body.innerText.includes('BOX_B_ONLY') && document.querySelector('.account-address-row')?.dataset.currentMailboxId === 'box-b'`);
  await evaluate(raceShare, `window.__webmailSmokeRace.release('share-mails:race-token:box-a')`);
  await sleep(700);
  const raceShareMetrics = JSON.parse(await evaluate(raceShare, `JSON.stringify({
    address: document.querySelector('.address-copy-text')?.textContent || '',
    selectedMailbox: document.querySelector('.account-address-row')?.dataset.currentMailboxId || '',
    menuButtonExists: !!document.querySelector('.mailbox-menu-button'),
    nativeSelectExists: !!document.querySelector('.mailbox-switcher select'),
    refreshBusy: document.querySelector('.refresh-button')?.getAttribute('aria-busy') || '',
    text: document.body.innerText
  })`));
  assert(raceShareMetrics.selectedMailbox === 'box-b', `共享邮箱切换后自定义选择器应保持 box-b: ${JSON.stringify(raceShareMetrics)}`);
  assert(raceShareMetrics.menuButtonExists && !raceShareMetrics.nativeSelectExists, `共享邮箱选择器应使用小下拉按钮而不是原生 select: ${JSON.stringify(raceShareMetrics)}`);
  assert(raceShareMetrics.address.includes('b@example.test'), `共享邮箱切换后地址应保持 box-b: ${JSON.stringify(raceShareMetrics)}`);
  assert(raceShareMetrics.text.includes('BOX_B_ONLY'), '共享邮箱旧刷新晚到后仍应保留 box-b 邮件');
  assert(!raceShareMetrics.text.includes('BOX_A_STALE'), '共享邮箱旧刷新晚到后不应回写 box-a 邮件');
  assert(raceShareMetrics.refreshBusy !== 'true', `共享邮箱切换后刷新按钮不应卡住: ${JSON.stringify(raceShareMetrics)}`);
  results.push({ name: 'webmail-race-share-refresh-switch', raceShareMetrics: { address: raceShareMetrics.address, selectedMailbox: raceShareMetrics.selectedMailbox, refreshBusy: raceShareMetrics.refreshBusy } });

  const noConfig = await openApp('/s/no-config');
  await waitUntil(noConfig, `document.body.innerText.includes('共享功能未配置')`);
  const noConfigText = await evaluate(noConfig, `document.body.innerText`);
  assert(!noConfigText.includes('SHARE_KV is not configured'), '共享未配置时不应暴露底层 SHARE_KV 原始报错');

  const noConfigKv = await openApp('/s/no-config-kv');
  await waitUntil(noConfigKv, `document.body.innerText.includes('绑定 SHARE_KV')`);
  const noConfigKvText = await evaluate(noConfigKv, `document.body.innerText`);
  assert(!noConfigKvText.includes('SHARE_KV is not configured'), 'SHARE_KV 缺失时不应暴露底层英文原始报错');

  const noConfigSecret = await openApp('/s/no-config-secret');
  await waitUntil(noConfigSecret, `document.body.innerText.includes('设置 SHARE_ENCRYPTION_SECRET')`);
  const noConfigSecretText = await evaluate(noConfigSecret, `document.body.innerText`);
  assert(!noConfigSecretText.includes('SHARE_ENCRYPTION_SECRET is not configured'), 'SHARE_ENCRYPTION_SECRET 缺失时不应暴露底层英文原始报错');

  const noWorker = await openApp('/s/no-worker');
  await waitUntil(noWorker, `document.body.innerText.includes('邮箱 API 未配置')`);
  const noWorkerText = await evaluate(noWorker, `document.body.innerText`);
  assert(!noWorkerText.includes('MAIL_WORKER_BASE_URL is not configured'), 'MAIL_WORKER_BASE_URL 缺失时不应暴露底层英文原始报错');
  results.push({ name: 'webmail-friendly-config-error', cases: ['legacy-share', 'share-kv', 'share-secret', 'mail-worker'] });

  const visualSnapshots = await captureVisualSnapshots();
  if (visualSnapshots.length) results.push({ name: 'webmail-visual-snapshots', files: visualSnapshots });

  console.log(JSON.stringify({ ok: true, baseUrl, results }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  killProcessTree(chromeProcess);
  killProcessTree(previewProcess);
  await sleep(100);
  try { rmSync(tempProfile, { recursive: true, force: true }); } catch {}
  process.exit(process.exitCode || 0);
});
