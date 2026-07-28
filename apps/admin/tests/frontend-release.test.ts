import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { activateWaitingServiceWorker, isChunkLoadError } from '../src/lib/appRecovery.ts';
import { loadBoundedAddressIndex } from '../src/lib/addressIndex.ts';
import { noteAuthenticationSuccess, reportAuthenticationFailure, subscribeAuthenticationFailures } from '../src/lib/authFailure.ts';
import { createApiClient } from '../src/lib/api.ts';
import { buildCacheScope, scopedStorageKey } from '../src/lib/cacheScope.ts';
import { buildAddressLoginUrl } from '../src/lib/clipboard.ts';
import { UserApiError, addressMailEndpoint, changeAddressPassword, createUserShare, fetchUserProfile, isAuthenticationFailure, loginAccountUser, registerAccountUser } from '../src/lib/userAuth.ts';
import { readTrustedMailFrameMessage } from '../src/lib/mailFrameMessages.ts';
import { parseRawMailListItem } from '../src/lib/mailParser.ts';
import { adminMailStateEndpoint } from '../src/lib/mailStateEndpoint.ts';
import { proxyMailImageSrcset, proxyMailImageUrl } from '../src/lib/mailImageProxy.ts';
import { sanitizeMailHtmlWithoutDom } from '../src/lib/mailSanitizerFallback.ts';
import { preserveRowsBelowAuthoritativeHead } from '../src/lib/mailSync.ts';
import { createOutboundIdempotencyTracker } from '../src/lib/outboundIdempotency.ts';
import { selectExpiredShareTokens, shareLifecycleStatus } from '../src/lib/shareLifecycle.ts';
import { extractVerificationCodes } from '../../shared/verificationCode.ts';
import { getFallbackAvatarColor } from '../../shared/avatarColor.ts';

test('address management keeps floating controls visible and reports refresh progress', () => {
  const source = readFileSync(new URL('../src/views/AddressView.tsx', import.meta.url), 'utf8');
  const workspaceCss = readFileSync(new URL('../src/workspace-pages.css', import.meta.url), 'utf8');

  assert.match(source, /createPortal\(userFilterMenu, document\.body\)/, 'user filter menu must escape the clipped data-card surface');
  assert.match(source, /className="user-filter-menu user-filter-menu-portal"/, 'user filter portal needs its fixed-position surface class');
  assert.match(source, /aria-busy=\{loading\}/, 'refresh control must expose its active request state');
  assert.match(source, /className=\{cls\(loading && 'animate-spin'\)\}/, 'refresh icon must spin even when the current address list is empty');
  assert.doesNotMatch(source, /\(loading \|\| usersLoading\) && data\.length > 0 && 'animate-spin'/, 'refresh feedback must not depend on pre-existing rows');
  assert.match(source, /mobile-address-action-menu mobile-address-action-menu-portal/, 'mobile address actions must render through the viewport-level portal');
  assert.match(source, /className="mobile-address-secondary"/, 'mobile address metadata and counts should share one compact secondary row');
  assert.match(workspaceCss, /\.mobile-address-action-menu\.mobile-address-action-menu-portal\s*\{[^}]*position:\s*fixed\s*!important;[^}]*max-height:/s, 'mobile actions must stay inside short viewports');
  assert.match(workspaceCss, /\.user-filter-trigger\.has-filter\s*\{[^}]*padding-right:\s*40px\s*!important;/s, 'selected user text must reserve space for its clear action');
  assert.match(workspaceCss, /body \.address-workspace \.address-workspace-surface\s*\{[^}]*border-radius:\s*var\(--workspace-radius\)\s*!important;/s, 'the address data surface must use the same restrained workspace radius as user management');
  assert.match(workspaceCss, /@media \(max-width: 767px\)[\s\S]*body \.address-workspace \.address-toolbar :where\(\.toolbar-field, \.user-filter-trigger, \.toolbar-action\),[\s\S]*min-height:\s*38px\s*!important;[\s\S]*height:\s*38px\s*!important;[\s\S]*border-radius:\s*var\(--workspace-radius\)\s*!important;/s, 'mobile address fields and actions must share the user toolbar control geometry');
  assert.match(workspaceCss, /@media \(max-width: 767px\)\s*\{\s*body \.address-view-shell \.address-toolbar \.popover-select\.address-sort-select \.popover-select-trigger\s*\{[^}]*min-height:\s*38px\s*!important;[^}]*height:\s*38px\s*!important;/s, 'the final mobile sort override must not shrink below sibling inputs');
  assert.match(workspaceCss, /body \.address-view-shell\.address-workspace > \.product-page\s*\{[^}]*width:\s*100%;[^}]*padding:\s*16px 20px/s, 'mobile address content should use the normal page flow with restrained side padding');
  assert.match(workspaceCss, /body \.address-workspace \.address-page-actions > button\s*\{[^}]*flex:\s*1 1 0;[^}]*justify-content:\s*center;[^}]*text-align:\s*center;/s, 'mobile address actions should fill the row while centering their own labels');
  assert.match(workspaceCss, /body \.address-workspace \.mobile-address-card\s*\{[^}]*border-radius:\s*0\s*!important;[^}]*background:\s*transparent\s*!important;[^}]*box-shadow:\s*none\s*!important;/s, 'mobile address rows should remain flat instead of becoming tinted cards');
  assert.match(source, /className="address-mobile-list md:hidden"/, 'the mobile card list must stay behind the responsive gate');
  assert.doesNotMatch(workspaceCss, /\.address-mobile-list\s*\{[^}]*display:/s, 'an unscoped display on the mobile list outranks md:hidden by load order and duplicates the desktop table');
});

test('mobile navigation uses one immediate active surface and statistics keeps refresh compact', () => {
  const shellSource = readFileSync(new URL('../src/components/Shell.tsx', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const statsSource = readFileSync(new URL('../src/views/DashboardView.tsx', import.meta.url), 'utf8');
  const productCss = readFileSync(new URL('../src/product-pages.css', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');

  assert.doesNotMatch(shellSource, /mobile-nav-progress-pill/, 'a second animated navigation pill would recreate the trailing ghost');
  assert.match(statsSource, /className="stats-mobile-refresh"/, 'mobile statistics should retain refresh as a compact icon action');
  assert.match(productCss, /\.admin-stats-view-shell \.stats-desktop-refresh\s*\{[^}]*display:\s*none;/s, 'the full-width statistics refresh action must be hidden on phones');
  assert.match(productCss, /\.admin-stats-view-shell \.stats-page-head \.page-head-copy\s*\{[^}]*align-self:\s*stretch;/s, 'the statistics title row must span the full page width so the refresh icon docks at the right edge');
  assert.match(productCss, /body \.admin-stats-view-shell \.stats-mobile-refresh\s*\{[^}]*margin-right:\s*-7px;/s, 'the refresh glyph should optically align with the right text edge instead of floating mid-page');
  assert.match(productCss, /\.admin-dashboard-view-shell \.dashboard-page-actions\s*\{[^}]*flex-wrap:\s*nowrap;/s, 'dashboard actions must remain on one compact mobile row');
  assert.doesNotMatch(appSource, /--mobile-(?:page-drag-x|nav-live-progress)/, 'page swipes must not invalidate global styles on every animation frame');
  assert.doesNotMatch(appSource, /pageAnimationSecondFrameRef/, 'page settling should not add a second animation-frame delay');
  assert.match(themeCss, /body \.mobile-mail-shell \.mail-list-item\s*\{[^}]*transform:\s*none\s*!important;[^}]*will-change:\s*auto\s*!important;/s, 'mail rows must not each reserve a compositor layer');
});

test('memoized admin views react to locale changes and theme labels keep their descenders', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const dashboardSource = readFileSync(new URL('../src/views/DashboardView.tsx', import.meta.url), 'utf8');
  const addressSource = readFileSync(new URL('../src/views/AddressView.tsx', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');

  assert.match(appSource, /<MemoDashboardView[^>]*locale=\{locale\}/, 'dashboard memo props must include the active locale');
  assert.match(appSource, /<MemoStatsView[^>]*locale=\{locale\}/, 'statistics memo props must include the active locale');
  assert.match(appSource, /<MemoAddressView[^>]*locale=\{locale\}/, 'address memo props must include the active locale');
  assert.match(dashboardSource, /DashboardView\([^)]*locale[^)]*\)[\s\S]*localeText\(zh, en, locale\)/, 'dashboard copy must derive from its reactive locale prop');
  assert.match(dashboardSource, /StatsView\([^)]*locale[^)]*\)[\s\S]*localeText\(zh, en, locale\)/, 'statistics copy must derive from its reactive locale prop');
  assert.match(addressSource, /useLocaleCopy\(displayLocale\)/, 'address copy must derive from its reactive locale prop');
  assert.match(themeCss, /body \.sidebar-reference-shell \.theme-segmented-option span\s*\{[^}]*padding-block:\s*1px;[^}]*line-height:\s*1\.25;/s, 'English theme labels need vertical room for descenders such as the g in Light');
});

