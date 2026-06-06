import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const isWindows = process.platform === 'win32';
const port = Number(process.env.SMOKE_PORT || 4174);
const baseUrl = process.env.SMOKE_URL || `http://127.0.0.1:${port}/`;
const cdpPort = Number(process.env.SMOKE_CDP_PORT || 9340);
const mockApiPort = Number(process.env.SMOKE_API_PORT || 4185);
const shouldCapture = process.env.SMOKE_SCREENSHOTS === '1';
const shotDir = process.env.SMOKE_SCREENSHOT_DIR || path.join(tmpdir(), 'loven7-smoke-shots');
const tempProfile = mkdtempSync(path.join(tmpdir(), 'loven7-smoke-chrome-'));
let previewProcess;
let chromeProcess;
let mockServer;
let secondaryMockServer;
let messageId = 0;
let appApiBase = process.env.SMOKE_API_BASE || '';
let secondaryApiBase = '';
let lastNewAddressPayload = null;
let mockRequestLog = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const mockNow = '2026-05-09T10:20:00.000Z';
const mockUsers = [
  { id: 101, user_email: 'alice@example.test', role_text: 'member', address_count: 2, created_at: mockNow, updated_at: mockNow },
  { id: 102, user_email: 'bob@example.test', role_text: 'member', address_count: 1, created_at: mockNow, updated_at: mockNow },
];
const mockAddresses = [
  { id: 301, name: 'alice.demo01@example.test', user_id: 101, user_email: 'alice@example.test', source_meta: 'user', mail_count: 2, send_count: 0, created_at: mockNow, updated_at: mockNow },
  { id: 302, name: 'alice.work22@example.test', user_id: 101, user_email: 'alice@example.test', source_meta: 'user', mail_count: 1, send_count: 1, created_at: mockNow, updated_at: mockNow },
  { id: 401, name: 'bob.shop88@example.test', user_id: 102, user_email: 'bob@example.test', source_meta: 'user', mail_count: 1, send_count: 0, created_at: mockNow, updated_at: mockNow },
];
const mockRawMails = [
  {
    id: 9002,
    source: 'hello@webshare.io',
    address: 'alice.demo01@example.test',
    created_at: '2026-05-09T10:35:00.000Z',
    raw: [
      'From: Webshare <hello@webshare.io>',
      'To: alice.demo01@example.test',
      'Subject: Your free proxies are still waiting',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="smoke-boundary"',
      '',
      '--smoke-boundary',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Your verification code is 123456.',
      'This plain part should not render MIME headers.',
      '',
      '--smoke-boundary',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<div><h2>Your verification code is <b>123456</b>.</h2><p>HTML body rendered cleanly.</p></div>',
      '',
      '--smoke-boundary--',
    ].join('\r\n'),
  },
  {
    id: 9001,
    source: 'no-reply@nihon.example',
    address: 'alice.demo01@example.test',
    created_at: mockNow,
    raw: [
      'From: "Nihon App" <no-reply@nihon.example>',
      'To: alice.demo01@example.test',
      'Subject: =?UTF-8?B?44Ot44Kw44Kk44Oz56K66KqN44Kz44O844OJ?=',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '本人確認の確認コード：１２３４５６',
      'このコードは10分間有効です。',
    ].join('\r\n'),
  },
  {
    id: 9000,
    source: 'security@example.test',
    address: 'alice.work22@example.test',
    created_at: '2026-05-09T09:55:00.000Z',
    raw: [
      'From: Security <security@example.test>',
      'To: alice.work22@example.test',
      'Subject: Login code',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Your verification code is AB7281.',
    ].join('\r\n'),
  },
];
const mockSendbox = [
  {
    id: 8001,
    address: 'alice.demo01@example.test',
    created_at: mockNow,
    raw: JSON.stringify({ from_mail: 'alice.demo01@example.test', to_mail: 'team@example.test', subject: 'Sent smoke mail', content: 'hello', is_html: false }),
  },
];

function jsonResponse(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-admin-auth,x-custom-auth,x-user-access-token,x-fingerprint,x-lang,Authorization',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

function paginate(items, url) {
  const limit = Number(url.searchParams.get('limit') || 20);
  const offset = Number(url.searchParams.get('offset') || 0);
  return { results: items.slice(offset, offset + limit), count: items.length };
}

function startMockApi(port = mockApiPort) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.method === 'OPTIONS') return jsonResponse(response, 204, {});
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      mockRequestLog.push({
        method: request.method,
        host: request.headers.host || '',
        pathname,
        adminAuth: request.headers['x-admin-auth'] || '',
        siteAuth: request.headers['x-custom-auth'] || '',
        userAccessToken: request.headers['x-user-access-token'] || '',
        authorization: request.headers.authorization || '',
      });
      if (pathname === '/open_api/settings') return jsonResponse(response, 200, {
        domains: ['example.test', 'mail.example.test'],
        defaultDomains: ['example.test'],
        randomSubdomainDomains: ['example.test'],
        minAddressLen: 10,
        maxAddressLen: 15,
        enableSendMail: true,
      });
      if (pathname === '/admin/statistics') return jsonResponse(response, 200, {
        mailCount: mockRawMails.length,
        sendMailCount: mockSendbox.length,
        userCount: mockUsers.length,
        addressCount: mockAddresses.length,
        activeAddressCount7days: 2,
        activeAddressCount30days: 3,
      });
      if (pathname === '/admin/users') return jsonResponse(response, 200, paginate(mockUsers, url));
      if (pathname === '/admin/worker/configs') return jsonResponse(response, 200, {
        ADDRESS_REGEX: process.env.SMOKE_ADDRESS_REGEX || '[^a-z0-9._-]',
      });
      if (pathname.startsWith('/admin/users/bind_address/')) {
        const userId = Number(pathname.split('/').pop());
        return jsonResponse(response, 200, { results: mockAddresses.filter((row) => row.user_id === userId), count: mockAddresses.filter((row) => row.user_id === userId).length });
      }
      if (pathname === '/admin/address') {
        const query = (url.searchParams.get('query') || '').toLowerCase();
        return jsonResponse(response, 200, paginate(mockAddresses.filter((row) => !query || row.name.toLowerCase().includes(query)), url));
      }
      if (pathname === '/admin/new_address' && request.method === 'POST') {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch {}
          lastNewAddressPayload = payload;
          const localPart = String(payload.name || 'mail123demo');
          const domain = String(payload.domain || 'example.test');
          jsonResponse(response, 200, {
            address: `${localPart}@${domain}`,
            jwt: 'smoke.jwt.token',
            address_id: 9999,
          });
        });
        return;
      }
      if (pathname === '/admin/address_sender') return jsonResponse(response, 200, { results: [], count: 0 });
      if (pathname === '/admin/user_roles') return jsonResponse(response, 200, [
        { role: 'member', label: 'Member' },
        { role: 'vip', label: 'VIP' },
      ]);
      if (pathname === '/admin/role_address_config') return jsonResponse(response, 200, { configs: { member: { maxAddressCount: 20 } } });
      if (pathname === '/admin/db_version') return jsonResponse(response, 200, { version: 'mock', ok: true });
      if (
        pathname === '/admin/auto_cleanup'
        || pathname === '/admin/account_settings'
        || pathname === '/admin/user_settings'
        || pathname === '/admin/user_oauth2_settings'
        || pathname === '/admin/webhook/settings'
        || pathname === '/admin/mail_webhook/settings'
        || pathname === '/admin/ip_blacklist/settings'
        || pathname === '/admin/ai_extract/settings'
        || pathname === '/admin/telegram/settings'
      ) {
        return jsonResponse(response, 200, {
          enableUserRegister: true,
          enableEmailVerify: false,
          defaultUserRole: 'member',
          jwtExpire: 3600,
          emailRuleSettings: { blockReceiveUnknowAddressEmail: false },
          addressCreationSettings: { enableSubdomainMatch: true },
          sendMailLimitConfig: { dailyEnabled: true, dailyLimit: 100 },
          cleanupInterval: 'daily',
          retentionDays: 30,
        });
      }
      if (pathname === '/admin/mails') {
        const address = (url.searchParams.get('address') || '').toLowerCase();
        return jsonResponse(response, 200, paginate(mockRawMails.filter((row) => !address || row.address.toLowerCase() === address), url));
      }
      if (pathname === '/admin/mails_unknow') return jsonResponse(response, 200, { results: [], count: 0 });
      if (pathname === '/admin/sendbox') return jsonResponse(response, 200, paginate(mockSendbox, url));
      if (request.method === 'DELETE' || request.method === 'POST') return jsonResponse(response, 200, { ok: true });
      return jsonResponse(response, 404, { error: `mock route not found: ${pathname}` });
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function waitForHttp(url, timeoutMs = 20_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok || res.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

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
  if (!found) throw new Error('Chrome/Edge executable not found. Install Chrome or set SMOKE_URL and run a browser-supported smoke manually.');
  return found;
}

function spawnPreviewIfNeeded() {
  if (process.env.SMOKE_URL) return undefined;
  const command = isWindows ? 'cmd.exe' : 'npm';
  const args = isWindows
    ? ['/d', '/s', '/c', `npm run preview -- --port ${port} --strictPort`]
    : ['run', 'preview', '--', '--port', String(port), '--strictPort'];
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[preview] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[preview] ${chunk}`));
  return child;
}

function spawnChrome() {
  const chrome = findChrome();
  return spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tempProfile}`,
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    '--disable-features=VizDisplayCompositor,UseSkiaRenderer',
    '--no-sandbox',
    '--ignore-certificate-errors',
    '--no-first-run',
    'about:blank',
  ], { stdio: 'ignore' });
}

