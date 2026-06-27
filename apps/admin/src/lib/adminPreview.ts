import type { ApiRequestOptions, Requester } from './api';
import type { AddressRecord, BoundAddressRecord, ListResponse, OpenSettings, RawMailRecord, RoleRecord, SenderAccessRecord, SendboxRecord, Statistics, UserRecord } from '../types/api';

type PreviewMailDraft = {
  id: number;
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  body: string;
  createdAt: string;
};

const PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalHost(): boolean {
  if (typeof window === 'undefined') return false;
  return PREVIEW_HOSTS.has(window.location.hostname);
}

export function isAdminPreviewAvailable(): boolean {
  return isLocalHost();
}

export function isAdminPreviewEnabled(): boolean {
  if (!isAdminPreviewAvailable() || typeof window === 'undefined') return false;
  const preview = new URL(window.location.href).searchParams.get('preview') || '';
  return preview.trim().toLowerCase() === 'admin';
}

function buildRawMail(mail: PreviewMailDraft): string {
  return [
    `From: ${mail.fromName} <${mail.fromEmail}>`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    `Date: ${new Date(mail.createdAt).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<div style="font-family:Inter, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif;line-height:1.6;color:#111317;font-size:16px;font-weight:400">
      <p>${mail.body}</p>
    </div>`,
  ].join('\r\n');
}

const previewInboxDrafts: PreviewMailDraft[] = [
  {
    id: 1008,
    fromName: 'Carlos Iglesias',
    fromEmail: 'carlos@heroui.dev',
    to: 'admin@loven7.test',
    subject: 'Launch recap + next steps',
    body: "Quick recap from this morning's launch review so we have it in writing.<br><br>We agreed on the final launch date (Tuesday the 24th) and the three must-ship items: onboarding tour, billing update flow, and the new analytics dashboard.<br><br>Parker and I will co-own the go/no-go checklist. Can you sync with me and Maya tomorrow at 10:30?",
    createdAt: '2026-06-25T09:46:00+08:00',
  },
  {
    id: 1007,
    fromName: 'Stripe',
    fromEmail: 'receipts@stripe.com',
    to: 'admin@loven7.test',
    subject: 'Invoice INV-0241 is due tomorrow',
    body: 'Invoice INV-0241 for $2,450.00 is due tomorrow. You can review the invoice details from your billing dashboard.',
    createdAt: '2026-06-24T18:30:00+08:00',
  },
  {
    id: 1006,
    fromName: 'Flights',
    fromEmail: 'updates@flights.example',
    to: 'hero@loven7.test',
    subject: 'Flight itinerary: SFO -> NRT',
    body: "You're booked on flight FL-482 from SFO to NRT. Your seat and boarding details are now available.",
    createdAt: '2026-04-22T12:00:00+08:00',
  },
  {
    id: 1005,
    fromName: 'GitHub',
    fromEmail: 'noreply@github.com',
    to: 'hero@loven7.test',
    subject: '[heroui/heroui.pro] Review requested on PR #242',
    body: 'Review requested on #242 - fix template imports and update the package metadata before merge.',
    createdAt: '2026-06-25T09:02:00+08:00',
  },
  {
    id: 1004,
    fromName: 'Maya Okafor',
    fromEmail: 'maya@heroui.dev',
    to: 'ops@loven7.test',
    subject: 'Design review: dashboard v3',
    body: "Pinging ahead of Friday's design review. The dashboard v3 screens are ready for your final pass.",
    createdAt: '2026-06-23T16:20:00+08:00',
  },
  {
    id: 1003,
    fromName: 'Amelia from Linear',
    fromEmail: 'hello@linear.app',
    to: 'deploy@loven7.test',
    subject: 'Your weekly summary',
    body: '8 issues closed, 3 blocked issues need triage, and 2 high priority tasks changed status this week.',
    createdAt: '2026-06-23T09:00:00+08:00',
  },
  {
    id: 1002,
    fromName: 'Ravi Anand',
    fromEmail: 'ravi@example.com',
    to: 'hero@loven7.test',
    subject: 'Dinner plans for Saturday?',
    body: 'Are we still on for dinner on Saturday? The place near the river has a table at 7:30.',
    createdAt: '2026-06-22T19:15:00+08:00',
  },
  {
    id: 1001,
    fromName: 'Parker Wren',
    fromEmail: 'parker@heroui.dev',
    to: 'admin@loven7.test',
    subject: '1:1 notes - Q2 growth plan',
    body: 'Growth plan notes: define H1 north-star metric, align onboarding experiments, and schedule customer calls.',
    createdAt: '2026-06-20T10:10:00+08:00',
  },
];

