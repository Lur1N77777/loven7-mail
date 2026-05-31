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
let messageId = 0;
let appApiBase = process.env.SMOKE_API_BASE || '';
let lastNewAddressPayload = null;

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

function startMockApi() {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.method === 'OPTIONS') return jsonResponse(response, 204, {});
      const url = new URL(request.url || '/', `http://127.0.0.1:${mockApiPort}`);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
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
    server.listen(mockApiPort, '127.0.0.1', () => resolve(server));
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

async function openApp({ width, height, dark = false, mobile }) {
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
  await cdpSend(ws, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: emulateMobile });
  await cdpSend(ws, 'Emulation.setTouchEmulationEnabled', { enabled: emulateMobile, maxTouchPoints: emulateMobile ? 5 : 0 }).catch(() => undefined);
  await cdpSend(ws, 'Page.addScriptToEvaluateOnNewDocument', {
    source: `
      localStorage.setItem('loven7.adminPassword',${JSON.stringify(process.env.SMOKE_ADMIN_PASSWORD || 'smoke-cache')});
      localStorage.setItem('loven7.apiBase',${JSON.stringify(appApiBase)});
      localStorage.setItem('loven7.uiTheme','${dark ? 'dark' : 'light'}');
      localStorage.setItem('loven7.addressListCache.index:id:descend',${JSON.stringify(JSON.stringify(staleAddressIndex))});
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
  if (parsedStorage.apiBase !== appApiBase || parsedStorage.theme !== (dark ? 'dark' : 'light')) {
    await evaluate(ws, `
      localStorage.setItem('loven7.adminPassword',${JSON.stringify(process.env.SMOKE_ADMIN_PASSWORD || 'smoke-cache')});
      localStorage.setItem('loven7.apiBase',${JSON.stringify(appApiBase)});
      localStorage.setItem('loven7.uiTheme','${dark ? 'dark' : 'light'}');
      localStorage.setItem('loven7.addressListCache.index:id:descend',${JSON.stringify(JSON.stringify(staleAddressIndex))});
    `);
    await cdpSend(ws, 'Page.navigate', { url: baseUrl });
  }
  await sleep(1800);
  return ws;
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
  }
  chromeProcess = spawnChrome();
  await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`);
  const extraResults = [];

  const mobile = await openApp({ width: 390, height: 844 });
  const mobileDashboard = await collect(mobile, 'mobile-dashboard');
  assert(!mobileDashboard.xOverflow, 'mobile dashboard has horizontal overflow');
  assert(mobileDashboard.credentialButton || mobileDashboard.bodySample.includes('凭据'), 'mobile credential button missing');

  await sleep(900);
  await touchSwipe(mobile, 354, 360, 42, 360);
  const mobileSwipeStats = await collect(mobile, 'mobile-swipe-stats');
  assert(mobileSwipeStats.mobileHeaderText.includes('统计'), `full-screen left swipe should switch from dashboard to stats: ${mobileSwipeStats.mobileHeaderText}`);
  await touchSwipe(mobile, 42, 360, 354, 360);
  const mobileSwipeDashboard = await collect(mobile, 'mobile-swipe-dashboard');
  assert(mobileSwipeDashboard.mobileHeaderText.includes('仪表盘'), `full-screen right swipe should switch back to dashboard: ${mobileSwipeDashboard.mobileHeaderText}`);

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

  const desktop = await openApp({ width: 1365, height: 900 });
  const desktopDashboard = await collect(desktop, 'desktop-dashboard');
  assert(!desktopDashboard.xOverflow, 'desktop dashboard has horizontal overflow');
  desktop.close();

  const results = [mobileDashboard, mobileSwipeStats, mobileSwipeDashboard, mobileInbox, ...extraResults, mobileAddress, mobileDark, mobileLandscapeInbox, desktopDashboard];
  console.log(JSON.stringify({ ok: true, baseUrl, results, screenshots: shouldCapture ? shotDir : undefined }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  killProcessTree(chromeProcess);
  killProcessTree(previewProcess);
  if (mockServer) await new Promise((resolve) => mockServer.close(resolve)).catch(() => undefined);
  await sleep(100);
  try { rmSync(tempProfile, { recursive: true, force: true }); } catch {}
  process.exit(process.exitCode || 0);
});