function killProcessTree(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch {}
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', timeout: 1500 });
  } else {
    child.kill('SIGTERM');
  }
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
  const result = await cdpSend(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
  return result.result?.value;
}

function flattenFrames(frameTree, frames = []) {
  if (!frameTree) return frames;
  if (frameTree.frame) frames.push(frameTree.frame);
  for (const child of frameTree.childFrames || []) flattenFrames(child, frames);
  return frames;
}

async function evaluateMailFrameText(ws) {
  const tree = await cdpSend(ws, 'Page.getFrameTree');
  const frames = flattenFrames(tree.frameTree);
  const mainFrameId = tree.frameTree?.frame?.id;
  const frame = frames.find((item) => item.id !== mainFrameId && /srcdoc|about:blank|^$/.test(item.url || '')) || frames.find((item) => item.id !== mainFrameId);
  if (frame) {
    const world = await cdpSend(ws, 'Page.createIsolatedWorld', { frameId: frame.id, worldName: `loven7-smoke-${Date.now()}`, grantUniveralAccess: true }).catch(() => null);
    if (world?.executionContextId) {
      const result = await cdpSend(ws, 'Runtime.evaluate', {
        expression: 'document.body ? document.body.innerText : ""',
        returnByValue: true,
        awaitPromise: false,
        contextId: world.executionContextId,
      }).catch(() => null);
      if (result?.result?.value) return result.result.value;
    }
  }
  return await evaluate(ws, `(() => {
    const srcdoc = document.querySelector('.mail-frame')?.getAttribute('srcdoc') || '';
    return srcdoc.replace(/<script[\\s\\S]*?<\\/script>/gi, ' ').replace(/<style[\\s\\S]*?<\\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim();
  })()`).catch(() => '');
}

async function waitForMailFrameText(ws, matcher, timeoutMs = 5000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    last = await evaluateMailFrameText(ws).catch(() => '');
    if (matcher(last)) return last;
    await sleep(250);
  }
  return last;
}

async function openApp({ width, height, dark = false, mobile, seedAuth = true, legacyAuthCookie = '', authRememberedAt = Date.now(), extraStorageScript = '' }) {
  const ws = await cdpNewPage('about:blank');
  ws.send(JSON.stringify({ id: ++messageId, method: 'Page.enable', params: {} }));
  const emulateMobile = typeof mobile === 'boolean' ? mobile : width < 768;
  const staleAddressIndex = {
    version: 1,
    count: 2,
    savedAt: Date.now(),
    complete: true,
    results: mockAddresses.filter((row) => row.name.startsWith('alice.')),
  };
  const authStorageScript = seedAuth
    ? `
      Object.keys(localStorage).filter((key) => key.startsWith('loven7.auth.v1.')).forEach((key) => localStorage.removeItem(key));
      Object.keys(sessionStorage).filter((key) => key.startsWith('loven7.auth.v1.')).forEach((key) => sessionStorage.removeItem(key));
      localStorage.removeItem('loven7.authExpiredNotice');
      localStorage.setItem('loven7.adminPassword',${JSON.stringify(process.env.SMOKE_ADMIN_PASSWORD || 'smoke-cache')});
      localStorage.setItem('loven7.apiBase',${JSON.stringify(appApiBase)});
      ${authRememberedAt === null ? `localStorage.removeItem('loven7.authRememberedAt');` : `localStorage.setItem('loven7.authRememberedAt',${JSON.stringify(String(authRememberedAt))});`}
    `
    : `
      document.cookie = 'loven7.authCookieMirror=; Max-Age=0; Path=/; SameSite=Strict';
      Object.keys(localStorage).filter((key) => key.startsWith('loven7.auth.v1.')).forEach((key) => localStorage.removeItem(key));
      Object.keys(sessionStorage).filter((key) => key.startsWith('loven7.auth.v1.')).forEach((key) => sessionStorage.removeItem(key));
      localStorage.removeItem('loven7.adminPassword');
      localStorage.removeItem('loven7.sitePassword');
      localStorage.removeItem('loven7.userAccessToken');
      localStorage.removeItem('loven7.addressJwt');
      localStorage.removeItem('loven7.apiBase');
      localStorage.removeItem('loven7.authRememberedAt');
      localStorage.removeItem('loven7.authExpiredNotice');
      sessionStorage.removeItem('loven7.adminPassword');
      sessionStorage.removeItem('loven7.sitePassword');
      sessionStorage.removeItem('loven7.userAccessToken');
      sessionStorage.removeItem('loven7.addressJwt');
      sessionStorage.removeItem('loven7.authRememberedAt');
    `;
  const cookieScript = legacyAuthCookie
    ? `document.cookie = 'loven7.authCookieMirror=${encodeURIComponent(legacyAuthCookie)}; Path=/; SameSite=Strict';`
    : '';
  await cdpSend(ws, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: emulateMobile });
  await cdpSend(ws, 'Emulation.setTouchEmulationEnabled', { enabled: emulateMobile, maxTouchPoints: emulateMobile ? 5 : 0 }).catch(() => undefined);
  await cdpSend(ws, 'Page.addScriptToEvaluateOnNewDocument', {
    source: `
      ${authStorageScript}
      localStorage.setItem('loven7.uiTheme','${dark ? 'dark' : 'light'}');
      localStorage.setItem('loven7.locale','zh-CN');
      localStorage.setItem('loven7.mailAutoRefreshEnabled','true');
      localStorage.setItem('loven7.mailAutoRefreshSeconds','60');
      localStorage.removeItem('loven7.frontendLoginBase');
      localStorage.removeItem('loven7.newAddressDraft');
      localStorage.removeItem('loven7.mailReadIds');
      localStorage.removeItem('loven7.mailStarredIds');
      localStorage.removeItem('loven7.mailReadAllBefore');
      Object.keys(localStorage).filter((key) => key.startsWith('loven7.mailReadIds.') || key.startsWith('loven7.mailStarredIds.') || key.startsWith('loven7.mailReadAllBefore.')).forEach((key) => localStorage.removeItem(key));
      localStorage.setItem('loven7.addressListCache.index:id:descend',${JSON.stringify(JSON.stringify(staleAddressIndex))});
      ${extraStorageScript}
      ${cookieScript}
    `,
  });
  await cdpSend(ws, 'Page.navigate', { url: baseUrl });
  await sleep(350);
  const storageState = await evaluate(ws, `JSON.stringify({
    apiBase: localStorage.getItem('loven7.apiBase') || '',
    adminPassword: localStorage.getItem('loven7.adminPassword') || '',
    theme: localStorage.getItem('loven7.uiTheme') || ''
  })`).catch(() => '{}');
  const parsedStorage = JSON.parse(storageState || '{}');
  if (seedAuth && (parsedStorage.apiBase !== appApiBase || parsedStorage.theme !== (dark ? 'dark' : 'light'))) {
    await evaluate(ws, `
      Object.keys(localStorage).filter((key) => key.startsWith('loven7.auth.v1.')).forEach((key) => localStorage.removeItem(key));
      Object.keys(sessionStorage).filter((key) => key.startsWith('loven7.auth.v1.')).forEach((key) => sessionStorage.removeItem(key));
      localStorage.setItem('loven7.adminPassword',${JSON.stringify(process.env.SMOKE_ADMIN_PASSWORD || 'smoke-cache')});
      localStorage.setItem('loven7.apiBase',${JSON.stringify(appApiBase)});
      localStorage.removeItem('loven7.authExpiredNotice');
      ${authRememberedAt === null ? `localStorage.removeItem('loven7.authRememberedAt');` : `localStorage.setItem('loven7.authRememberedAt',${JSON.stringify(String(authRememberedAt))});`}
      localStorage.setItem('loven7.uiTheme','${dark ? 'dark' : 'light'}');
      localStorage.setItem('loven7.locale','zh-CN');
      localStorage.setItem('loven7.mailAutoRefreshEnabled','true');
      localStorage.setItem('loven7.mailAutoRefreshSeconds','60');
      localStorage.removeItem('loven7.frontendLoginBase');
      localStorage.removeItem('loven7.newAddressDraft');
      localStorage.removeItem('loven7.mailReadIds');
      localStorage.removeItem('loven7.mailStarredIds');
      localStorage.removeItem('loven7.mailReadAllBefore');
      Object.keys(localStorage).filter((key) => key.startsWith('loven7.mailReadIds.') || key.startsWith('loven7.mailStarredIds.') || key.startsWith('loven7.mailReadAllBefore.')).forEach((key) => localStorage.removeItem(key));
      localStorage.setItem('loven7.addressListCache.index:id:descend',${JSON.stringify(JSON.stringify(staleAddressIndex))});
      ${extraStorageScript}
    `);
    await cdpSend(ws, 'Page.navigate', { url: baseUrl });
  }
  await sleep(1800);
  return ws;
}