const previewExtraInboxDrafts: PreviewMailDraft[] = [
  {
    id: 1000,
    fromName: 'Notion',
    fromEmail: 'updates@notion.so',
    to: 'team@loven7.test',
    subject: 'Workspace digest: 6 pages changed',
    body: 'Your workspace had updates in Launch Notes, Product QA, and Admin Mobile Review. Three comments are waiting for your reply.',
    createdAt: '2026-06-19T17:42:00+08:00',
  },
  {
    id: 999,
    fromName: 'Vercel',
    fromEmail: 'notifications@vercel.com',
    to: 'deploy@loven7.test',
    subject: 'Preview deployment is ready',
    body: 'The preview deployment for branch mobile-polish is ready. Performance checks completed successfully.',
    createdAt: '2026-06-19T13:28:00+08:00',
  },
  {
    id: 998,
    fromName: 'Cloudflare',
    fromEmail: 'noreply@cloudflare.com',
    to: 'admin@loven7.test',
    subject: 'Pages build completed',
    body: 'Your Cloudflare Pages deployment completed. Review the deployment logs and confirm production aliases before release.',
    createdAt: '2026-06-18T22:14:00+08:00',
  },
  {
    id: 997,
    fromName: 'Figma',
    fromEmail: 'notifications@figma.com',
    to: 'design@loven7.test',
    subject: 'Maya mentioned you in Mobile Inbox',
    body: 'Maya left a comment on the mobile inbox frame: please check toolbar spacing and the selected state motion.',
    createdAt: '2026-06-18T16:56:00+08:00',
  },
  {
    id: 996,
    fromName: 'Apple Developer',
    fromEmail: 'news@developer.apple.com',
    to: 'ios@loven7.test',
    subject: 'Design for fluid navigation',
    body: 'Explore updated design guidance for fluid navigation, stable tab bars, and motion that preserves spatial context.',
    createdAt: '2026-06-17T20:05:00+08:00',
  },
  {
    id: 995,
    fromName: 'Linear',
    fromEmail: 'notifications@linear.app',
    to: 'ops@loven7.test',
    subject: 'Issue ADM-128 moved to Review',
    body: 'ADM-128 Mobile inbox polish moved to Review by Amelia. Remaining checklist: scroll behavior and preview data depth.',
    createdAt: '2026-06-17T14:18:00+08:00',
  },
  {
    id: 994,
    fromName: 'Sentry',
    fromEmail: 'alerts@sentry.io',
    to: 'alerts@loven7.test',
    subject: 'Resolved: frontend hydration warning',
    body: 'The issue frontend hydration warning has been resolved after 24 hours without a recurrence.',
    createdAt: '2026-06-16T23:40:00+08:00',
  },
  {
    id: 993,
    fromName: 'GitHub',
    fromEmail: 'noreply@github.com',
    to: 'hero@loven7.test',
    subject: '[loven7/mail] CI checks passed',
    body: 'All checks passed for commit mobile-inbox-pass. Build, lint, and preview smoke checks are green.',
    createdAt: '2026-06-16T18:12:00+08:00',
  },
  {
    id: 992,
    fromName: 'Productboard',
    fromEmail: 'updates@productboard.com',
    to: 'team@loven7.test',
    subject: 'New feedback tagged: temporary mailbox',
    body: 'Three customer notes were tagged temporary mailbox. Main request: clearer multi-address identity in the inbox.',
    createdAt: '2026-06-15T21:09:00+08:00',
  },
  {
    id: 991,
    fromName: 'Tailscale',
    fromEmail: 'no-reply@tailscale.com',
    to: 'security@loven7.test',
    subject: 'New device approved',
    body: 'A new device was approved for your tailnet. If this was unexpected, review your admin console.',
    createdAt: '2026-06-15T11:34:00+08:00',
  },
  {
    id: 990,
    fromName: 'OpenAI',
    fromEmail: 'no-reply@openai.com',
    to: 'lab@loven7.test',
    subject: 'API usage summary',
    body: 'Your weekly API usage summary is ready. Usage remained within the configured project budget.',
    createdAt: '2026-06-14T19:27:00+08:00',
  },
  {
    id: 989,
    fromName: 'Zoom',
    fromEmail: 'no-reply@zoom.us',
    to: 'meetings@loven7.test',
    subject: 'Recording available: Mobile polish sync',
    body: 'The cloud recording for Mobile polish sync is now available. Transcript processing has completed.',
    createdAt: '2026-06-14T10:48:00+08:00',
  },
  {
    id: 988,
    fromName: 'Dropbox',
    fromEmail: 'no-reply@dropbox.com',
    to: 'files@loven7.test',
    subject: 'Shared folder invitation',
    body: 'You were invited to the shared folder Admin UI Reference. Review assets before the next design pass.',
    createdAt: '2026-06-13T15:22:00+08:00',
  },
  {
    id: 987,
    fromName: 'Cal.com',
    fromEmail: 'bookings@cal.com',
    to: 'admin@loven7.test',
    subject: 'New booking: QA review',
    body: 'QA review was booked for Friday at 15:00. Calendar details and conferencing link are included.',
    createdAt: '2026-06-13T09:15:00+08:00',
  },
  {
    id: 986,
    fromName: 'Stripe',
    fromEmail: 'billing@stripe.com',
    to: 'billing@loven7.test',
    subject: 'Payment succeeded for subscription',
    body: 'A payment succeeded for your active subscription. The receipt is attached to this message.',
    createdAt: '2026-06-12T22:31:00+08:00',
  },
  {
    id: 985,
    fromName: 'HeroUI',
    fromEmail: 'hello@heroui.dev',
    to: 'hero@loven7.test',
    subject: 'Component release notes',
    body: 'This release includes improved listbox interactions, better focus rings, and smaller bundle output.',
    createdAt: '2026-06-12T13:08:00+08:00',
  },
];

