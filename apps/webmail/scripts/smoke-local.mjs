import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const isWindows = process.platform === 'win32';
const port = Number(process.env.WEBMAIL_SMOKE_PORT || 4274);
const cdpPort = Number(process.env.WEBMAIL_SMOKE_CDP_PORT || 9474);
const baseUrl = process.env.WEBMAIL_SMOKE_URL || `http://127.0.0.1:${port}/`;
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
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch {}
  if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', timeout: 1500 });
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
  return `(() => {
    const mailPages = {
      populated: [{ id: 101, raw: ${JSON.stringify(htmlMail)}, created_at: '2026-05-09T10:35:00.000Z' }, { id: 100, raw: ${JSON.stringify(textMail)}, created_at: '2026-05-09T10:30:00.000Z' }],
      empty: []
    };
    let shareDeleted = false;
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
    window.confirm = () => true;
    window.fetch = async (input, init = {}) => {
      const rawUrl = typeof input === 'string' ? input : input.url;
      const url = new URL(rawUrl, location.origin);
      const path = url.pathname;
      if (path === '/api/session') {
        const body = JSON.parse(init.body || '{}');
        if (body.password === 'bad') return json({ error: { code: 'invalid_login', message: '邮箱或密码错误' } }, 401);
        const address = body.email || 'qa@example.test';
        return json({ ok: true, jwt: address.includes('empty') ? 'jwt-empty' : 'jwt-populated', address, settings: { address } });
      }
      if (path === '/api/settings') return json({ address: 'qa@example.test' });
      if (path === '/api/mails') {
        const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
        const list = String(auth).includes('jwt-empty') ? mailPages.empty : mailPages.populated;
        return json({ results: list, count: list.length });
      }
      if (path === '/api/mail/101' || path === '/api/mail/100') return json({ ok: true });
      if (path === '/api/image') return new Response('not really an image', { status: 415, headers: { 'content-type': 'text/plain' } });
      if (path === '/api/share/no-config') return json({ error: { code: 'share_not_configured', message: 'SHARE_KV is not configured' } }, 500);
      if (path === '/api/share/share-token') return json({ ok: true, token: 'share-token', permissions: { hideMail: true }, addresses: [{ id: 'box1', address: 'shared@example.test' }] });
      if (path === '/api/share/share-token/settings') return json({ address: 'shared@example.test' });
      if (path === '/api/share/share-token/mails') return json({ results: shareDeleted ? [] : mailPages.populated.slice(0, 1), count: shareDeleted ? 0 : 1 });
      if (path === '/api/share/share-token/mail/101') { shareDeleted = true; return json({ ok: true }); }
      return json({ error: { code: 'not_found', message: 'mock route not found: ' + path } }, 404);
    };
  })()`;
}

async function openApp(pathname = '/', { width = 390, height = 844, locale = 'zh-CN' } = {}) {
  const ws = await cdpNewPage('about:blank');
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Runtime.enable');
  await cdpSend(ws, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  await cdpSend(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: mockFetchScript() });
  await cdpSend(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('loven7.locale', ${JSON.stringify(locale)}); sessionStorage.clear();` });
  await cdpSend(ws, 'Page.navigate', { url: new URL(pathname, baseUrl).toString() });
  await cdpSend(ws, 'Page.loadEventFired').catch(() => undefined);
  await sleep(900);
  return ws;
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
  const inboxMetrics = JSON.parse(await evaluate(login, `JSON.stringify({
    xOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    rows: document.querySelectorAll('.mail-row').length,
    hasRawMime: /Content-Type:|MIME-Version:/.test(document.body.innerText),
    htmlText: document.querySelector('.mail-html-view')?.shadowRoot?.textContent || '',
    hasLoadingText: document.body.innerText.includes('正在优化') || document.body.innerText.includes('Loading images'),
    emptyHuge: false
  })`));
  assert(!inboxMetrics.xOverflow, '用户站收件箱不应横向溢出');
  assert(inboxMetrics.rows >= 2, '登录后应显示邮件列表');
  assert(!inboxMetrics.hasRawMime, '邮件正文不应暴露 MIME 头');
  assert(inboxMetrics.htmlText.includes('HTML rendered cleanly'), `HTML 邮件应渲染在阅读区: ${inboxMetrics.htmlText}`);
  assert(!inboxMetrics.hasLoadingText, '切换/加载邮件时不应显示冗余图片优化文案');
  await click(login, '.webmail-locale-toggle');
  const localeMenu = JSON.parse(await evaluate(login, `JSON.stringify((() => {
    const menu = document.querySelector('.webmail-locale-menu');
    const rect = menu?.getBoundingClientRect();
    return { exists: !!menu, z: Number(getComputedStyle(menu).zIndex), top: rect?.top, bottom: rect?.bottom, innerHeight };
  })())`));
  assert(localeMenu.exists && localeMenu.z > 1000, `语言菜单应在最上层: ${JSON.stringify(localeMenu)}`);
  results.push({ name: 'webmail-login-inbox', loginMetrics, inboxMetrics, localeMenu });

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
  await waitUntil(share, `document.querySelector('.danger-button')?.textContent?.includes('删除')`);
  const shareBefore = await evaluate(share, `document.body.innerText`);
  assert(shareBefore.includes('删除邮件'), '共享模式详情按钮应显示“删除邮件”');
  assert(!shareBefore.includes('隐藏邮件'), '共享模式不应向用户显示“隐藏邮件”');
  await click(share, '.danger-button');
  await waitUntil(share, `document.body.innerText.includes('邮件已删除') || document.querySelectorAll('.mail-row').length === 0`);
  const shareAfter = await evaluate(share, `document.body.innerText`);
  assert(shareAfter.includes('暂无邮件'), '共享删除后当前链接应隐藏该邮件并显示空状态');
  results.push({ name: 'webmail-share-delete-copy', ok: true });

  const noConfig = await openApp('/s/no-config');
  await waitUntil(noConfig, `document.body.innerText.includes('共享功能未配置')`);
  const noConfigText = await evaluate(noConfig, `document.body.innerText`);
  assert(!noConfigText.includes('SHARE_KV is not configured'), '共享未配置时不应暴露底层 SHARE_KV 原始报错');
  results.push({ name: 'webmail-friendly-config-error', ok: true });

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
