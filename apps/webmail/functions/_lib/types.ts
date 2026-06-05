export interface CloudmailEnv {
  MAIL_WORKER_BASE_URL?: string;
  SITE_PASSWORD?: string;
  SHARE_ENCRYPTION_SECRET?: string;
  SHARE_ADMIN_CORS_ORIGINS?: string;
  SHARE_PUBLIC_CORS_ORIGINS?: string;
  SHARE_ADMIN_ALLOWED_ORIGINS?: string;
  SHARE_PUBLIC_ALLOWED_ORIGINS?: string;
  CORS_ALLOWED_ORIGINS?: string;
  SHARE_KV?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: {
      prefix?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
      list_complete: boolean;
      cursor?: string;
    }>;
  };
}

export interface PagesContext<Params extends Record<string, string> = Record<string, string>> {
  request: Request;
  env: CloudmailEnv;
  params: Params;
  next: () => Promise<Response>;
}

export type PagesHandler<Params extends Record<string, string> = Record<string, string>> = (
  context: PagesContext<Params>
) => Promise<Response> | Response;