const previewInboxAllDrafts = [...previewInboxDrafts, ...previewExtraInboxDrafts];

const previewInbox: RawMailRecord[] = previewInboxAllDrafts.map((mail) => ({
  id: mail.id,
  source: mail.fromEmail,
  address: mail.to,
  raw: buildRawMail(mail),
  created_at: mail.createdAt,
  checked: false,
}));

const previewUnknown: RawMailRecord[] = [
  {
    id: 2001,
    source: 'unknown-sender@example.net',
    address: '',
    raw: buildRawMail({
      id: 2001,
      fromName: 'Unknown Sender',
      fromEmail: 'unknown-sender@example.net',
      to: 'undelivered@loven7.test',
      subject: 'Unmatched inbound message',
      body: 'This message is intentionally placed in the unknown mailbox preview.',
      createdAt: '2026-06-23T20:12:00+08:00',
    }),
    created_at: '2026-06-23T20:12:00+08:00',
  },
];

const previewSent: SendboxRecord[] = [
  {
    id: 3003,
    address: 'admin@loven7.test',
    raw: JSON.stringify({
      from_name: 'Loven7 Admin',
      from_mail: 'admin@loven7.test',
      to_name: 'Cloudflare',
      to_mail: 'support@cloudflare.com',
      subject: 'Deployment verification',
      is_html: true,
      content: '<p>Please confirm the latest Pages deployment result.</p>',
    }),
    created_at: '2026-06-25T10:02:00+08:00',
  },
  {
    id: 3002,
    address: 'hero@loven7.test',
    raw: JSON.stringify({
      from_name: 'Hero Alias',
      from_mail: 'hero@loven7.test',
      to_name: 'GitHub',
      to_mail: 'noreply@github.com',
      subject: 'Re: Your verification code',
      is_html: false,
      content: 'Received, thanks.',
    }),
    created_at: '2026-06-24T19:32:00+08:00',
  },
];