test('mobile chrome drops per-frame backdrop blur and clips offscreen mail work', () => {
  const indexCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
  const workspaceCss = readFileSync(new URL('../src/workspace-pages.css', import.meta.url), 'utf8');

  assert.doesNotMatch(indexCss, /\.mobile-nav[^{]*\{[^}]*backdrop-filter:\s*blur/s, 'the fixed bottom navigation must not re-blur the swiping deck on every frame');
  assert.doesNotMatch(indexCss, /\.pagination-floating[^{]*\{[^}]*backdrop-filter:\s*blur/s, 'the floating pagination pill must not re-blur the scrolling table beneath it');
  assert.doesNotMatch(indexCss, /\.mobile-detail-topbar[^{]*\{[^}]*backdrop-filter:\s*blur/s, 'the mobile mail detail topbar must not re-blur the scrolling message');
  assert.doesNotMatch(indexCss, /\.address-bulk-(?:bar|menu-surface)[^{]*\{[^}]*backdrop-filter:\s*blur/s, 'floating bulk controls must not re-blur the scrolling address list');
  assert.doesNotMatch(indexCss, /\.mobile-bulk-fab[^{]*\{[^}]*backdrop-filter:\s*blur/s, 'the bulk fab must not re-blur the scrolling address list');
  assert.doesNotMatch(indexCss, /\.mobile-(?:more-menu|address-action-menu|detail-action-menu)[^{]*\{[^}]*backdrop-filter:\s*blur/s, 'mobile popover menus must stay blur-free over near-opaque surfaces');
  assert.doesNotMatch(workspaceCss, /mobile-address-action-menu-portal[^{]*\{[^}]*backdrop-filter/s, 'the viewport-level address action portal must rely on its opaque panel instead of blur');
  assert.match(themeCss, /body \.mobile-nav\s*\{[^}]*color-mix\(in srgb, var\(--admin-panel\) 96%, transparent\)/s, 'the bottom navigation compensates removed blur with a near-opaque panel');
  assert.match(indexCss, /\.mobile-swipe-page\s*\{[^}]*contain:\s*layout paint;/s, 'swipe deck pages must isolate layout and paint so background refreshes stay off the gesture path');
  assert.match(indexCss, /@supports \(content-visibility: auto\)\s*\{\s*@media \(max-width: 900px\)\s*\{\s*\.mail-list-item\s*\{[^}]*content-visibility:\s*auto;[^}]*contain-intrinsic-size:/s, 'offscreen mobile mail rows must skip layout and paint');
});

test('mobile pages clear the floating dock and mail chrome renders calm details', () => {
  const themeCss = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
  const indexCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const productCss = readFileSync(new URL('../src/product-pages.css', import.meta.url), 'utf8');
  const workspaceCss = readFileSync(new URL('../src/workspace-pages.css', import.meta.url), 'utf8');
  const parserSource = readFileSync(new URL('../src/lib/mailParser.ts', import.meta.url), 'utf8');

  assert.match(themeCss, /--admin-dock-clearance:\s*calc\(74px \+ max\(8px, env\(safe-area-inset-bottom\)\)\);/, 'the dock clearance token must cover nav height, breathing room and the safe area');
  assert.match(indexCss, /body \.settings-view-shell,\s*body \.maintenance-view-shell\s*\{[^}]*calc\(82px \+ env\(safe-area-inset-bottom\)\)\s*!important;/s, 'view shells own the dock clearance so pages must not add their own');
  assert.doesNotMatch(productCss, /\.product-page\s*\{[^}]*padding-bottom:\s*var\(--admin-dock-clearance\)/s, 'page-level clearance would stack on the shell clearance and leave dead space');
  assert.match(workspaceCss, /body \.address-view-shell\.address-workspace > \.product-page\s*\{[^}]*var\(--admin-dock-clearance\)/s, 'the address page must reuse the shared dock clearance token');
  assert.match(parserSource, /img\[data-blocked-src\], img\[data-blocked-srcset\]:not\(\[src\]\)\s*\{\s*display:\s*inline-block;/, 'blocked remote images (src or srcset-only) must render as a styled placeholder instead of a broken glyph');
  assert.match(workspaceCss, /body \.address-workspace \.user-filter-copy\s*\{[^}]*text-align:\s*left\s*!important;/s, 'the user filter text must escape the button default centering and left-align like its sibling fields');
  assert.match(productCss, /\.frontend-base-controls > \.btn-primary\s*\{[^}]*align-self:\s*flex-end;/s, 'the settings save action should sit compact at the row end instead of stretching full width');
});

test('desktop mail reader expands through one balanced inset and nested radius scale', () => {
  const indexCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const finalReaderPass = indexCss.slice(indexCss.indexOf('FINAL V79 desktop mail reader expansion'));

  assert.match(finalReaderPass, /--mail-reader-gutter:\s*clamp\(26px, 2\.2vw, 30px\);/, 'the reader should keep one restrained responsive gutter instead of unrelated edge values');
  assert.match(finalReaderPass, /--mail-detail-card-inline:\s*42px;/, 'the header should retain its calm alignment while the message canvas expands independently');
  assert.match(finalReaderPass, /--mail-reader-outer-radius:\s*16px;/, 'the desktop detail surface should keep its established card radius');
  assert.match(finalReaderPass, /--mail-reader-radius:\s*12px;/, 'the inner reader radius should visibly step down from the outer card radius');
  assert.match(finalReaderPass, /\.mail-detail-topbar\s*\{[^}]*margin-bottom:\s*24px\s*!important;/s, 'the topbar rhythm should release a little more vertical room to the message canvas');
  assert.match(finalReaderPass, /\.mail-detail-sender-row\s*\{[^}]*margin-top:\s*24px\s*!important;/s, 'the sender rhythm should release a little more vertical room without crowding the header');
  assert.match(finalReaderPass, /\.mail-detail-card\s*\{[^}]*padding:\s*20px var\(--mail-detail-card-inline\) var\(--mail-reader-gutter\)\s*!important;[^}]*border-radius:\s*var\(--mail-reader-outer-radius\)\s*!important;/s, 'the outer card should reserve the same bottom clearance used by the reader canvas');
  assert.match(finalReaderPass, /\.mail-detail-code-strip\s*\{[^}]*margin-bottom:\s*0\s*!important;/s, 'verification actions must not add a second gap above the reader');
  assert.match(finalReaderPass, /body \.mail-workspace \.mail-detail-body\s*\{[^}]*margin-top:\s*var\(--mail-reader-gutter\)\s*!important;[^}]*margin-inline:\s*calc\(var\(--mail-reader-gutter\) - var\(--mail-detail-card-inline\)\)\s*!important;[^}]*border-radius:\s*var\(--mail-reader-radius\)\s*!important;[^}]*overflow:\s*hidden\s*!important;/s, 'the reader top, left, right and bottom clearances must resolve to one shared gutter');
  assert.match(finalReaderPass, /body \.mail-workspace \.mail-frame,\s*body \.mail-workspace \.mail-text\s*\{[^}]*border-radius:\s*var\(--mail-reader-radius\)\s*!important;/s, 'HTML and plain-text mail should use identical reader corners');
});

test('the user filter trigger reads as one row inside its fixed-height control', () => {
  const themeCss = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/views/AddressView.tsx', import.meta.url), 'utf8');

  // A stacked label+count needed ~32px of line boxes in the 38px control's
  // ~26px content box, so overflow:hidden sliced the count in half.
  assert.match(themeCss, /\.user-filter-copy\s*\{[^}]*flex-direction:\s*row\s*!important;/s, 'label and count must share one line');
  assert.match(themeCss, /\.user-filter-copy\s*\{[^}]*justify-content:\s*flex-start\s*!important;/s, 'on a row the old vertical-centering justify-content would centre the copy horizontally, away from the icon');
  assert.match(themeCss, /\.user-filter-count\s*\{[^}]*flex:\s*0 0 auto;/s, 'the count must never shrink; the name truncates instead');
  assert.match(themeCss, /@media \(max-width: 767px\)\s*\{\s*body \.address-view-shell \.address-toolbar \.user-filter-count\s*\{\s*display:\s*block\s*!important;/s, 'phones dropped the count only because it was a second line; one row fits both breakpoints');
  assert.match(source, /\{\(effectiveUserFilter \|\| usersLoading \|\| displayedUserTotal > 0\) && <span className="user-filter-count">/, 'the count must not render when it would repeat the label verbatim');
});

test('the share manager modal styles its own portaled scope', () => {
  const source = readFileSync(new URL('../src/views/AddressView.tsx', import.meta.url), 'utf8');
  const workspaceCss = readFileSync(new URL('../src/workspace-pages.css', import.meta.url), 'utf8');
  assert.match(source, /cardClassName="share-manager-modal"/, 'the modal needs a scope class because it portals outside every workspace stylesheet scope');
  assert.match(source, /className="share-list-error" role="alert"/, 'list failures must surface inline with a retry action, not only a transient toast');
  assert.match(workspaceCss, /\.share-manager-modal \.share-search-field\s*\{[^}]*height:\s*40px;[^}]*border:\s*1px solid var\(--admin-border\);/s, 'the search field must carry real control styling inside the portal');
  assert.match(workspaceCss, /\.share-manager-modal \.share-mobile-card\s*\{[^}]*content-visibility:\s*auto;/s, 'long share lists must skip offscreen card rendering');
  assert.match(workspaceCss, /\.share-manager-modal \.share-mobile-actions\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/s, 'mobile share actions should sit in one compact row instead of a 2x2 block');
  assert.match(workspaceCss, /@media \(max-width: 767px\)\s*\{\s*\.share-manager-modal \.share-mobile-list\s*\{\s*display:\s*grid;/s, 'the mobile share list display must live inside the phone media query');
  assert.doesNotMatch(workspaceCss, /\n\.share-manager-modal \.share-mobile-list\s*\{[^}]*display:/s, 'an unscoped display on the mobile share list would outrank md:hidden and duplicate the desktop table');
  assert.match(workspaceCss, /\.share-manager-modal \.share-admin-table th\s*\{[^}]*background:\s*var\(--admin-panel-soft\);/s, 'the desktop share table must speak the same token language as the mobile cards');
});

test('read state re-merges when a device resumes so cross-device marks arrive without a reload', () => {
  const workspaceSource = readFileSync(new URL('../src/views/MailWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(workspaceSource, /document\.addEventListener\('visibilitychange', onVisibility\)/, 'returning to the foreground must trigger a remote read-state re-merge');
  assert.match(workspaceSource, /\[mailStateKeys, mode, request, stateSyncTick\]/, 'the remote merge effect must re-run on the resync tick, not only on mount');
  assert.match(workspaceSource, /if \(Date\.now\(\) - lastStateSyncAtRef\.current < 15_000\) return;/, 'resync must be throttled so visibility flaps cannot spam the endpoint');
});

test('sender display names drop MIME quoting artifacts', () => {
  const plain = parseRawMailListItem({ id: 1, raw: 'From: "Nihon App" <no-reply@nihon.example>\r\nSubject: Code\r\n\r\nBody' } as never);
  assert.equal(plain.senderName, 'Nihon App');
  const escaped = parseRawMailListItem({ id: 2, raw: 'From: "Quote \\"Inner\\"" <q@example.test>\r\nSubject: Hi\r\n\r\nBody' } as never);
  assert.equal(escaped.senderName, 'Quote "Inner"');
  const bare = parseRawMailListItem({ id: 3, raw: 'From: plain@example.test\r\nSubject: Hi\r\n\r\nBody' } as never);
  assert.equal(bare.senderName, 'plain');
  const unbalanced = parseRawMailListItem({ id: 4, raw: 'From: "Unbalanced <a@b.test>\r\nSubject: Hi\r\n\r\nBody' } as never);
  assert.equal(unbalanced.senderName, 'Unbalanced');
  const backslash = parseRawMailListItem({ id: 5, raw: 'From: Back\\slash <c@x.test>\r\nSubject: Hi\r\n\r\nBody' } as never);
  assert.equal(backslash.senderName, 'Back\\slash');
});

test('admin mail sanitizer fails closed when DOMParser is unavailable', () => {
  const sanitized = sanitizeMailHtmlWithoutDom(
    '<p>Hello</p><a href="javascript:alert(1)">Open</a><img src=x onerror=alert(1)><script>alert(1)</script>',
  );
  assert.match(sanitized, /Hello/);
  assert.doesNotMatch(sanitized, /<(?:a|img|script)\b|javascript:|onerror/i);
});

test('admin routes remote mail images through its same-origin proxy', () => {
  assert.equal(
    proxyMailImageUrl('https://assets.example.com/notion-logo.png', 'https://admin.example.test'),
    'https://admin.example.test/api/image?url=https%3A%2F%2Fassets.example.com%2Fnotion-logo.png',
  );
  assert.equal(proxyMailImageUrl('data:image/png;base64,AA==', 'https://admin.example.test'), 'data:image/png;base64,AA==');
  assert.equal(proxyMailImageUrl('javascript:alert(1)', 'https://admin.example.test'), '');
  assert.equal(
    proxyMailImageSrcset(
      'data:image/png;base64,AA== 1x, https://assets.example.com/notion-logo.png 2x',
      'https://admin.example.test',
    ),
    'data:image/png;base64,AA== 1x, https://admin.example.test/api/image?url=https%3A%2F%2Fassets.example.com%2Fnotion-logo.png 2x',
  );
});

test('verification extraction keeps the exact Notion code and removes a spaced numeric suffix', () => {
  assert.deepEqual(
    extractVerificationCodes('Your Notion signup code\n683744 96 Sign up for Notion\nYour code is 683744'),
    ['683744'],
  );
  assert.deepEqual(
    extractVerificationCodes('Your Notion signup code\n192322 96 Sign up for Notion\nYou can sign up by entering the code on the sign up page in Notion.\n192322'),
    ['192322'],
  );
});

test('verification extraction ignores Codex footer address and postal numbers', () => {
  assert.deepEqual(
    extractVerificationCodes('用 Codex 高效完成工作\nOpenAI\n1455 3rd Street\nSan Francisco, CA 94158'),
    [],
  );
});

test('verification extraction ignores HTML entity numbers and product version names', () => {
  assert.deepEqual(
    extractVerificationCodes('OpenAI Dev News: OpenAI Built Codex\nThat idea has a deadline. &#8199; &#8205; GPT-5.6-Terra'),
    [],
  );
});

test('verification extraction keeps real codes while rejecting unrelated footer metadata', () => {
  assert.deepEqual(
    extractVerificationCodes('Your verification code is 472913.\nOpenAI\n1455 3rd Street\nSan Francisco, CA 94158\nGPT-5.6-Terra\n&#8199;'),
    ['472913'],
  );
});

test('verification extraction supports formatted numeric and alphanumeric codes', () => {
  assert.deepEqual(extractVerificationCodes('验证码：123 456\nYour security code is AB-7281'), ['123456', 'AB7281']);
});

test('verification extraction keeps pure alphabetic Notion codes', () => {
  const notionHtml = [
    '<div class="notion-email"><h1>登录 Notion</h1>',
    '<pre style="text-align:center;font-size:22px">rxthEC</pre>',
    '<a href="https://notion.example.test/loginwithemail?password=rxthEC&isSignup=false">使用魔法链接登录</a>',
    '<p>Never share this code with anyone.</p></div>',
  ].join('');
  assert.deepEqual(extractVerificationCodes('登录 Notion', [notionHtml]), ['rxthEC']);
  assert.deepEqual(
    extractVerificationCodes('登录 Notion\nrxthEC\nNever share this code with anyone. If you didn’t request this code, you can ignore this email.'),
    ['rxthEC'],
  );
});

test('verification extraction rejects brand words and keeps the real ChatGPT OTP', () => {
  assert.deepEqual(
    extractVerificationCodes('ChatGPT verification email\nYour code is 482913\nChatGPT\nantarctic clicking'),
    ['482913'],
  );
  assert.deepEqual(extractVerificationCodes('Your ChatGPT code is 123456'), ['123456']);
  assert.deepEqual(extractVerificationCodes('antarctic clicking something code'), []);
});

test('verification extraction matches the real ChatGPT and login-alert mailbox samples', () => {
  assert.deepEqual(
    extractVerificationCodes('你的临时 ChatGPT 登录代码\n输入此临时验证码以继续： 956125\n未请求验证码？你可以忽略此邮件。'),
    ['956125'],
  );
  assert.deepEqual(
    extractVerificationCodes('你的帐号已在新设备上登录\n审核新设备的最近登录信息\nIP 和大致位置 103.151.172.32\n时间 2026/07/24 GMT 12:59:59'),
    [],
  );
});

test('verification extraction crosses harmless HTML whitespace before a real ChatGPT OTP', () => {
  const chatGptHtml = `
    <html>
      <head><style>.code { font-family: monospace; }</style></head>
      <body>
        <p>输入此临时验证码以继续：</p>


        <p class="code">
          <!--[if mso]><span><![endif]-->
          956125
          <!--[if mso]></span><![endif]-->
        </p>
        <p>未请求验证码？你可以忽略此邮件。</p>
      </body>
    </html>
  `;
  assert.deepEqual(extractVerificationCodes('你的临时 ChatGPT 登录代码', [chatGptHtml]), ['956125']);
});

test('verification extraction rejects the current production mailbox false-positive samples', () => {
  assert.deepEqual(
    extractVerificationCodes('在 Notion 上加入你的团队\n你的团队正在使用 Notion 进行协作。Loven77777 邀请你加入工作空间。96'),
    [],
  );
  assert.deepEqual(
    extractVerificationCodes('Finish signing up for Notion\nIt only takes 1 minute.\nComplete'),
    [],
  );
  assert.deepEqual(
    extractVerificationCodes('OpenAI Dev News: OpenAI Build Week, GPT-5.6, ChatGPT Work\nThat idea in your backlog has a deadline.\nAsterism projects coverage'),
    [],
  );
});

test('verification extraction never promotes tracking query parameters', () => {
  const trackingHtml = [
    '<p>Your verification code is 604181</p>',
    '<a href="https://example.test/unsubscribe?token=54382401&code=ABCD1234">Unsubscribe</a>',
  ].join('');
  assert.deepEqual(extractVerificationCodes('Your verification code is 604181', [trackingHtml]), ['604181']);
  assert.deepEqual(
    extractVerificationCodes('OpenAI developer newsletter', ['<a href="https://example.test/click?token=54382401&code=ABCD1234">Read more</a>']),
    [],
  );
  assert.deepEqual(
    extractVerificationCodes('OpenAI developer newsletter', ['<p>Example identifier</p><code>ABCD1234</code>']),
    [],
  );
});

test('verification extraction rejects product versions and state/postal pairs', () => {
  assert.deepEqual(extractVerificationCodes('Your code is GPT-6'), []);
  assert.deepEqual(extractVerificationCodes('Security notice\nCA 994158'), []);
});

test('verification extraction does not capture prose from the line after a code-like subject', () => {
  assert.deepEqual(extractVerificationCodes('Re: Your verification code\nReceived, thanks.'), []);
  assert.deepEqual(extractVerificationCodes('Re: Your verification code\nReceived 14553, thanks.'), []);
  assert.deepEqual(extractVerificationCodes('Your verification code is Received'), []);
});

test('admin locale changes stay outside account and mail request dependencies', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const workspaceSource = readFileSync(new URL('../src/views/MailWorkspace.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(appSource, /\[accountUserToken, apiBase, applyAccountLogin, locale, push, resetAuthenticationState\]/);
  assert.doesNotMatch(appSource, /\}, \[apiBase, locale, push\]\);/);
  assert.doesNotMatch(appSource, /\}, \[apiBase, cancelPendingPageAnimation, locale, push, settleMobilePageAt\]\);/);
  assert.match(appSource, /lang:\s*getBackendLang\(getRuntimeLocale\(\)\)/);
  assert.doesNotMatch(workspaceSource, /\[address, autoSeconds,[^\]]*, t\]\);/s);
});

test('admin uses white only for real brand icons and deterministic color for initials', () => {
  const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const theme = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
  const avatarColors = readFileSync(new URL('../../shared/avatarColor.ts', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const shellSource = readFileSync(new URL('../src/components/Shell.tsx', import.meta.url), 'utf8');
  const workspaceStyles = readFileSync(new URL('../src/workspace-pages.css', import.meta.url), 'utf8');
  assert.match(styles, /\.mobile-mail-detail \.brand-avatar img\s*\{[^}]*width:\s*85%\s*!important;[^}]*height:\s*85%\s*!important;[^}]*object-fit:\s*contain\s*!important;[^}]*clip-path:\s*none\s*!important;/s);
  assert.match(styles, /\.brand-avatar-with-icon\s*\{[^}]*background:\s*#fff\s*!important;/s);
  assert.match(styles, /\.brand-avatar-fallback\s*\{[^}]*background:\s*var\(--brand-avatar-fallback-bg\)\s*!important;[^}]*color:\s*#fff\s*!important;[^}]*font-size:\s*calc\(var\(--brand-avatar-size\) \* \.456\);[^}]*font-weight:\s*560/s);
  assert.match(theme, /\.mobile-mail-shell \.brand-avatar-fallback > span,[\s\S]*color:\s*#fff\s*!important;/, 'the rendered fallback letter must stay white on mobile');
  assert.match(avatarColors, /#D26F7C[\s\S]*#6F91C9[\s\S]*#58A38A[\s\S]*#8D7BC2/, 'fallback avatars should use the shared bright macaron palette');
  assert.doesNotMatch(avatarColors, /#64748B|#58778A|#7C7659/, 'old gray and olive avatar colors should not return');
  assert.match(appSource, /globalRefreshing/);
  assert.match(shellSource, /className=\{cls\('sidebar-mini-btn sidebar-tool-btn', refreshing && 'is-refreshing'\)\}/);
  assert.match(shellSource, /<RefreshCw size=\{15\} className=\{cls\(refreshing && 'animate-spin'\)\}/);
  assert.match(workspaceStyles, /\.user-filter-copy\s*\{[^}]*justify-content:\s*center\s*!important;[^}]*overflow:\s*hidden\s*!important;/s);
  assert.equal(getFallbackAvatarColor('letter@example.test'), getFallbackAvatarColor('letter@example.test'));
  assert.equal(getFallbackAvatarColor('letter@example.test', 'First label'), getFallbackAvatarColor('letter@example.test', 'Renamed label'));
  assert.notEqual(getFallbackAvatarColor('letter@example.test'), getFallbackAvatarColor('other@example.test'));
});

test('admin outbound attempts use RFC 4122 UUIDs by default', () => {
  const tracker = createOutboundIdempotencyTracker();
  assert.match(
    tracker.begin('/admin/send_mail', { subject: 'hello' }).key,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test('admin outbound retries reuse a key only for the same draft after network or 5xx errors', () => {
  let nextKey = 0;
  const tracker = createOutboundIdempotencyTracker(() => `admin-key-${++nextKey}`);
  const draft = { from_mail: 'sender@example.com', to_mail: 'to@example.com', subject: 'hello' };

  const first = tracker.begin('/admin/send_mail', draft);
  tracker.failed(first, { status: 0, message: 'network unavailable' });
  assert.equal(tracker.begin('/admin/send_mail', { ...draft }).key, first.key);

  tracker.failed(first, { status: 503, message: 'temporary outage' });
  assert.equal(tracker.begin('/admin/send_mail', { ...draft }).key, first.key);

  const edited = tracker.begin('/admin/send_mail', { ...draft, subject: 'edited' });
  assert.notEqual(edited.key, first.key);
});

test('admin outbound keys rotate after success or a definitive 4xx response', () => {
  let nextKey = 0;
  const tracker = createOutboundIdempotencyTracker(() => `admin-key-${++nextKey}`);
  const draft = { from_mail: 'sender@example.com', to_mail: 'to@example.com', subject: 'hello' };

  const delivered = tracker.begin('/admin/send_mail', draft);
  tracker.succeeded(delivered);
  assert.notEqual(tracker.begin('/admin/send_mail', draft).key, delivered.key);

  const rejected = tracker.begin('/admin/send_mail', { ...draft, subject: 'invalid' });
  tracker.failed(rejected, { status: 400, message: 'invalid input' });
  assert.notEqual(
    tracker.begin('/admin/send_mail', { ...draft, subject: 'invalid' }).key,
    rejected.key,
  );
});

test('admin compose sends the attempt UUID through Idempotency-Key and settles it', () => {
  const source = readFileSync(new URL('../src/views/ComposeView.tsx', import.meta.url), 'utf8');
  assert.equal(
    [...source.matchAll(/['"]Idempotency-Key['"]\s*:\s*attempt\.key/g)].length,
    2,
  );
  assert.equal([...source.matchAll(/outboundRequests\.succeeded\(attempt\)/g)].length, 2);
  assert.equal([...source.matchAll(/outboundRequests\.failed\(attempt,\s*error\)/g)].length, 2);
});

test('admin smoke exposes Chrome startup failures while waiting for IPv4 CDP', () => {
  const source = readFileSync(new URL('../scripts/smoke-local.mjs', import.meta.url), 'utf8');
  assert.match(source, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(source, /stdio:\s*\['ignore',\s*'pipe',\s*'pipe'\]/);
  assert.match(source, /watchedProcess\.exitCode !== null\s*\|\|\s*watchedProcess\.signalCode !== null/);
  assert.match(source, /waitForHttp\([^;]+60_000[^;]+chromeProcess[^;]+Chrome/s);
});

test('admin persistent cache keys are isolated by API and account', () => {
  const first = buildCacheScope('https://api-a.example', 'user:1');
  const otherApi = buildCacheScope('https://api-b.example', 'user:1');
  const otherAccount = buildCacheScope('https://api-a.example', 'user:2');
  assert.notEqual(first, otherApi);
  assert.notEqual(first, otherAccount);
  assert.match(scopedStorageKey('loven7.cache.', first, 'mail', 1), /^loven7\.cache\.v2\./);
});

test('one-click address links keep JWT out of the HTTP query', () => {
  const url = buildAddressLoginUrl('header.payload.signature', 'https://email.example');
  assert.equal(url, 'https://email.example/#JWT=header.payload.signature');
  assert.equal(new URL(url).search, '');
});

test('only authentication-specific 401 and 403 responses invalidate an account session', () => {
  assert.equal(isAuthenticationFailure(new UserApiError(401, 'expired')), true);
  assert.equal(isAuthenticationFailure(new UserApiError(403, 'forbidden')), true);
  assert.equal(isAuthenticationFailure({ status: 403, body: JSON.stringify({ error: { code: 'invalid_admin_password' } }) }), true);
  assert.equal(isAuthenticationFailure({ status: 403, body: JSON.stringify({ error: { code: 'not_admin' } }) }), true);
  assert.equal(isAuthenticationFailure({ status: 403, body: JSON.stringify({ error: { code: 'webhook_disabled' } }) }), false);
  assert.equal(isAuthenticationFailure({ status: 403, body: 'Webhook is disabled' }), false);
  assert.equal(isAuthenticationFailure(new UserApiError(500, 'temporary outage')), false);
  assert.equal(isAuthenticationFailure(new TypeError('Failed to fetch')), false);
});

test('account login does not retry plaintext after a backend failure', async () => {
  const originalFetch = globalThis.fetch;
  let loginRequests = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'https://api.example');
    if (url.pathname === '/user_api/login') {
      loginRequests += 1;
      return new Response(JSON.stringify({ message: 'temporary outage' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      loginAccountUser('https://api.example', 'user@example.com', 'password123'),
      (error: any) => error instanceof UserApiError && error.status === 500,
    );
    assert.equal(loginRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a live credential clears its strike so intermittent rejections never accumulate into a logout', () => {
  const seen: number[] = [];
  const unsubscribe = subscribeAuthenticationFailures((error) => seen.push(Number((error as { status?: unknown }).status)));
  try {
    noteAuthenticationSuccess();
    // A blip an hour ago must not team up with a blip today.
    assert.equal(reportAuthenticationFailure({ status: 401 }), false);
    noteAuthenticationSuccess();
    assert.equal(reportAuthenticationFailure({ status: 401 }), false);
    assert.deepEqual(seen, [], 'a success between two rejections proves the credential is alive');
    // Two rejections with no success between them is a real verdict.
    assert.equal(reportAuthenticationFailure({ status: 401 }), true);
    assert.deepEqual(seen, [401]);
  } finally {
    unsubscribe();
    noteAuthenticationSuccess();
  }
});

test('cached pages paint from cache instead of reloading on every visit', () => {
  const mailSource = readFileSync(new URL('../src/views/MailWorkspace.tsx', import.meta.url), 'utf8');
  const usersSource = readFileSync(new URL('../src/views/UsersView.tsx', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const indexCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

  // The cache hydration and the list fetch both used to sit behind the remote
  // read-state round trip, so a mailbox you had just read rendered empty until
  // a skipCache request with a 6.5s timeout came back.
  assert.doesNotMatch(mailSource, /if \(!remoteStateReady\) return;/, 'nothing may gate the cached first paint behind a network round trip');
  assert.match(mailSource, /\}, \[currentListCacheKey, mode\]\);/, 'cache hydration must run on mount, not when the remote state settles');
  assert.match(mailSource, /\}, \[mode, page, pageSize, address\]\);/, 'the list fetch must start immediately rather than queue behind the read state');
  assert.match(mailSource, /mails\.length === 0 && !cacheHydratedRef\.current && !firstLoadSettledRef\.current \? <LoadingState \/>/, '"no mail" is a claim about the mailbox and must not stand in for "not looked yet"');
  assert.doesNotMatch(usersSource, /Date\.now\(\) - cached\.savedAt > CACHE_TTL\.shortList\) return;/, 'discarding cached rows past 30s produced a blank spinner on every revisit');
  assert.match(appSource, /visitedMenus\.forEach\(\(menu\) => rendered\.add\(menu\)\);/, 'visited swipe pages must stay mounted so returning to one does not refetch');
  assert.match(indexCss, /\.mobile-swipe-page:not\(\.active\):not\(\.mobile-page-settling\)\s*\{[^}]*content-visibility:\s*auto;/s, 'keeping pages mounted must not cost paint while they sit offscreen');
});

test('a signed-in session survives closing the browser and only genuine idling expires it', () => {
  const storage = readFileSync(new URL('../src/lib/storage.ts', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(storage, /function clearPersistentAuthStorage/, 'wiping the durable copy on every write and every boot is what forced a fresh login after each restart');
  assert.match(storage, /export function writeBoundAuth[\s\S]{0,400}getBrowserStorages\(\)/, 'credentials must reach durable storage, not only the tab that created them');
  assert.match(storage, /export function readBoundAuth[\s\S]{0,400}if \(hasPrivateAuthValue\(fromSession\)\) return fromSession;\s*return readBoundAuthFromStorages\(getLocalStorages\(\)/s, 'a tab keeps its own identity, with the durable record as the fallback');
  assert.match(storage, /function accountUserTokenKey\(apiBase: string\): string \{\s*return `\$\{STORAGE_KEYS\.accountUserToken\}\.\$\{authScopeId\(apiBase\)\}`;/s, 'the account token must be scoped per backend or a persisted one would follow an apiBase switch');
  assert.match(storage, /export function touchAuthRememberedAt/, 'the 7-day window has to slide, or it is an absolute deadline for active operators');
  assert.match(appSource, /touchAuthRememberedAt\(apiBase\);/, 'the sliding window must actually be refreshed by the app');
});

test('the admin proxy separates "not an admin" from "upstream could not answer"', () => {
  const proxy = readFileSync(new URL('../functions/_lib/admin-proxy.ts', import.meta.url), 'utf8');

  assert.match(proxy, /type AdminVerdict = "admin" \| "not-admin" \| "unknown"/, 'the verdict must carry the unknown case, not collapse it into false');
  assert.match(proxy, /if \(response\.status === 401 \|\| response\.status === 403\) \{\s*cacheAdminResult\(cacheKey, false\);\s*return "not-admin";\s*\}\s*return "unknown";/s, 'only the upstream own auth verdicts describe the credential; 429/5xx must stay unknown and uncached');
  assert.match(proxy, /if \(verdict === "unknown"\) \{[^}]*jsonError\(503,[^}]*"admin_verification_unavailable"\)/s, 'an unverifiable identity is a 503, because a 403 here reads to the client as an expired login');
  assert.doesNotMatch(proxy, /if \(!response\.ok\) \{\s*cacheAdminResult\(cacheKey, false\);\s*return false;/s, 'treating every non-2xx as "not an admin" is what signed operators out on upstream hiccups');
});

test('admin API boundaries report only authentication failures and preserve sessions for business 403 responses', async () => {
  const originalFetch = globalThis.fetch;
  const observedStatuses: number[] = [];
  const unsubscribe = subscribeAuthenticationFailures((error) => {
    observedStatuses.push(Number((error as { status?: unknown }).status));
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const pathname = new URL(String(input), 'https://api.example').pathname;
    if (pathname === '/network-error') throw new TypeError('network unavailable');
    const status = pathname === '/unauthorized' ? 401 : pathname === '/server-error' ? 503 : 403;
    const body = pathname === '/invalid-admin'
      ? { error: { code: 'invalid_admin_password', message: 'invalid administrator credential' } }
      : pathname === '/user_api/settings'
        ? { message: 'account token expired' }
        : { error: { code: 'webhook_disabled', message: 'Webhook is disabled' } };
    return new Response(JSON.stringify(status === 401 || status === 503 ? { message: `status ${status}` } : body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    noteAuthenticationSuccess();
    const client = createApiClient(() => 'https://api.example', () => ({ userAccessToken: 'active-token' }));
    await assert.rejects(client.request('/unauthorized', { skipCache: true }), (error: any) => error?.status === 401);
    assert.deepEqual(observedStatuses, [], 'one rejection is a blip, not a verdict: it must not end the session');
    await assert.rejects(client.request('/forbidden', { skipCache: true }), (error: any) => error?.status === 403);
    assert.deepEqual(observedStatuses, [], 'a business 403 describes a capability, never the credential');
    await assert.rejects(client.request('/invalid-admin', { skipCache: true }), (error: any) => error?.status === 403);
    assert.deepEqual(observedStatuses, [403], 'a second credential rejection confirms the session is gone');
    await assert.rejects(client.request('/server-error', { skipCache: true }), (error: any) => error?.status === 503);
    await assert.rejects(client.request('/network-error', { skipCache: true }), /network unavailable/);
    await assert.rejects(fetchUserProfile('https://api.example', 'account-token'), (error: any) => error?.status === 403);
    assert.deepEqual(observedStatuses, [403], 'neither 5xx, offline nor a fresh single strike may invalidate a session');
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});

test('optional mail-state sync stays on the Admin origin and cannot invalidate the primary session', async () => {
  assert.equal(
    adminMailStateEndpoint('?mode=inbox', 'https://mail.example.test'),
    'https://mail.example.test/api/mail-state?mode=inbox',
  );

  const originalFetch = globalThis.fetch;
  const observedStatuses: number[] = [];
  const unsubscribe = subscribeAuthenticationFailures((error) => {
    observedStatuses.push(Number((error as { status?: unknown }).status));
  });
  globalThis.fetch = (async () => new Response('invalid address credential', { status: 401 })) as typeof fetch;
  try {
    const client = createApiClient(
      () => 'https://apimail.example.test',
      () => ({ accountUserToken: 'account-token', userAccessToken: 'role-token' }),
    );
    await assert.rejects(
      client.request(adminMailStateEndpoint('?mode=inbox', 'https://mail.example.test'), {
        skipCache: true,
        reportAuthFailure: false,
      }),
      (error: any) => error?.status === 401,
    );
    assert.deepEqual(observedStatuses, []);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});

test('every Admin mail-state request uses the same-origin non-authoritative channel', () => {
  const source = readFileSync(new URL('../src/views/MailWorkspace.tsx', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/adminMailStateEndpoint\(/g)].length, 3);
  assert.equal([...source.matchAll(/reportAuthFailure:\s*false/g)].length, 3);
});

test('admin parsed session-detail cache follows the mail parser cache version', () => {
  const source = readFileSync(new URL('../src/views/MailWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(source, /mailDetailSessionPrefix,\s*`v\$\{MAIL_LIST_CACHE_VERSION\}`/);
});

test('account mailbox data source supports inbox and sent without exposing global unknown mail', () => {
  assert.equal(addressMailEndpoint('inbox'), '/api/mails');
  assert.equal(addressMailEndpoint('sent'), '/api/sendbox');
  assert.equal(addressMailEndpoint('unknown'), null);
});

test('chunk load failures are recognized for recoverable update UI', () => {
  assert.equal(isChunkLoadError(new Error('Loading chunk 42 failed')), true);
  assert.equal(isChunkLoadError(new Error('ordinary validation failure')), false);
});

test('confirmed admin refresh activates a waiting worker before reloading once', () => {
  let state = 'installed';
  let stateChange: (() => void) | undefined;
  let fallback: (() => void) | undefined;
  let fallbackDelay = 0;
  let reloads = 0;
  const messages: unknown[] = [];
  const waitingWorker = {
    get state() { return state; },
    addEventListener(type: string, listener: () => void) {
      assert.equal(type, 'statechange');
      stateChange = listener;
    },
    postMessage(message: unknown) {
      messages.push(message);
    },
  };

  const requested = activateWaitingServiceWorker(
    waitingWorker,
    () => { reloads += 1; },
    (callback, delay) => {
      fallback = callback;
      fallbackDelay = delay;
    },
  );

  assert.equal(requested, true);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { type?: unknown }).type, 'SKIP_WAITING');
  assert.equal(reloads, 0);
  assert.equal(fallbackDelay, 4_000);
  state = 'activated';
  stateChange?.();
  assert.equal(reloads, 1);
  fallback?.();
  assert.equal(reloads, 1);
});

test('admin refresh leaves normal reload handling to the caller without a waiting worker', () => {
  assert.equal(activateWaitingServiceWorker(undefined, () => assert.fail('must not reload'), () => assert.fail('must not schedule')), false);
});

test('network-fresh registrar automatically activates a stranded waiting update', async () => {
  const registrarSource = readFileSync(new URL('../public/pwa-register-v2.js', import.meta.url), 'utf8');
  let loadListener: (() => void) | undefined;
  let clickListener: ((event: Record<string, unknown>) => void) | undefined;
  let stateChange: (() => void) | undefined;
  let fallback: (() => void) | undefined;
  let state = 'installed';
  let reloads = 0;
  let updates = 0;
  const messages: unknown[] = [];
  class MockElement {
    textContent = '';
    closest(_selector: string): unknown { return null; }
  }
  const alert = {
    querySelector(selector: string) {
      assert.equal(selector, 'h1');
      return { textContent: '检测到新版本' };
    },
  };
  const button = new MockElement();
  button.textContent = '刷新页面';
  button.closest = (selector: string) => selector === 'button' ? button : selector === '[role="alert"]' ? alert : null;
  const worker = {
    get state() { return state; },
    addEventListener(type: string, listener: () => void) {
      assert.equal(type, 'statechange');
      stateChange = listener;
    },
    postMessage(message: unknown) { messages.push(message); },
  };
  const registration = {
    waiting: worker,
    installing: null,
    update() { updates += 1; },
  };
  runInNewContext(registrarSource, {
    Element: MockElement,
    console: { warn() {} },
    document: {
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void, capture: boolean) {
        assert.equal(type, 'click');
        assert.equal(capture, true);
        clickListener = listener;
      },
    },
    navigator: { serviceWorker: { register: async () => registration } },
    window: {
      addEventListener(type: string, listener: () => void) {
        assert.equal(type, 'load');
        loadListener = listener;
      },
      location: { reload() { reloads += 1; } },
      setTimeout(callback: () => void, delay: number) {
        assert.equal(delay, 4_000);
        fallback = callback;
      },
    },
  });
  assert.ok(loadListener);
  assert.ok(clickListener);
  loadListener();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(updates, 1);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { type?: unknown }).type, 'SKIP_WAITING');
  const ordinaryButton = new MockElement();
  ordinaryButton.textContent = '刷新';
  ordinaryButton.closest = (selector: string) => selector === 'button' ? ordinaryButton : selector === '[role="alert"]' ? alert : null;
  let ordinaryPrevented = false;
  clickListener({
    target: ordinaryButton,
    preventDefault() { ordinaryPrevented = true; },
    stopImmediatePropagation() { assert.fail('ordinary refresh must keep propagating'); },
  });
  assert.equal(ordinaryPrevented, false);
  assert.equal(messages.length, 1);
  let prevented = false;
  let stopped = false;
  clickListener({
    target: button,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { type?: unknown }).type, 'SKIP_WAITING');
  assert.equal(reloads, 0);
  state = 'activated';
  stateChange?.();
  assert.equal(reloads, 1);
  fallback?.();
  assert.equal(reloads, 1);
});

test('network-fresh registrar activates an update that installs after the page loads', async () => {
  const registrarSource = readFileSync(new URL('../public/pwa-register-v2.js', import.meta.url), 'utf8');
  let loadListener: (() => void) | undefined;
  let updateFound: (() => void) | undefined;
  let workerStateChange: (() => void) | undefined;
  let state = 'installing';
  const messages: unknown[] = [];
  class MockElement {}
  const worker = {
    get state() { return state; },
    addEventListener(type: string, listener: () => void) {
      assert.equal(type, 'statechange');
      workerStateChange = listener;
    },
    postMessage(message: unknown) { messages.push(message); },
  };
  const registration = {
    waiting: null,
    installing: worker,
    addEventListener(type: string, listener: () => void) {
      assert.equal(type, 'updatefound');
      updateFound = listener;
    },
    update() {},
  };

  runInNewContext(registrarSource, {
    Element: MockElement,
    console: { warn() {} },
    document: { addEventListener() {} },
    navigator: { serviceWorker: { controller: {}, register: async () => registration } },
    window: {
      addEventListener(type: string, listener: () => void) {
        assert.equal(type, 'load');
        loadListener = listener;
      },
      location: { reload() {} },
      setTimeout() {},
    },
  });

  loadListener?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(updateFound);
  updateFound();
  assert.ok(workerStateChange);
  assert.equal(messages.length, 0);
  state = 'installed';
  workerStateChange();
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { type?: unknown }).type, 'SKIP_WAITING');
});

test('admin PWA keeps generated workers prompt-safe while the network-fresh registrar coordinates activation', () => {
  const viteSource = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  const htmlSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const registrarSource = readFileSync(new URL('../public/pwa-register-v2.js', import.meta.url), 'utf8');
  const errorBoundarySource = readFileSync(new URL('../src/components/AppErrorBoundary.tsx', import.meta.url), 'utf8');
  const headersSource = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  assert.match(viteSource, /registerType:\s*'prompt'/);
  assert.match(viteSource, /filename:\s*'sw-v2\.js'/);
  assert.match(viteSource, /injectRegister:\s*false/);
  assert.match(viteSource, /'\*\*\/pwa-register-\*\.js'/);
  assert.match(viteSource, /clientsClaim:\s*false/);
  assert.match(viteSource, /skipWaiting:\s*false/);
  assert.match(htmlSource, /<script src="\/pwa-register-v2\.js" defer><\/script>/);
  assert.match(registrarSource, /serviceWorker[\s\S]*register\('\/sw-v2\.js',\s*\{\s*scope:\s*'\/'\s*\}\)/);
  assert.match(registrarSource, /return\s+\w+\.update\(\)/);
  assert.match(errorBoundarySource, /navigator\.serviceWorker[\s\S]*getRegistration\('\/'\)/);
  assert.match(errorBoundarySource, /activateWaitingServiceWorker/);
  assert.match(headersSource, /\/pwa-register-v2\.js[\s\S]*Cache-Control: no-cache, no-store, must-revalidate/);
});

test('admin preserves fixed-width email tables and replaces blocked Claude logos locally', () => {
  const parser = readFileSync(new URL('../src/lib/mailParser.ts', import.meta.url), 'utf8');
  const headersSource = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  assert.doesNotMatch(parser, /\*, \*::before, \*::after \{ box-sizing: border-box;/, "global border-box sizing changes fixed email cell geometry");
  assert.doesNotMatch(parser, /\*, \*::before, \*::after \{[^}]*max-width: 100%/, "global max-width must not rewrite email table geometry");
  assert.doesNotMatch(parser, /table \{ width: auto !important;/, "fixed-width email tables must not be expanded to the reader width");
  assert.match(parser, /img:not\(\[height\]\) \{ height: auto !important; \}/, "only images without an explicit sender-defined height should be auto-sized");
  assert.match(parser, /#loven7-mail-root > \* \{ margin-left: auto !important; margin-right: auto !important; \}/, "each sender-defined top-level mail canvas should be centered without changing its internal alignment");
  const blockedBrandAsset = ['https:/', 'claude.ai/images/claude_logo_full.png'].join('/');
  assert.equal(
    proxyMailImageUrl(blockedBrandAsset, 'https://mail.example.test'),
    'https://mail.example.test/mail-assets/claude-logo-full.svg',
    'known Claude assets that reject server fetches need a same-origin fallback',
  );
  assert.match(
    headersSource,
    /\/mail-assets\/\*[\s\S]*Cross-Origin-Resource-Policy:\s*cross-origin/,
    'opaque sandboxed mail frames must be allowed to embed same-origin fallback assets',
  );
});

test('mail frame messages require the exact iframe window and bounded payloads', () => {
  const trustedWindow = {};
  assert.deepEqual(readTrustedMailFrameMessage({ source: trustedWindow, data: { type: 'loven7-mail-iframe-swipe', direction: 'left' } }, trustedWindow), { type: 'loven7-mail-iframe-swipe', direction: 'left' });
  assert.equal(readTrustedMailFrameMessage({ source: {}, data: { type: 'loven7-mail-iframe-swipe', direction: 'left' } }, trustedWindow), null);
  assert.equal(readTrustedMailFrameMessage({ source: trustedWindow, data: { type: 'loven7-mail-iframe-swipe-progress', dx: 9999 } }, trustedWindow), null);
});

test('admin head reconciliation drops deleted rows while preserving loaded older pages', () => {
  const existing = [10, 9, 8, 7].map((id) => ({ id }));
  const head = [10, 8].map((id) => ({ id }));
  assert.deepEqual(preserveRowsBelowAuthoritativeHead(existing, head, true).map((row) => row.id), [7]);
  assert.deepEqual(preserveRowsBelowAuthoritativeHead(existing, head, false), []);
});

test('address quick index stops at its explicit row budget and reports truncation', async () => {
  const offsets: number[] = [];
  const result = await loadBoundedAddressIndex({
    pageSize: 500,
    maxRows: 1_000,
    fetchPage: async (offset, limit) => {
      offsets.push(offset);
      return {
        count: 10_000,
        results: Array.from({ length: limit }, (_, index) => ({ id: offset + index + 1 })),
      };
    },
  });
  assert.deepEqual(offsets, [0, 500]);
  assert.equal(result.results.length, 1_000);
  assert.equal(result.reportedCount, 10_000);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
});

test('address quick index observes AbortController before requesting another page', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(loadBoundedAddressIndex({
    pageSize: 2,
    maxRows: 10,
    signal: controller.signal,
    fetchPage: async (offset, limit) => {
      calls += 1;
      controller.abort();
      return { count: 10, results: Array.from({ length: limit }, (_, index) => ({ id: offset + index + 1 })) };
    },
  }), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('multi-mailbox share credential lookup uses bounded concurrency and preserves order', async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  const rows = Array.from({ length: 9 }, (_, index) => ({ id: index + 1, name: `box-${index + 1}@example.com` }));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'https://api.example');
    if (url.pathname.startsWith('/user_api/bind_address_jwt/')) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(JSON.stringify({ jwt: `jwt-${url.pathname.split('/').pop()}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/share') {
      const payload = JSON.parse(String(init?.body || '{}')) as { addressCredentials?: Array<{ id: string }> };
      assert.deepEqual(payload.addressCredentials?.map((item) => item.id), rows.map((row) => String(row.id)));
      return new Response(JSON.stringify({ url: 'https://email.example/s/test', addresses: rows }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;
  try {
    await createUserShare('https://api.example', 'user.jwt', 'https://email.example', rows);
    assert.equal(maxActive, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('irreversibly revoked shares are never selected for expiry extension', () => {
  const now = Date.parse('2026-07-13T12:00:00.000Z');
  const shares = [
    { token: 'active-token', status: 'active', expiresAt: '2026-07-14T12:00:00.000Z', revokedAt: null },
    { token: 'expired-token', status: 'expired', expiresAt: '2026-07-12T12:00:00.000Z', revokedAt: null },
    { token: 'revoked-token', status: 'revoked', expiresAt: '2026-07-12T12:00:00.000Z', revokedAt: '2026-07-11T12:00:00.000Z' },
  ];
  assert.equal(shareLifecycleStatus(shares[2], now), 'revoked');
  assert.deepEqual(selectExpiredShareTokens(shares, now), ['expired-token']);
});

test('registration consumes the Worker-issued JWT without a second login attempt', async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'https://api.example');
    paths.push(url.pathname);
    if (url.pathname === '/user_api/register') return new Response(JSON.stringify({ jwt: 'issued.jwt.token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/user_api/settings') return new Response(JSON.stringify({ user_email: 'user@example.com', user_id: 7, role: 'user' }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;
  try {
    const profile = await registerAccountUser('https://api.example', 'user@example.com', 'password123', '123456');
    assert.equal(profile.userToken, 'issued.jwt.token');
    assert.deepEqual(paths, ['/user_api/register', '/user_api/settings']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('registration keeps the issued session when the immediate profile refresh is temporarily unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'https://api.example');
    paths.push(url.pathname);
    if (url.pathname === '/user_api/register') {
      return new Response(JSON.stringify({ jwt: 'issued.jwt.token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/user_api/settings') {
      return new Response(JSON.stringify({ message: 'temporary outage' }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;
  try {
    const profile = await registerAccountUser('https://api.example', 'New.User@example.com', 'password123', '123456');
    assert.equal(profile.userToken, 'issued.jwt.token');
    assert.equal(profile.userEmail, 'new.user@example.com');
    assert.deepEqual(paths, ['/user_api/register', '/user_api/settings']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('address password rotation returns and adopts the replacement JWT', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'https://api.example');
    assert.equal(url.pathname, '/api/address_change_password');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer old.jwt.token');
    return new Response(JSON.stringify({ success: true, jwt: 'new.jwt.token' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    assert.equal(await changeAddressPassword('https://api.example', 'old.jwt.token', 'new-password-123'), 'new.jwt.token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
