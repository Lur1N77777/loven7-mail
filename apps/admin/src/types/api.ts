export interface ListResponse<T> {
  results: T[];
  count: number;
}

export interface OpenSettings {
  title?: string;
  prefix?: string;
  addressRegex?: string;
  minAddressLen?: number;
  maxAddressLen?: number;
  domains?: Array<string | { label: string; value: string }>;
  domainLabels?: string[];
  defaultDomains?: string[];
  randomSubdomainDomains?: string[];
  needAuth?: boolean;
  adminContact?: string;
  enableUserCreateEmail?: boolean;
  disableAnonymousUserCreateEmail?: boolean;
  disableCustomAddressName?: boolean;
  enableUserDeleteEmail?: boolean;
  enableAutoReply?: boolean;
  enableIndexAbout?: boolean;
  copyright?: string;
  cfTurnstileSiteKey?: string;
  enableWebhook?: boolean;
  isS3Enabled?: boolean;
  enableSendMail?: boolean;
  enableAddressPassword?: boolean;
  enableAgentEmailInfo?: boolean;
  statusUrl?: string;
  enableGlobalTurnstileCheck?: boolean;
  disableAdminPasswordCheck?: boolean;
  [key: string]: unknown;
}

export interface Statistics {
  mailCount: number;
  sendMailCount: number;
  userCount: number;
  addressCount: number;
  activeAddressCount7days: number;
  activeAddressCount30days: number;
}

export interface AddressRecord {
  id: number;
  name: string;
  source_meta?: string;
  user_id?: number;
  user_email?: string;
  owner?: string;
  created_at?: string;
  updated_at?: string;
  mail_count?: number;
  send_count?: number;
}

export interface AddressUserFilter {
  userId: number;
  userEmail: string;
  requestId: number;
}

export interface RawMailRecord {
  id: number;
  message_id?: string;
  source?: string;
  address?: string;
  raw?: string;
  metadata?: string;
  created_at?: string;
  checked?: boolean;
  [key: string]: unknown;
}

export interface ParsedAttachment {
  id: string;
  filename: string;
  size: string;
  bytes: number;
  mimeType: string;
  url: string;
  blob: Blob;
}

export interface ParsedMail extends RawMailRecord {
  sender: string;
  senderName: string;
  senderAddress: string;
  to: string;
  subject: string;
  message: string;
  text: string;
  preview: string;
  attachments: ParsedAttachment[];
  unread?: boolean;
  starred?: boolean;
  verificationCode?: string;
  verificationCodes?: string[];
  isUnread?: boolean;
  isStarred?: boolean;
  parsedAt: number;
}

export interface SendboxRecord {
  id: number;
  address: string;
  raw: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface ParsedSendbox extends SendboxRecord {
  from_name?: string;
  from_mail?: string;
  to_name?: string;
  to_mail?: string;
  subject: string;
  content: string;
  is_html: boolean;
  preview: string;
  verificationCode?: string;
  verificationCodes?: string[];
  isUnread?: boolean;
  isStarred?: boolean;
}

export interface SenderAccessRecord {
  id: number;
  address: string;
  balance: number;
  enabled: number | boolean;
  created_at?: string;
  updated_at?: string;
}

export interface BoundAddressRecord {
  id: number;
  name: string;
  mail_count?: number;
  send_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface RoleAddressConfigResponse {
  configs: Record<string, { maxAddressCount?: number | null }>;
}

export interface BindingSendPayload {
  from: string | { email: string; name?: string };
  to: string | Array<string | { email: string; name?: string }>;
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; contentType?: string; content: string }>;
}

export interface TelegramStatus {
  fetched?: boolean;
  webhookInfo?: unknown;
  commands?: unknown;
  [key: string]: unknown;
}

export interface UserRecord {
  id: number;
  user_email: string;
  role_text?: string;
  address_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface RoleRecord {
  role: string;
  label?: string;
  description?: string;
  [key: string]: unknown;
}

export interface ComposePayload {
  from_name: string;
  from_mail: string;
  to_name: string;
  to_mail: string;
  subject: string;
  is_html: boolean;
  content: string;
}