const previewUsers: UserRecord[] = [
  { id: 1, user_email: 'demo@loven7.test', role_text: 'admin', address_count: 3, created_at: '2026-06-05T09:00:00+08:00', updated_at: '2026-06-25T09:30:00+08:00' },
  { id: 2, user_email: 'ops@loven7.test', role_text: 'operator', address_count: 2, created_at: '2026-06-08T10:20:00+08:00', updated_at: '2026-06-24T16:12:00+08:00' },
  { id: 3, user_email: 'design@loven7.test', role_text: 'member', address_count: 2, created_at: '2026-06-11T15:40:00+08:00', updated_at: '2026-06-23T11:00:00+08:00' },
];

const previewRoles: RoleRecord[] = [
  { role: 'admin', label: '管理员', description: 'Full access for preview screenshots' },
  { role: 'operator', label: '运营', description: 'Mailbox and sharing operations' },
  { role: 'member', label: '成员', description: 'Personal mailbox access' },
];

const previewAddresses: AddressRecord[] = [
  { id: 1, name: 'alpha.demo@loven7.test', source_meta: 'preview', user_id: 1, user_email: 'demo@loven7.test', mail_count: 12, send_count: 2, created_at: '2026-06-05T09:12:00+08:00', updated_at: '2026-06-25T09:18:00+08:00' },
  { id: 2, name: 'build.bot@loven7.test', source_meta: 'system', user_id: 1, user_email: 'demo@loven7.test', mail_count: 8, send_count: 1, created_at: '2026-06-06T13:30:00+08:00', updated_at: '2026-06-24T20:40:00+08:00' },
  { id: 3, name: 'team.ops@loven7.test', source_meta: 'user', user_id: 2, user_email: 'ops@loven7.test', mail_count: 6, send_count: 0, created_at: '2026-06-07T08:10:00+08:00', updated_at: '2026-06-23T18:30:00+08:00' },
  { id: 4, name: 'preview@loven7.test', source_meta: 'random', user_id: 2, user_email: 'ops@loven7.test', mail_count: 3, send_count: 1, created_at: '2026-06-09T14:00:00+08:00', updated_at: '2026-06-20T10:00:00+08:00' },
  { id: 5, name: 'share.link@loven7.test', source_meta: 'preview', user_id: 3, user_email: 'design@loven7.test', mail_count: 5, send_count: 0, created_at: '2026-06-10T16:22:00+08:00', updated_at: '2026-06-22T15:15:00+08:00' },
  { id: 6, name: 'login.magic@loven7.test', source_meta: 'user', user_id: 3, user_email: 'design@loven7.test', mail_count: 4, send_count: 1, created_at: '2026-06-12T11:36:00+08:00', updated_at: '2026-06-21T09:42:00+08:00' },
  { id: 7, name: 'alerts@loven7.test', source_meta: 'system', user_id: 1, user_email: 'demo@loven7.test', mail_count: 10, send_count: 0, created_at: '2026-06-14T19:05:00+08:00', updated_at: '2026-06-25T08:55:00+08:00' },
];

