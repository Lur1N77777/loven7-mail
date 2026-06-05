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

  const raceLogin = await openApp('/');
  await waitUntil(raceLogin, `!!window.__webmailSmokeRace && document.body.innerText.includes('请输入管理员提供的邮箱与密码')`);
  await evaluate(raceLogin, `window.__webmailSmokeRace.hold('mails:jwt-old')`);
  await setInput(raceLogin, 'input[type="email"]', 'old@example.test');
  await setInput(raceLogin, '.password-input-wrap input', 'good');
  await click(raceLogin, '.login-button');
  await waitUntil(raceLogin, `window.__webmailSmokeRace.pending('mails:jwt-old') >= 1 && document.body.innerText.includes('old@example.test')`);
  await click(raceLogin, '.toolbar .ghost-button');
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