function encodeCookieMirror(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function authScopeForBase(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '') || 'same-origin';
  return Buffer.from(normalized, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') || 'same-origin';
}

function isPrivateAdminStorageKey(key) {
  return [
    'loven7.adminPassword',
    'loven7.sitePassword',
    'loven7.userAccessToken',
    'loven7.addressJwt',
    'loven7.authRememberedAt',
    'loven7.addressUserFilter',
    'loven7.shareAdminListCache',
    'loven7.mailReadIds',
    'loven7.mailStarredIds',
    'loven7.mailReadAllBefore',
  ].includes(key)
    || key.startsWith('loven7.auth.v1.')
    || key.startsWith('loven7.mailListCache.')
    || key.startsWith('loven7.mailDetailSession.')
    || key.startsWith('loven7.mailReadIds.')
    || key.startsWith('loven7.mailStarredIds.')
    || key.startsWith('loven7.mailReadAllBefore.')
    || key.startsWith('loven7.addressListCache.')
    || key.startsWith('loven7.senderAccessListCache.')
    || key.startsWith('loven7.userListCache.');
}

async function setInputValue(ws, selectorExpression, value) {
  await evaluate(ws, `(() => {
    const input = ${selectorExpression};
    if (!input) return false;
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(input, ${JSON.stringify(value)}) : (input.value = ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function readAuthStorageSnapshot(ws) {
  return JSON.parse(await evaluate(ws, `JSON.stringify((() => {
    const normalizeBase = (value) => String(value || '').trim().replace(/\\/+$/, '');
    const encodeScope = (value) => {
      const normalized = normalizeBase(value) || 'same-origin';
      const bytes = new TextEncoder().encode(normalized);
      let binary = '';
      bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
      return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '') || 'same-origin';
    };
    const rawCookie = (document.cookie.split('; ').find((part) => part.startsWith('loven7.authCookieMirror=')) || '').split('=').slice(1).join('=');
    let decodedCookie = '';
    let parsedCookie = null;
    if (rawCookie) {
      try {
        const binary = atob(decodeURIComponent(rawCookie));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        decodedCookie = new TextDecoder().decode(bytes);
        parsedCookie = JSON.parse(decodedCookie);
      } catch (error) {
        decodedCookie = String(error);
      }
    }
    const currentApiBase = localStorage.getItem('loven7.apiBase') || '';
    const currentScope = encodeScope(currentApiBase);
    const scopedKey = (field) => 'loven7.auth.v1.' + currentScope + '.' + field;
    return {
      rawCookie,
      decodedCookie,
      parsedCookie,
      modalOpen: !!document.querySelector('.modal-card'),
      currentScope,
      localApiBase: currentApiBase,
      localAdmin: localStorage.getItem(scopedKey('adminPassword')) || localStorage.getItem('loven7.adminPassword') || '',
      localSite: localStorage.getItem(scopedKey('sitePassword')) || localStorage.getItem('loven7.sitePassword') || '',
      localAccessToken: localStorage.getItem(scopedKey('userAccessToken')) || localStorage.getItem('loven7.userAccessToken') || '',
      localAddressJwt: localStorage.getItem(scopedKey('addressJwt')) || localStorage.getItem('loven7.addressJwt') || '',
      localRememberedAt: localStorage.getItem(scopedKey('rememberedAt')) || localStorage.getItem('loven7.authRememberedAt') || '',
      legacyLocalAdmin: localStorage.getItem('loven7.adminPassword') || '',
      legacyLocalSite: localStorage.getItem('loven7.sitePassword') || '',
      legacyLocalAccessToken: localStorage.getItem('loven7.userAccessToken') || '',
      legacyLocalAddressJwt: localStorage.getItem('loven7.addressJwt') || '',
      legacyLocalRememberedAt: localStorage.getItem('loven7.authRememberedAt') || '',
      localExpiredNotice: localStorage.getItem('loven7.authExpiredNotice') || '',
      sessionAdmin: sessionStorage.getItem(scopedKey('adminPassword')) || sessionStorage.getItem('loven7.adminPassword') || '',
      sessionSite: sessionStorage.getItem(scopedKey('sitePassword')) || sessionStorage.getItem('loven7.sitePassword') || '',
      sessionAccessToken: sessionStorage.getItem(scopedKey('userAccessToken')) || sessionStorage.getItem('loven7.userAccessToken') || '',
      sessionAddressJwt: sessionStorage.getItem(scopedKey('addressJwt')) || sessionStorage.getItem('loven7.addressJwt') || '',
      sessionRememberedAt: sessionStorage.getItem(scopedKey('rememberedAt')) || sessionStorage.getItem('loven7.authRememberedAt') || '',
      legacySessionAdmin: sessionStorage.getItem('loven7.adminPassword') || '',
      legacySessionSite: sessionStorage.getItem('loven7.sitePassword') || '',
      legacySessionAccessToken: sessionStorage.getItem('loven7.userAccessToken') || '',
      legacySessionAddressJwt: sessionStorage.getItem('loven7.addressJwt') || '',
      legacySessionRememberedAt: sessionStorage.getItem('loven7.authRememberedAt') || '',
      localTheme: localStorage.getItem('loven7.uiTheme') || '',
      localLocale: localStorage.getItem('loven7.locale') || '',
      localNewAddressDraft: localStorage.getItem('loven7.newAddressDraft') || '',
      localFrontendLoginBase: localStorage.getItem('loven7.frontendLoginBase') || '',
      localMailAutoRefreshEnabled: localStorage.getItem('loven7.mailAutoRefreshEnabled') || '',
      localMailAutoRefreshSeconds: localStorage.getItem('loven7.mailAutoRefreshSeconds') || '',
      localMailReadIds: Object.keys(localStorage).filter((key) => key === 'loven7.mailReadIds' || key.startsWith('loven7.mailReadIds.')).map((key) => localStorage.getItem(key) || '').join('|'),
      localMailStarredIds: Object.keys(localStorage).filter((key) => key === 'loven7.mailStarredIds' || key.startsWith('loven7.mailStarredIds.')).map((key) => localStorage.getItem(key) || '').join('|'),
      privateLocalKeys: Object.keys(localStorage).filter(${isPrivateAdminStorageKey.toString()}),
      privateSessionKeys: Object.keys(sessionStorage).filter(${isPrivateAdminStorageKey.toString()}),
      adminPasswordInputs: [...document.querySelectorAll('.modal-card input[type="password"]')].map((input) => input.value),
      accessTokenValue: document.querySelector('.modal-card textarea')?.value || '',
      expiredNoticeVisible: /超过 7 天未重新认证|more than 7 days since the last verification/i.test(document.body.innerText),
      bodySample: document.body.innerText.slice(0, 1000)
    };
  })())`));
}

async function clickText(ws, text) {
  await evaluate(ws, `[...document.querySelectorAll('button,a')].find((el) => el.innerText.includes(${JSON.stringify(text)}))?.click()`);
  await sleep(650);
}

async function clickSelector(ws, selector, textIncludes = '') {
  const expression = textIncludes
    ? `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.innerText.includes(${JSON.stringify(textIncludes)}))?.click()`
    : `document.querySelector(${JSON.stringify(selector)})?.click()`;
  await evaluate(ws, expression);
  await sleep(800);
}

async function touchSwipe(ws, startX, startY, endX, endY) {
  await evaluate(ws, `(() => {
    const startX = ${Math.round(startX)};
    const startY = ${Math.round(startY)};
    const endX = ${Math.round(endX)};
    const endY = ${Math.round(endY)};
    const midX = Math.round((startX + endX) / 2);
    const midY = Math.round((startY + endY) / 2);
    const target = document.elementFromPoint(startX, startY) || document.body;
    const touch = (x, y) => ({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 0.8 });
    const dispatch = (type, x, y) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const points = type === 'touchend' || type === 'touchcancel' ? [] : [touch(x, y)];
      Object.defineProperty(event, 'touches', { value: points });
      Object.defineProperty(event, 'targetTouches', { value: points });
      Object.defineProperty(event, 'changedTouches', { value: [touch(x, y)] });
      target.dispatchEvent(event);
    };
    dispatch('touchstart', startX, startY);
    dispatch('touchmove', midX, midY);
    dispatch('touchmove', endX, endY);
    dispatch('touchend', endX, endY);
  })()`);
  await sleep(650);
}

async function cdpTouchSwipe(ws, startX, startY, endX, endY) {
  const sx = Math.round(startX);
  const sy = Math.round(startY);
  const ex = Math.round(endX);
  const ey = Math.round(endY);
  const mx = Math.round((sx + ex) / 2);
  const my = Math.round((sy + ey) / 2);
  await cdpSend(ws, 'Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy, radiusX: 2, radiusY: 2, force: 1 }] });
  await sleep(60);
  await cdpSend(ws, 'Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mx, y: my, radiusX: 2, radiusY: 2, force: 1 }] });
  await sleep(60);
  await cdpSend(ws, 'Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: ex, y: ey, radiusX: 2, radiusY: 2, force: 1 }] });
  await sleep(60);
  await cdpSend(ws, 'Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(800);
}

async function collect(ws, name) {
  const expression = `JSON.stringify({
    name: ${JSON.stringify(name)},
    url: location.href,
    title: document.title,
    textLength: document.body.innerText.trim().length,
    xOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
    viewport: { width: innerWidth, height: innerHeight },
    mobileHeaderText: document.querySelector('.mobile-header')?.innerText || '',
    mailListWidth: Math.round(document.querySelector('.mail-list-panel')?.getBoundingClientRect().width || 0),
    mailDetailDisplay: getComputedStyle(document.querySelector('.mail-detail-pane') || document.body).display,
    mobileDetailDisplay: document.querySelector('.mobile-mail-detail') ? getComputedStyle(document.querySelector('.mobile-mail-detail')).display : '',
    verifyCodes: [...document.querySelectorAll('.verify-pill')].map((el) => el.textContent.trim()).filter(Boolean),
    mailItems: document.querySelectorAll('.mail-list-item').length,
    userOptions: [...document.querySelectorAll('.user-filter-option')].map((el) => el.textContent.trim()).filter(Boolean),
    bodySample: document.body.innerText.slice(0, 1400),
    modal: !!document.querySelector('.modal-card'),
    credentialButton: !!document.querySelector('.mobile-credential-slot button') || [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '凭据'),
    senderPanelMounted: !!document.querySelector('.sender-access-panel'),
    senderToggle: !!document.querySelector('.sender-access-toggle')
  })`;
  let raw;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    raw = await evaluate(ws, expression).catch(() => undefined);
    if (typeof raw === 'string' && raw.length > 0) break;
    await sleep(500);
  }
  if (typeof raw !== 'string' || !raw) throw new Error(`collect(${name}) returned no JSON`);
  const info = JSON.parse(raw);
  if (shouldCapture) {
    const shot = await cdpSend(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
  }
  return info;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (shouldCapture) await import('node:fs').then((fs) => fs.mkdirSync(shotDir, { recursive: true }));
  previewProcess = spawnPreviewIfNeeded();
  await waitForHttp(baseUrl);
  const shouldUseMockApi = !process.env.SMOKE_API_BASE && process.env.SMOKE_MOCK_API !== '0' && baseUrl.startsWith('http://');
  if (shouldUseMockApi) {
    mockServer = await startMockApi();
    appApiBase = `http://127.0.0.1:${mockApiPort}`;
    secondaryMockServer = await startMockApi(mockApiPort + 1);
    secondaryApiBase = `http://127.0.0.1:${mockApiPort + 1}`;
  }
  chromeProcess = spawnChrome();
  await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`);
  const extraResults = [];

  const authSecurity = await openApp({
    width: 390,
    height: 844,
    seedAuth: false,
    legacyAuthCookie: encodeCookieMirror({
      apiBase: appApiBase,
      adminPassword: 'legacy-admin-secret',
      sitePassword: 'legacy-site-secret',
      userAccessToken: 'legacy-access-token',
      rememberedAt: Date.now(),
    }),
  });
  const legacyCookieSnapshot = await readAuthStorageSnapshot(authSecurity);
  extraResults.push({ name: 'admin-auth-legacy-cookie-scrubbed', ...legacyCookieSnapshot });
  assert(legacyCookieSnapshot.modalOpen, `auth modal should open when only legacy cookie had sensitive credentials: ${JSON.stringify(legacyCookieSnapshot)}`);
  assert(legacyCookieSnapshot.parsedCookie?.apiBase === appApiBase, `legacy cookie should keep apiBase only: ${JSON.stringify(legacyCookieSnapshot)}`);
  assert(!legacyCookieSnapshot.parsedCookie?.adminPassword && !legacyCookieSnapshot.parsedCookie?.sitePassword && !legacyCookieSnapshot.parsedCookie?.userAccessToken, `legacy auth cookie should be scrubbed: ${JSON.stringify(legacyCookieSnapshot)}`);
  assert(!legacyCookieSnapshot.decodedCookie.includes('legacy-admin-secret') && !legacyCookieSnapshot.decodedCookie.includes('legacy-site-secret') && !legacyCookieSnapshot.decodedCookie.includes('legacy-access-token'), `legacy secrets should not remain in cookie: ${legacyCookieSnapshot.decodedCookie}`);

  await setInputValue(authSecurity, `document.querySelector('.modal-card input[inputmode="url"]')`, appApiBase);
  await setInputValue(authSecurity, `document.querySelector('.modal-card input[type="password"]')`, 'smoke-admin-secret');
  await evaluate(authSecurity, `[...document.querySelectorAll('.modal-card button')].find((button) => /高级选项|Advanced/.test(button.textContent || ''))?.click()`);
  await sleep(300);
  await setInputValue(authSecurity, `[...document.querySelectorAll('.modal-card input[type="password"]')][1]`, 'smoke-site-secret');
  await setInputValue(authSecurity, `document.querySelector('.modal-card textarea')`, 'smoke-access-token');
  await evaluate(authSecurity, `[...document.querySelectorAll('.modal-card button')].find((button) => /保存并验证|Save and verify/.test(button.textContent || ''))?.click()`);
  await sleep(1400);
  const savedCookieSnapshot = await readAuthStorageSnapshot(authSecurity);
  extraResults.push({ name: 'admin-auth-save-cookie-non-sensitive', ...savedCookieSnapshot });
  assert(!savedCookieSnapshot.modalOpen, `auth modal should close after successful save: ${JSON.stringify(savedCookieSnapshot)}`);
  assert(savedCookieSnapshot.localAdmin === 'smoke-admin-secret' && savedCookieSnapshot.localSite === 'smoke-site-secret' && savedCookieSnapshot.localAccessToken === 'smoke-access-token', `localStorage should still remember credentials for UX: ${JSON.stringify(savedCookieSnapshot)}`);
  assert(savedCookieSnapshot.sessionAdmin === 'smoke-admin-secret' && savedCookieSnapshot.sessionSite === 'smoke-site-secret' && savedCookieSnapshot.sessionAccessToken === 'smoke-access-token', `sessionStorage should mirror credentials for current tab: ${JSON.stringify(savedCookieSnapshot)}`);
  assert(!savedCookieSnapshot.legacyLocalAdmin && !savedCookieSnapshot.legacyLocalSite && !savedCookieSnapshot.legacyLocalAccessToken && !savedCookieSnapshot.legacyLocalRememberedAt, `saving auth should remove legacy global localStorage credentials: ${JSON.stringify(savedCookieSnapshot)}`);
  assert(!savedCookieSnapshot.legacySessionAdmin && !savedCookieSnapshot.legacySessionSite && !savedCookieSnapshot.legacySessionAccessToken && !savedCookieSnapshot.legacySessionRememberedAt, `saving auth should remove legacy global sessionStorage credentials: ${JSON.stringify(savedCookieSnapshot)}`);
  assert(savedCookieSnapshot.parsedCookie?.apiBase === appApiBase && savedCookieSnapshot.parsedCookie?.rememberedAt, `auth cookie should keep only non-sensitive metadata: ${JSON.stringify(savedCookieSnapshot)}`);
  assert(!savedCookieSnapshot.parsedCookie?.adminPassword && !savedCookieSnapshot.parsedCookie?.sitePassword && !savedCookieSnapshot.parsedCookie?.userAccessToken, `auth cookie should not store sensitive fields: ${JSON.stringify(savedCookieSnapshot)}`);
  assert(!savedCookieSnapshot.decodedCookie.includes('smoke-admin-secret') && !savedCookieSnapshot.decodedCookie.includes('smoke-site-secret') && !savedCookieSnapshot.decodedCookie.includes('smoke-access-token'), `saved cookie must not contain secrets: ${savedCookieSnapshot.decodedCookie}`);

  if (secondaryApiBase) {
    mockRequestLog = [];
    await evaluate(authSecurity, `[...document.querySelectorAll('button')].find((button) => /凭据|Auth/.test(button.textContent || button.getAttribute('aria-label') || ''))?.click()`);
    await sleep(500);
    await setInputValue(authSecurity, `document.querySelector('.modal-card input[inputmode="url"]')`, secondaryApiBase);
    await sleep(300);
    const switchedEmptySnapshot = await readAuthStorageSnapshot(authSecurity);
    extraResults.push({ name: 'admin-auth-switch-base-clears-old-inputs', ...switchedEmptySnapshot });
    assert(switchedEmptySnapshot.adminPasswordInputs.every((value) => !value) && !switchedEmptySnapshot.accessTokenValue, `switching to an unbound API base should clear old credentials in the form: ${JSON.stringify(switchedEmptySnapshot)}`);
    await evaluate(authSecurity, `[...document.querySelectorAll('.modal-card button')].find((button) => /保存并验证|Save and verify/.test(button.textContent || ''))?.click()`);
    await sleep(900);
    const secondaryHost = new URL(secondaryApiBase).host;
    const leakedToSecondary = mockRequestLog.filter((entry) => entry.host === secondaryHost && (entry.adminAuth === 'smoke-admin-secret' || entry.siteAuth === 'smoke-site-secret' || entry.userAccessToken === 'smoke-access-token' || /smoke\.jwt/.test(entry.authorization)));
    extraResults.push({ name: 'admin-auth-switch-base-no-old-header-leak', secondaryRequests: mockRequestLog.filter((entry) => entry.host === secondaryHost) });
    assert(leakedToSecondary.length === 0, `old API base credentials must not be sent to new API base: ${JSON.stringify(leakedToSecondary)}`);
    await setInputValue(authSecurity, `document.querySelector('.modal-card input[type="password"]')`, 'secondary-admin-secret');
    await evaluate(authSecurity, `[...document.querySelectorAll('.modal-card button')].find((button) => /保存并验证|Save and verify/.test(button.textContent || ''))?.click()`);
    await sleep(1400);
    const secondarySavedSnapshot = await readAuthStorageSnapshot(authSecurity);
    extraResults.push({ name: 'admin-auth-secondary-base-saved', ...secondarySavedSnapshot });
    assert(!secondarySavedSnapshot.modalOpen, `secondary base auth should save and close modal: ${JSON.stringify(secondarySavedSnapshot)}`);
    assert(secondarySavedSnapshot.localApiBase === secondaryApiBase && secondarySavedSnapshot.localAdmin === 'secondary-admin-secret', `secondary base should have its own scoped credentials: ${JSON.stringify(secondarySavedSnapshot)}`);
    assert(!secondarySavedSnapshot.legacyLocalAdmin && !secondarySavedSnapshot.legacySessionAdmin, `secondary save should not recreate global legacy credentials: ${JSON.stringify(secondarySavedSnapshot)}`);
    await evaluate(authSecurity, `[...document.querySelectorAll('button')].find((button) => /凭据|Auth/.test(button.textContent || button.getAttribute('aria-label') || ''))?.click()`);
    await sleep(500);
    await setInputValue(authSecurity, `document.querySelector('.modal-card input[inputmode="url"]')`, appApiBase);
    await sleep(300);
    const switchedBackSnapshot = await readAuthStorageSnapshot(authSecurity);
    extraResults.push({ name: 'admin-auth-switch-back-loads-original-scope', ...switchedBackSnapshot });
    assert(switchedBackSnapshot.adminPasswordInputs.some((value) => value === 'smoke-admin-secret'), `switching back to original API base should load original scoped admin credential: ${JSON.stringify(switchedBackSnapshot)}`);
    await evaluate(authSecurity, `[...document.querySelectorAll('.modal-card button')].find((button) => /保存并验证|Save and verify/.test(button.textContent || ''))?.click()`);
    await sleep(1200);
  }

  await evaluate(authSecurity, `(() => {
    const scope = ${JSON.stringify(authScopeForBase(appApiBase))};
    localStorage.setItem('loven7.auth.v1.' + scope + '.addressJwt', 'smoke.jwt.token');
    sessionStorage.setItem('loven7.auth.v1.' + scope + '.addressJwt', 'smoke.session.jwt.token');
    localStorage.setItem('loven7.auth.v1.' + scope + '.rememberedAt', '1780000000000');
    sessionStorage.setItem('loven7.auth.v1.' + scope + '.rememberedAt', '1780000000000');
    localStorage.setItem('loven7.addressUserFilter', JSON.stringify({ userId: 101, userEmail: 'alice@example.test', requestId: 1 }));
    localStorage.setItem('loven7.shareAdminListCache', JSON.stringify({ version: 1, results: [{ token: 'private-share-token' }] }));
    localStorage.setItem('loven7.mailListCache.inbox:1:20:', JSON.stringify({ version: 1, items: [{ id: 9002, subject: 'private mail cache' }] }));
    sessionStorage.setItem('loven7.mailDetailSession.inbox:9002', JSON.stringify({ id: 9002, raw: 'private raw mail cache' }));
    localStorage.setItem('loven7.addressListCache.index:id:descend', JSON.stringify({ version: 1, results: [{ address: 'private-address-cache@example.test' }] }));
    localStorage.setItem('loven7.senderAccessListCache.1:20:test', JSON.stringify({ version: 1, results: [{ address: 'private-sender-cache@example.test' }] }));
    localStorage.setItem('loven7.userListCache.1:20:', JSON.stringify({ version: 1, users: [{ user_email: 'private-user-cache@example.test' }] }));
    localStorage.setItem('loven7.locale', 'en-US');
    localStorage.setItem('loven7.newAddressDraft', JSON.stringify({ version: 1, customPrefix: 'keep.', selectedDomain: 'example.test' }));
    localStorage.setItem('loven7.frontendLoginBase', 'https://webmail.example.test');
    localStorage.setItem('loven7.mailAutoRefreshEnabled', 'false');
    localStorage.setItem('loven7.mailAutoRefreshSeconds', '45');
    localStorage.setItem('loven7.mailReadIds', JSON.stringify(['inbox:9002']));
    localStorage.setItem('loven7.mailStarredIds', JSON.stringify(['inbox:9002']));
  })()`);
  const beforeForgetSnapshot = await readAuthStorageSnapshot(authSecurity);
  extraResults.push({ name: 'admin-auth-before-forget-browser', ...beforeForgetSnapshot });
  assert(beforeForgetSnapshot.privateLocalKeys.length >= 5 && beforeForgetSnapshot.privateSessionKeys.length >= 1, `forget-browser setup should seed private keys: ${JSON.stringify(beforeForgetSnapshot)}`);
  await evaluate(authSecurity, `[...document.querySelectorAll('button')].find((button) => /凭据|Auth/.test(button.textContent || button.getAttribute('aria-label') || ''))?.click()`);
  await sleep(500);
  await evaluate(authSecurity, `[...document.querySelectorAll('.modal-card button')].find((button) => /退出并忘记此浏览器|Sign out and forget this browser/.test(button.textContent || ''))?.click()`);
  await sleep(400);
  await evaluate(authSecurity, `[...document.querySelectorAll('.modal-card button')].find((button) => /退出并清理|Sign out and clear/.test(button.textContent || ''))?.click()`);
  await sleep(900);
  await evaluate(authSecurity, `[...document.querySelectorAll('button')].find((button) => /凭据|Auth/.test(button.textContent || button.getAttribute('aria-label') || ''))?.click()`);
  await sleep(500);
  await evaluate(authSecurity, `[...document.querySelectorAll('.modal-card button')].find((button) => /高级选项|Advanced/.test(button.textContent || ''))?.click()`);
  await sleep(300);
  const forgetSnapshot = await readAuthStorageSnapshot(authSecurity);
  extraResults.push({ name: 'admin-auth-forget-browser-clears-private-state', ...forgetSnapshot });
  assert(!forgetSnapshot.rawCookie, `forget browser should delete auth cookie mirror: ${JSON.stringify(forgetSnapshot)}`);
  assert(!forgetSnapshot.localAdmin && !forgetSnapshot.localSite && !forgetSnapshot.localAccessToken && !forgetSnapshot.localAddressJwt && !forgetSnapshot.localRememberedAt, `forget browser should clear local credentials and address JWT: ${JSON.stringify(forgetSnapshot)}`);
  assert(!forgetSnapshot.sessionAdmin && !forgetSnapshot.sessionSite && !forgetSnapshot.sessionAccessToken && !forgetSnapshot.sessionAddressJwt && !forgetSnapshot.sessionRememberedAt, `forget browser should clear session credentials and address JWT: ${JSON.stringify(forgetSnapshot)}`);
  assert(forgetSnapshot.privateLocalKeys.length === 0 && forgetSnapshot.privateSessionKeys.length === 0, `forget browser should clear private admin caches: ${JSON.stringify(forgetSnapshot)}`);
  assert(forgetSnapshot.localApiBase === appApiBase, `forget browser should keep API base: ${JSON.stringify(forgetSnapshot)}`);
  assert(forgetSnapshot.localLocale === 'en-US' && forgetSnapshot.localNewAddressDraft.includes('keep.') && forgetSnapshot.localFrontendLoginBase === 'https://webmail.example.test', `forget browser should keep UX settings: ${JSON.stringify(forgetSnapshot)}`);
  assert(forgetSnapshot.localMailAutoRefreshEnabled === 'false' && forgetSnapshot.localMailAutoRefreshSeconds === '45' && !forgetSnapshot.localMailReadIds && !forgetSnapshot.localMailStarredIds, `forget browser should keep mail refresh preferences but clear account mail state: ${JSON.stringify(forgetSnapshot)}`);
  assert(forgetSnapshot.modalOpen, `credential modal should reopen after forget: ${JSON.stringify(forgetSnapshot)}`);
  assert(forgetSnapshot.adminPasswordInputs.every((value) => !value) && !forgetSnapshot.accessTokenValue, `credential inputs should not keep old secrets after forget: ${JSON.stringify(forgetSnapshot)}`);
  assert(!/已连接|Connected/.test(forgetSnapshot.bodySample), `UI should not show connected state after forget: ${forgetSnapshot.bodySample}`);
  authSecurity.close();

  const rememberedAuthSecurity = await openApp({
    width: 390,
    height: 844,
    seedAuth: true,
    legacyAuthCookie: encodeCookieMirror({
      apiBase: appApiBase,
      adminPassword: 'legacy-local-admin-secret',
      sitePassword: 'legacy-local-site-secret',
      userAccessToken: 'legacy-local-access-token',
      rememberedAt: Date.now(),
    }),
  });
  const rememberedCookieSnapshot = await readAuthStorageSnapshot(rememberedAuthSecurity);
  extraResults.push({ name: 'admin-auth-legacy-cookie-scrubbed-with-local-storage', ...rememberedCookieSnapshot });
  assert(!rememberedCookieSnapshot.modalOpen, `remembered local credentials should keep auth modal closed: ${JSON.stringify(rememberedCookieSnapshot)}`);
  assert(rememberedCookieSnapshot.localAdmin === (process.env.SMOKE_ADMIN_PASSWORD || 'smoke-cache'), `seeded local credentials should remain available: ${JSON.stringify(rememberedCookieSnapshot)}`);
  assert(rememberedCookieSnapshot.parsedCookie?.apiBase === appApiBase, `remembered legacy cookie should keep apiBase: ${JSON.stringify(rememberedCookieSnapshot)}`);
  assert(!rememberedCookieSnapshot.parsedCookie?.adminPassword && !rememberedCookieSnapshot.parsedCookie?.sitePassword && !rememberedCookieSnapshot.parsedCookie?.userAccessToken, `remembered legacy auth cookie should be scrubbed despite local storage: ${JSON.stringify(rememberedCookieSnapshot)}`);
  assert(!rememberedCookieSnapshot.decodedCookie.includes('legacy-local-admin-secret') && !rememberedCookieSnapshot.decodedCookie.includes('legacy-local-site-secret') && !rememberedCookieSnapshot.decodedCookie.includes('legacy-local-access-token'), `remembered legacy secrets should not remain in cookie: ${rememberedCookieSnapshot.decodedCookie}`);
  rememberedAuthSecurity.close();

  const recentAuthSecurity = await openApp({
    width: 390,
    height: 844,
    seedAuth: true,
    authRememberedAt: Date.now() - 6 * 24 * 60 * 60 * 1000,
    extraStorageScript: `
      localStorage.setItem('loven7.sitePassword', 'recent-site-secret');
      localStorage.setItem('loven7.userAccessToken', 'recent-access-token');
      localStorage.setItem('loven7.addressJwt', 'recent.jwt.token');
      sessionStorage.setItem('loven7.adminPassword', ${JSON.stringify(process.env.SMOKE_ADMIN_PASSWORD || 'smoke-cache')});
      sessionStorage.setItem('loven7.authRememberedAt', String(Date.now() - 6 * 24 * 60 * 60 * 1000));
    `,
  });
  const recentAuthSnapshot = await readAuthStorageSnapshot(recentAuthSecurity);
  extraResults.push({ name: 'admin-auth-recent-remembered-kept', ...recentAuthSnapshot });
  assert(!recentAuthSnapshot.modalOpen, `recent remembered auth should keep modal closed: ${JSON.stringify(recentAuthSnapshot)}`);
  assert(recentAuthSnapshot.localAdmin === (process.env.SMOKE_ADMIN_PASSWORD || 'smoke-cache') && recentAuthSnapshot.localSite === 'recent-site-secret' && recentAuthSnapshot.localAccessToken === 'recent-access-token', `recent auth credentials should be kept: ${JSON.stringify(recentAuthSnapshot)}`);
  assert(recentAuthSnapshot.localAddressJwt === 'recent.jwt.token' && Number(recentAuthSnapshot.localRememberedAt) > 0, `recent address JWT and rememberedAt should be kept: ${JSON.stringify(recentAuthSnapshot)}`);
  assert(!recentAuthSnapshot.expiredNoticeVisible && !recentAuthSnapshot.localExpiredNotice, `recent auth should not show expired notice: ${JSON.stringify(recentAuthSnapshot)}`);
  recentAuthSecurity.close();

  const expiredAuthSecurity = await openApp({
    width: 390,
    height: 844,
    seedAuth: true,
    authRememberedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    legacyAuthCookie: encodeCookieMirror({
      apiBase: appApiBase,
      rememberedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    }),
    extraStorageScript: `
      localStorage.setItem('loven7.sitePassword', 'expired-site-secret');
      localStorage.setItem('loven7.userAccessToken', 'expired-access-token');
      localStorage.setItem('loven7.addressJwt', 'expired.jwt.token');
      localStorage.setItem('loven7.addressUserFilter', JSON.stringify({ userId: 102, userEmail: 'bob@example.test', requestId: 9 }));
      localStorage.setItem('loven7.shareAdminListCache', JSON.stringify({ results: [{ token: 'expired-private-share' }] }));
      localStorage.setItem('loven7.mailListCache.inbox:expired', JSON.stringify({ items: [{ subject: 'expired private cache' }] }));
      localStorage.setItem('loven7.locale', 'en-US');
      localStorage.setItem('loven7.newAddressDraft', JSON.stringify({ version: 1, customPrefix: 'keep-expired.' }));
      localStorage.setItem('loven7.frontendLoginBase', 'https://webmail.expired.example.test');
      localStorage.setItem('loven7.mailAutoRefreshEnabled', 'false');
      localStorage.setItem('loven7.mailAutoRefreshSeconds', '45');
      localStorage.setItem('loven7.mailReadIds', JSON.stringify(['inbox:expired']));
      localStorage.setItem('loven7.mailStarredIds', JSON.stringify(['inbox:expired']));
      sessionStorage.setItem('loven7.adminPassword', ${JSON.stringify(process.env.SMOKE_ADMIN_PASSWORD || 'smoke-cache')});
      sessionStorage.setItem('loven7.addressJwt', 'expired.session.jwt.token');
      sessionStorage.setItem('loven7.authRememberedAt', String(Date.now() - 8 * 24 * 60 * 60 * 1000));
      sessionStorage.setItem('loven7.mailDetailSession.inbox:expired', JSON.stringify({ raw: 'expired private detail' }));
    `,
  });
  const expiredAuthSnapshot = await readAuthStorageSnapshot(expiredAuthSecurity);
  extraResults.push({ name: 'admin-auth-expired-auto-cleared', ...expiredAuthSnapshot });
  assert(expiredAuthSnapshot.modalOpen, `expired auth should reopen credential modal: ${JSON.stringify(expiredAuthSnapshot)}`);
  assert(!expiredAuthSnapshot.rawCookie, `expired auth should delete auth cookie mirror: ${JSON.stringify(expiredAuthSnapshot)}`);
  assert(!expiredAuthSnapshot.localAdmin && !expiredAuthSnapshot.localSite && !expiredAuthSnapshot.localAccessToken && !expiredAuthSnapshot.localAddressJwt && !expiredAuthSnapshot.localRememberedAt, `expired auth should clear local credentials: ${JSON.stringify(expiredAuthSnapshot)}`);
  assert(!expiredAuthSnapshot.sessionAdmin && !expiredAuthSnapshot.sessionSite && !expiredAuthSnapshot.sessionAccessToken && !expiredAuthSnapshot.sessionAddressJwt && !expiredAuthSnapshot.sessionRememberedAt, `expired auth should clear session credentials: ${JSON.stringify(expiredAuthSnapshot)}`);
  assert(expiredAuthSnapshot.privateLocalKeys.length === 0 && expiredAuthSnapshot.privateSessionKeys.length === 0, `expired auth should clear private caches: ${JSON.stringify(expiredAuthSnapshot)}`);
  assert(expiredAuthSnapshot.localApiBase === appApiBase, `expired auth should keep API base: ${JSON.stringify(expiredAuthSnapshot)}`);
  assert(expiredAuthSnapshot.localLocale === 'en-US' && expiredAuthSnapshot.localNewAddressDraft.includes('keep-expired.') && expiredAuthSnapshot.localFrontendLoginBase === 'https://webmail.expired.example.test', `expired auth should keep UX settings: ${JSON.stringify(expiredAuthSnapshot)}`);
  assert(expiredAuthSnapshot.localMailAutoRefreshEnabled === 'false' && expiredAuthSnapshot.localMailAutoRefreshSeconds === '45' && !expiredAuthSnapshot.localMailReadIds && !expiredAuthSnapshot.localMailStarredIds, `expired auth should keep mail refresh preferences but clear account mail state: ${JSON.stringify(expiredAuthSnapshot)}`);
  assert(expiredAuthSnapshot.expiredNoticeVisible, `expired auth should show clear re-auth notice: ${JSON.stringify(expiredAuthSnapshot)}`);
  assert(expiredAuthSnapshot.adminPasswordInputs.every((value) => !value) && !expiredAuthSnapshot.accessTokenValue, `expired auth credential inputs should be empty: ${JSON.stringify(expiredAuthSnapshot)}`);
  assert(!/已连接|Connected/.test(expiredAuthSnapshot.bodySample), `expired auth UI should not show connected state: ${expiredAuthSnapshot.bodySample}`);
  expiredAuthSecurity.close();

  const mobile = await openApp({ width: 390, height: 844 });
  const mobileDashboard = await collect(mobile, 'mobile-dashboard');
  assert(!mobileDashboard.xOverflow, 'mobile dashboard has horizontal overflow');
  assert(mobileDashboard.credentialButton || mobileDashboard.bodySample.includes('凭据'), 'mobile credential button missing');

  await sleep(900);
  await touchSwipe(mobile, 354, 360, 42, 360);
  const mobileSwipeStats = await collect(mobile, 'mobile-swipe-stats');
  assert(mobileSwipeStats.mobileHeaderText.includes('统计'), `full-screen left swipe should switch from dashboard to stats: ${mobileSwipeStats.mobileHeaderText}`);
  await touchSwipe(mobile, 354, 360, 42, 360);
  const mobileSwipeAddress = await collect(mobile, 'mobile-swipe-address');
  assert(mobileSwipeAddress.mobileHeaderText.includes('地址管理'), `full-screen left swipe should follow mobile nav order to address: ${mobileSwipeAddress.mobileHeaderText}`);
  await touchSwipe(mobile, 354, 360, 42, 360);
  const mobileSwipeInbox = await collect(mobile, 'mobile-swipe-inbox');
  assert(mobileSwipeInbox.mobileHeaderText.includes('收件箱'), `full-screen left swipe should follow mobile nav order to inbox: ${mobileSwipeInbox.mobileHeaderText}`);
  await touchSwipe(mobile, 354, 360, 42, 360);
  const mobileSwipeSent = await collect(mobile, 'mobile-swipe-sent');
  assert(mobileSwipeSent.mobileHeaderText.includes('发件箱'), `full-screen left swipe should follow mobile nav order to sent: ${mobileSwipeSent.mobileHeaderText}`);
  await touchSwipe(mobile, 354, 360, 42, 360);
  const mobileSwipeWrapDashboard = await collect(mobile, 'mobile-swipe-wrap-dashboard');
  assert(mobileSwipeWrapDashboard.mobileHeaderText.includes('仪表盘'), `full-screen left swipe should wrap from sent to dashboard: ${mobileSwipeWrapDashboard.mobileHeaderText}`);
  await touchSwipe(mobile, 42, 360, 354, 360);
  const mobileSwipeReverseSent = await collect(mobile, 'mobile-swipe-reverse-sent');
  assert(mobileSwipeReverseSent.mobileHeaderText.includes('发件箱'), `full-screen right swipe should return to the previous nav slot: ${mobileSwipeReverseSent.mobileHeaderText}`);

  await clickText(mobile, '收件箱');
  const mobileInbox = await collect(mobile, 'mobile-inbox');
  assert(!mobileInbox.xOverflow, 'mobile inbox has horizontal overflow');
  if (mockServer) {
    assert(mobileInbox.mailItems >= 2, `mock inbox should render seeded mails: ${mobileInbox.mailItems}`);
    assert(mobileInbox.verifyCodes.some((item) => item.includes('123456')), `Japanese verification code should be extracted: ${mobileInbox.verifyCodes.join(',')}`);
    assert(mobileInbox.verifyCodes.includes('AB7281'), `alphanumeric verification code should be extracted exactly: ${mobileInbox.verifyCodes.join(',')}`);
    assert(!/Content-Transfer-Encoding|--smoke-boundary/i.test(mobileInbox.bodySample), `mail list preview should not show raw MIME source: ${mobileInbox.bodySample}`);
    await clickSelector(mobile, '.mail-list-item');
    const mobileMailDetail = await collect(mobile, 'mobile-mail-detail-open');
    extraResults.push(mobileMailDetail);
    assert(mobileMailDetail.mobileDetailDisplay === 'flex', `mobile mail detail should open as full-screen overlay: ${mobileMailDetail.mobileDetailDisplay}`);
    const mailFrameText = await waitForMailFrameText(mobile, (text) => text.includes('Your verification code is 123456'));
    extraResults.push({ name: 'mobile-mail-detail-frame-text', frameSample: mailFrameText.slice(0, 500) });
    assert(mailFrameText.includes('Your verification code is 123456'), `mail detail iframe should render decoded multipart body: ${mailFrameText || mobileMailDetail.bodySample}`);
    assert(!/Content-Transfer-Encoding|--smoke-boundary|Content-Type: multipart/i.test(mobileMailDetail.bodySample), `mail detail should not show raw MIME source: ${mobileMailDetail.bodySample}`);
    assert(!/Content-Transfer-Encoding|--smoke-boundary|Content-Type: multipart/i.test(mailFrameText), `mail detail iframe should not show raw MIME source: ${mailFrameText}`);
    const mailFrameRect = JSON.parse(await evaluate(mobile, `JSON.stringify((() => {
      const rect = document.querySelector('.mail-frame')?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
    })())`) || 'null');
    assert(mailFrameRect && mailFrameRect.width > 120 && mailFrameRect.height > 120, `mail iframe should have usable swipe area: ${JSON.stringify(mailFrameRect)}`);
    await cdpTouchSwipe(mobile, mailFrameRect.left + 36, Math.min(mailFrameRect.bottom - 36, mailFrameRect.top + mailFrameRect.height * 0.52), mailFrameRect.right - 36, Math.min(mailFrameRect.bottom - 36, mailFrameRect.top + mailFrameRect.height * 0.52));
    const mobileMailDetailClosed = await collect(mobile, 'mobile-mail-detail-closed');
    extraResults.push(mobileMailDetailClosed);
    assert(!mobileMailDetailClosed.mobileDetailDisplay, 'right swipe should close mobile mail detail');
    assert(mobileMailDetailClosed.mobileHeaderText.includes('收件箱'), `closing detail should stay in inbox, not switch page: ${mobileMailDetailClosed.url} / ${mobileMailDetailClosed.mobileHeaderText} / ${mobileMailDetailClosed.bodySample}`);
  }

  await clickText(mobile, '地址');
  const mobileAddress = await collect(mobile, 'mobile-address');
  assert(!mobileAddress.xOverflow, 'mobile address has horizontal overflow');
  assert(mobileAddress.senderToggle, 'sender access collapsed toggle missing');
  assert(!mobileAddress.senderPanelMounted, 'sender access panel should be collapsed by default');
  if (mockServer) {
    await evaluate(mobile, `(() => {
      const input = document.querySelector('.address-search-field input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter ? setter.call(input, 'bob.shop88') : (input.value = 'bob.shop88');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(1200);
    const addressSearchInfo = await collect(mobile, 'mobile-address-search-bob');
    extraResults.push(addressSearchInfo);
    assert(addressSearchInfo.bodySample.includes('bob.shop88@example.test'), `address search must still ask backend when local index cache is stale/incomplete: ${addressSearchInfo.bodySample}`);
    await evaluate(mobile, `document.querySelector('.address-search-clear')?.click()`);
    await sleep(900);
    await evaluate(mobile, `(() => {
      const direct = document.querySelector('.mobile-address-card [aria-label="查看收件箱"]');
      if (direct) { direct.click(); return; }
      document.querySelector('.mobile-address-card .mobile-address-more')?.click();
    })()`);
    await sleep(250);
    await evaluate(mobile, `(() => {
      const buttons = Array.from(document.querySelectorAll('.mobile-address-action-menu button'));
      const viewInbox = buttons.find((button) => /查看收件箱|View inbox/i.test(button.textContent || ''));
      viewInbox?.click();
    })()`);
    await sleep(1000);
    const directInboxBeforeClear = JSON.parse(await evaluate(mobile, `JSON.stringify({
      header: document.querySelector('.mobile-header')?.innerText || '',
      addressValue: document.querySelector('.address-filter-input')?.value || '',
      clearExists: !!document.querySelector('.address-filter-clear')
    })`));
    extraResults.push({ name: 'mobile-direct-inbox-before-clear', ...directInboxBeforeClear });
    assert(directInboxBeforeClear.header.includes('收件箱'), `address inbox shortcut should navigate to inbox: ${JSON.stringify(directInboxBeforeClear)}`);
    assert(directInboxBeforeClear.addressValue.includes('alice.demo01@example.test'), `address inbox shortcut should fill address filter: ${JSON.stringify(directInboxBeforeClear)}`);
    assert(directInboxBeforeClear.clearExists, 'address filter clear button should exist after shortcut');
    await evaluate(mobile, `(() => {
      const button = document.querySelector('.address-filter-clear');
      button?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true }));
    })()`);
    await sleep(500);
    const directInboxAfterClear = JSON.parse(await evaluate(mobile, `JSON.stringify({
      addressValue: document.querySelector('.address-filter-input')?.value || '',
      clearExists: !!document.querySelector('.address-filter-clear'),
      mailItems: document.querySelectorAll('.mail-list-item').length
    })`));
    extraResults.push({ name: 'mobile-direct-inbox-after-clear', ...directInboxAfterClear });
    assert(directInboxAfterClear.addressValue === '', `address filter clear should empty input immediately: ${JSON.stringify(directInboxAfterClear)}`);
    assert(!directInboxAfterClear.clearExists, `address filter clear button should disappear after clearing: ${JSON.stringify(directInboxAfterClear)}`);
    await clickText(mobile, '地址');
    await sleep(900);
    await evaluate(mobile, `(() => {
      [...document.querySelectorAll('.mobile-address-card .row-check')].forEach((input) => {
        if (!input.checked) input.click();
      });
    })()`);
    await sleep(300);
    await evaluate(mobile, `(() => {
      const input = document.querySelector('.address-bulk-search input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter ? setter.call(input, 'AB7281') : (input.value = 'AB7281');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(300);
    await clickSelector(mobile, '.address-bulk-actions button', '检测并重选');
    await sleep(1800);
    const bulkFilterInfo = JSON.parse(await evaluate(mobile, `JSON.stringify({
      checkedAddresses: [...document.querySelectorAll('.mobile-address-card')].filter((card) => card.querySelector('.row-check')?.checked).map((card) => card.innerText),
      bulkText: document.querySelector('.address-bulk-bar')?.innerText || ''
    })`));
    extraResults.push({ name: 'mobile-address-bulk-keyword-filter', ...bulkFilterInfo });
    assert(bulkFilterInfo.checkedAddresses.length === 1, `bulk mail keyword filter should reselect exactly one address: ${JSON.stringify(bulkFilterInfo)}`);
    assert(bulkFilterInfo.checkedAddresses[0].includes('alice.work22@example.test'), `bulk mail keyword filter should keep address containing AB7281 mail: ${JSON.stringify(bulkFilterInfo)}`);
    await evaluate(mobile, `(() => {
      [...document.querySelectorAll('.mobile-address-card .row-check')].forEach((input) => {
        if (input.checked) input.click();
      });
    })()`);
    await sleep(300);
    await clickText(mobile, '新建地址');
    await evaluate(mobile, `document.querySelector('.modal-card .popover-select-trigger')?.click()`);
    await sleep(250);
    const createAddressInfo = JSON.parse(await evaluate(mobile, `JSON.stringify({
      modal: !!document.querySelector('.modal-card'),
      domainOptions: [
        ...document.querySelectorAll('.modal-card select option'),
        ...document.querySelectorAll('.modal-card .popover-select-option')
      ].map((option) => option.textContent.trim()),
      namePlaceholder: [...document.querySelectorAll('.modal-card input')].map((input) => input.getAttribute('placeholder') || '').join('|')
    })`));
    extraResults.push({ name: 'mobile-address-create-open', ...createAddressInfo });
    assert(createAddressInfo.modal, 'create address modal should open');
    assert(createAddressInfo.domainOptions.some((item) => item.includes('随机域名')), `create address should include random domain option: ${createAddressInfo.domainOptions.join(' | ')}`);
    assert(createAddressInfo.domainOptions.some((item) => item.includes('example.test')), `create address should include API domains: ${createAddressInfo.domainOptions.join(' | ')}`);
    assert(createAddressInfo.namePlaceholder.includes('10–15'), `create address placeholder should describe generated local-part length: ${createAddressInfo.namePlaceholder}`);
    await evaluate(mobile, `(() => {
      const prefix = [...document.querySelectorAll('.modal-card input')].find((input) => (input.getAttribute('placeholder') || '').includes('bg.'));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter ? setter.call(prefix, 'bg.') : (prefix.value = 'bg.');
      prefix.dispatchEvent(new Event('input', { bubbles: true }));
      prefix.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(300);
    await clickText(mobile, '生成一个');
    const generatedLocal = await evaluate(mobile, `(() => {
      const input = [...document.querySelectorAll('.modal-card input')].find((node) => (node.getAttribute('placeholder') || '').includes('10–15'));
      return input?.value || '';
    })()`);
    extraResults.push({ name: 'mobile-address-generated-name', generatedLocal });
    assert(/^[a-z0-9._-]{10,15}$/.test(generatedLocal), `generated local-part should be 10-15 safe chars, got: ${generatedLocal}`);
    assert(/[a-z]/.test(generatedLocal) && /\d/.test(generatedLocal), `generated local-part should mix letters and digits: ${generatedLocal}`);
    await clickSelector(mobile, '.modal-card button', '创建');
    const createCredential = await collect(mobile, 'mobile-address-created-credential');
    extraResults.push(createCredential);
    assert(createCredential.bodySample.includes('地址凭据'), `successful address creation should show credential modal: ${createCredential.bodySample}`);
    assert(String(lastNewAddressPayload?.name || '').startsWith('bg.'), `create address payload should preserve custom prefix separator: ${JSON.stringify(lastNewAddressPayload)}`);
    assert(createCredential.bodySample.includes('bg.'), `created address should preserve prefix separator in result: ${createCredential.bodySample}`);
    await clickSelector(mobile, '.modal-card button');
    await clickText(mobile, '新建地址');
    const rememberedCreateInfo = JSON.parse(await evaluate(mobile, `JSON.stringify({
      modal: !!document.querySelector('.modal-card'),
      inputValues: [...document.querySelectorAll('.modal-card input')].map((input) => input.value),
      selectedDomain: document.querySelector('.modal-card select')?.value || document.querySelector('.modal-card .popover-select-label')?.textContent.trim() || '',
      preview: [...document.querySelectorAll('.modal-card div, .modal-card p')].map((el) => el.textContent.trim()).find((text) => text.includes('预览：')) || ''
    })`));
    extraResults.push({ name: 'mobile-address-create-remembered', ...rememberedCreateInfo });
    assert(rememberedCreateInfo.inputValues.some((value) => value === 'bg.'), `create dialog should remember custom prefix: ${JSON.stringify(rememberedCreateInfo)}`);
    assert(rememberedCreateInfo.selectedDomain.includes('example.test') || rememberedCreateInfo.preview.includes('@example.test'), `create dialog should remember selected domain: ${JSON.stringify(rememberedCreateInfo)}`);
    assert(rememberedCreateInfo.preview.includes('bg.'), `create preview should keep prefix separator after reopen: ${JSON.stringify(rememberedCreateInfo)}`);
    await clickSelector(mobile, '.modal-card button');
    await clickSelector(mobile, '.user-filter-trigger');
    const mobileAddressUsers = await collect(mobile, 'mobile-address-users-open');
    extraResults.push(mobileAddressUsers);
    assert(mobileAddressUsers.userOptions.some((item) => item.includes('alice@example.test') && item.includes('2 个地址')), `user filter should show concrete users and address counts: ${mobileAddressUsers.userOptions.join(' | ')}`);
    await clickSelector(mobile, '.user-filter-option', 'alice@example.test');
    const mobileAddressFiltered = await collect(mobile, 'mobile-address-user-filtered');
    extraResults.push(mobileAddressFiltered);
    assert(mobileAddressFiltered.bodySample.includes('alice.demo01@example.test'), 'user filter should show Alice address');
    assert(!mobileAddressFiltered.bodySample.includes('bob.shop88@example.test'), 'user filter should not show Bob address after selecting Alice');
  }
  mobile.close();

  const dark = await openApp({ width: 390, height: 844, dark: true });
  const mobileDark = await collect(dark, 'mobile-dark');
  assert(!mobileDark.xOverflow, 'mobile dark mode has horizontal overflow');
  dark.close();

  const landscape = await openApp({ width: 844, height: 390, mobile: true });
  await clickText(landscape, '收件箱');
  const mobileLandscapeInbox = await collect(landscape, 'mobile-landscape-inbox');
  assert(!mobileLandscapeInbox.xOverflow, 'mobile landscape inbox has horizontal overflow');
  assert(mobileLandscapeInbox.mailDetailDisplay === 'none', 'mobile landscape should stay single-pane without blank reading area');
  assert(
    mobileLandscapeInbox.mailListWidth >= mobileLandscapeInbox.viewport.width - 2,
    `mobile landscape mail list should fill available width: ${mobileLandscapeInbox.mailListWidth}/${mobileLandscapeInbox.viewport.width}`,
  );
  landscape.close();

  const compactDesktop = await openApp({ width: 1280, height: 720, mobile: false });
  const compactDesktopLayout = JSON.parse(await evaluate(compactDesktop, `JSON.stringify((() => {
    const visibleRect = (el) => {
      let rect = el.getBoundingClientRect();
      let box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const clips = /(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowX + style.overflowY);
        if (!clips) continue;
        rect = parent.getBoundingClientRect();
        box = {
          left: Math.max(box.left, rect.left),
          top: Math.max(box.top, rect.top),
          right: Math.min(box.right, rect.right),
          bottom: Math.min(box.bottom, rect.bottom),
        };
      }
      const w = Math.max(0, box.right - box.left);
      const h = Math.max(0, box.bottom - box.top);
      return { x: box.left, y: box.top, w, h };
    };
    const items = [...document.querySelectorAll('aside button, aside a')]
      .map((el) => {
        const r = visibleRect(el);
        return { text: (el.textContent || '').trim(), x: r.x, y: r.y, w: r.w, h: r.h, visible: r.w > 0 && r.h > 0 };
      })
      .filter((item) => item.visible);
    const overlaps = [];
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i];
        const b = items[j];
        const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        if (w > 4 && h > 4) overlaps.push({ a: a.text, b: b.text, w, h });
      }
    }
    return {
      name: 'desktop-compact-sidebar-layout',
      xOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
      overlaps,
      bodySample: document.body.innerText.slice(0, 900),
    };
  })())`));
  extraResults.push(compactDesktopLayout);
  assert(!compactDesktopLayout.xOverflow, 'compact desktop dashboard has horizontal overflow');
  assert(compactDesktopLayout.overlaps.length === 0, `compact desktop sidebar controls overlap: ${JSON.stringify(compactDesktopLayout.overlaps)}`);
  compactDesktop.close();

  const desktop = await openApp({ width: 1365, height: 900 });
  const desktopDashboard = await collect(desktop, 'desktop-dashboard');
  assert(!desktopDashboard.xOverflow, 'desktop dashboard has horizontal overflow');
  await clickText(desktop, '系统设置');
  await evaluate(desktop, `(() => {
    const card = [...document.querySelectorAll('.settings-card')].find((el) => el.innerText.includes('用户设置'));
    card?.querySelector('button')?.click();
  })()`);
  await sleep(1000);
  const desktopSettingsLabels = JSON.parse(await evaluate(desktop, `JSON.stringify({
    name: 'desktop-settings-localized-labels',
    modal: !!document.querySelector('.modal-card'),
    bodySample: document.body.innerText.slice(0, 1800)
  })`));
  extraResults.push(desktopSettingsLabels);
  assert(desktopSettingsLabels.modal, 'user settings editor modal should open');
  assert(desktopSettingsLabels.bodySample.includes('允许用户注册'), `user settings should show Chinese field label: ${desktopSettingsLabels.bodySample}`);
  assert(desktopSettingsLabels.bodySample.includes('原字段: enableUserRegister'), `user settings should keep original key as reference: ${desktopSettingsLabels.bodySample}`);
  assert(desktopSettingsLabels.bodySample.includes('JWT 有效期'), `user settings should localize JWT-related fields: ${desktopSettingsLabels.bodySample}`);
  await evaluate(desktop, `document.querySelector('.modal-card [aria-label="关闭"]')?.click()`);
  await sleep(500);
  await clickText(desktop, '维护');
  const maintenanceLayout = JSON.parse(await evaluate(desktop, `JSON.stringify((() => {
    const select = document.querySelector('.maintenance-cleanup-grid .form-select');
    const input = document.querySelector('.maintenance-cleanup-grid .form-input');
    const button = document.querySelector('.maintenance-cleanup-button');
    const rect = (el) => {
      const r = el?.getBoundingClientRect();
      return r ? { top: r.top, bottom: r.bottom, height: r.height } : null;
    };
    return {
      name: 'desktop-maintenance-cleanup-alignment',
      select: rect(select),
      input: rect(input),
      button: rect(button),
      xOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
      bodySample: document.body.innerText.slice(0, 1200),
    };
  })())`));
  extraResults.push(maintenanceLayout);
  assert(!maintenanceLayout.xOverflow, 'maintenance page has horizontal overflow');
  assert(maintenanceLayout.select && maintenanceLayout.input && maintenanceLayout.button, `cleanup controls should be rendered: ${JSON.stringify(maintenanceLayout)}`);
  assert(Math.abs(maintenanceLayout.select.top - maintenanceLayout.button.top) <= 2, `cleanup button should align with select/input top edge: ${JSON.stringify(maintenanceLayout)}`);
  assert(Math.abs(maintenanceLayout.input.bottom - maintenanceLayout.button.bottom) <= 2, `cleanup button should align with select/input bottom edge: ${JSON.stringify(maintenanceLayout)}`);
  desktop.close();

  const results = [mobileDashboard, mobileSwipeStats, mobileSwipeAddress, mobileSwipeInbox, mobileSwipeSent, mobileSwipeWrapDashboard, mobileSwipeReverseSent, mobileInbox, ...extraResults, mobileAddress, mobileDark, mobileLandscapeInbox, desktopDashboard];
  console.log(JSON.stringify({ ok: true, baseUrl, results, screenshots: shouldCapture ? shotDir : undefined }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  killProcessTree(chromeProcess);
  killProcessTree(previewProcess);
  if (mockServer) await new Promise((resolve) => mockServer.close(resolve)).catch(() => undefined);
  if (secondaryMockServer) await new Promise((resolve) => secondaryMockServer.close(resolve)).catch(() => undefined);
  await sleep(100);
  try { rmSync(tempProfile, { recursive: true, force: true }); } catch {}
  process.exit(process.exitCode || 0);
});