const previewSenderAccess: SenderAccessRecord[] = previewAddresses.slice(0, 4).map((row, index) => ({
  id: row.id,
  address: row.name,
  balance: [120, 80, 50, 20][index] ?? 0,
  enabled: index !== 3,
  created_at: row.created_at,
  updated_at: row.updated_at,
}));

const previewStats: Statistics = {
  mailCount: previewInbox.length,
  sendMailCount: previewSent.length,
  userCount: 3,
  addressCount: 7,
  activeAddressCount7days: 5,
  activeAddressCount30days: 7,
};

const previewOpenSettings: OpenSettings = {
  title: 'Loven7 Mail Preview',
  needAuth: false,
  enableSendMail: true,
  enableUserCreateEmail: true,
  enableUserDeleteEmail: true,
  enableWebhook: true,
  enableAddressPassword: true,
  domains: ['loven7.test'],
};

function paginate<T>(items: T[], url: URL): ListResponse<T> {
  const limit = Math.max(1, Number(url.searchParams.get('limit') || 20));
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
  const address = (url.searchParams.get('address') || '').trim().toLowerCase();
  const filtered = address
    ? items.filter((item) => JSON.stringify(item).toLowerCase().includes(address))
    : items;
  return {
    results: filtered.slice(offset, offset + limit),
    count: filtered.length,
  };
}

function normalizePreviewPath(path: string): URL {
  return new URL(path.startsWith('http') ? path : `http://preview.local${path.startsWith('/') ? path : `/${path}`}`);
}

export function createAdminPreviewRequest(): Requester {
  return async function previewRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const url = normalizePreviewPath(path);
    const method = options.method || 'GET';

    if (url.pathname === '/admin/statistics') return previewStats as T;
    if (url.pathname === '/open_api/settings') return previewOpenSettings as T;
    if (url.pathname === '/admin/worker/configs') {
      return {
        enableUserCreateEmail: true,
        enableUserDeleteEmail: true,
        enableSendMail: true,
        enableWebhook: true,
        enableAddressPassword: true,
        isS3Enabled: false,
        domains: ['loven7.test'],
        frontendLoginBase: 'http://localhost:4173',
      } as T;
    }
    if (url.pathname === '/api/mail-state') {
      return {
        mode: url.searchParams.get('mode') || 'inbox',
        readIds: [],
        starredIds: [],
        readAllBefore: {},
        updatedAt: Date.now(),
      } as T;
    }
    if (url.pathname === '/admin/mails') return paginate(previewInbox, url) as T;
    if (url.pathname === '/admin/mails_unknow') return paginate(previewUnknown, url) as T;
    if (url.pathname === '/admin/sendbox') return paginate(previewSent, url) as T;
    if (url.pathname === '/admin/users') return paginate(previewUsers, url) as T;
    if (url.pathname === '/admin/user_roles') return previewRoles as T;
    if (/^\/admin\/users\/bind_address\/\d+$/.test(url.pathname)) {
      const userId = Number(url.pathname.split('/').pop() || 0);
      const rows: BoundAddressRecord[] = previewAddresses
        .filter((row) => row.user_id === userId)
        .map((row) => ({
          id: row.id,
          name: row.name,
          mail_count: row.mail_count,
          send_count: row.send_count,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }));
      return { results: rows } as T;
    }
    if (url.pathname === '/admin/address') return paginate(previewAddresses, url) as T;
    if (url.pathname === '/admin/address_sender') return paginate(previewSenderAccess, url) as T;
    if (/^\/admin\/show_password\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').pop() || 0);
      return { jwt: `preview-jwt-${id || 'address'}` } as T;
    }
    if (method === 'DELETE' && /^\/admin\/(?:mails|sendbox)\/\d+$/.test(url.pathname)) return {} as T;
    if (method === 'DELETE' && /^\/admin\/(?:delete_address|clear_inbox|clear_sent_items)\/\d+$/.test(url.pathname)) return {} as T;

    return {} as T;
  };
}
