export type MailAddress = {
  name?: string;
  address?: string;
};

export type RawMail = {
  id: number;
  raw?: string;
  source?: string;
  subject?: string;
  address?: string;
  message_id?: string;
  created_at?: string;
  metadata?: string;
};

export type MailPage = {
  results: RawMail[];
  count: number;
};

export type SafeSettings = {
  address?: string;
  enableSendMail?: boolean;
  enableAutoReply?: boolean;
  sendBalance?: number;
  domains?: string[];
  defaultDomains?: string[];
  domainLabels?: string[];
  randomSubdomainDomains?: string[];
};

export type SessionResponse = {
  ok: boolean;
  jwt?: string;
  address?: string;
  settings?: SafeSettings;
};

export type SharedMailbox = {
  id: string;
  address: string;
};

export type SharePermissions = {
  hideMail: boolean;
};

export type ShareInfo = {
  ok: boolean;
  token: string;
  expiresAt?: string | null;
  mailVisibility?: "new" | "all";
  permissions?: SharePermissions;
  addresses: SharedMailbox[];
};

export type ParsedAttachmentSummary = {
  filename?: string;
  mimeType?: string;
  size?: number;
  contentId?: string;
  related?: boolean;
};

export type ParsedMail = {
  id: number;
  messageId?: string;
  from?: MailAddress;
  to?: MailAddress[];
  subject: string;
  preview: string;
  text?: string;
  html?: string;
  raw: string;
  date?: string;
  createdAt: string;
  attachments?: ParsedAttachmentSummary[];
  verificationCode?: string;
};

export type WebmailSession = {
  jwt: string;
  address: string;
  settings?: SafeSettings;
  cacheKey: string;
  shareToken?: string;
  shareMailboxId?: string;
  shareMailboxes?: SharedMailbox[];
  readonly?: boolean;
};

