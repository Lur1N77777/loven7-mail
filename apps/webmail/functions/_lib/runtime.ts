export type RuntimeDiagnostics = {
  version: 1;
  ok: boolean;
  status: "ready" | "incomplete";
  checks: {
    mailWorkerBaseUrl: boolean;
    sitePassword: boolean;
    shareKv: boolean;
    shareEncryptionSecret: boolean;
    shareAdminCorsOrigins: boolean;
  };
  required: string[];
  optional: string[];
  missing: string[];
  optionalMissing: string[];
  hints: string[];
};

const REQUIRED_BINDINGS = ["MAIL_WORKER_BASE_URL", "SHARE_KV", "SHARE_ENCRYPTION_SECRET"] as const;
const OPTIONAL_BINDINGS = ["SITE_PASSWORD", "SHARE_ADMIN_CORS_ORIGINS"] as const;

function hasText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasBinding(value: unknown) {
  return Boolean(value);
}

export function runtimeDiagnostics(env: Record<string, unknown> = {}): RuntimeDiagnostics {
  const checks = {
    mailWorkerBaseUrl: hasText(env.MAIL_WORKER_BASE_URL),
    sitePassword: hasText(env.SITE_PASSWORD),
    shareKv: hasBinding(env.SHARE_KV),
    shareEncryptionSecret: hasText(env.SHARE_ENCRYPTION_SECRET),
    shareAdminCorsOrigins:
      hasText(env.SHARE_ADMIN_CORS_ORIGINS) ||
      hasText(env.SHARE_ADMIN_ALLOWED_ORIGINS) ||
      hasText(env.CORS_ALLOWED_ORIGINS),
  };

  const missing: string[] = [];
  if (!checks.mailWorkerBaseUrl) missing.push("MAIL_WORKER_BASE_URL");
  if (!checks.shareKv) missing.push("SHARE_KV");
  if (!checks.shareEncryptionSecret) missing.push("SHARE_ENCRYPTION_SECRET");

  const optionalMissing: string[] = [];
  if (!checks.sitePassword) optionalMissing.push("SITE_PASSWORD");
  if (!checks.shareAdminCorsOrigins) optionalMissing.push("SHARE_ADMIN_CORS_ORIGINS");

  const hints: string[] = [];
  if (!checks.mailWorkerBaseUrl) {
    hints.push("Set MAIL_WORKER_BASE_URL in this Webmail Pages environment, then redeploy.");
  }
  if (!checks.shareKv) {
    hints.push("Bind SHARE_KV in this Webmail Pages environment, then redeploy.");
  }
  if (!checks.shareEncryptionSecret) {
    hints.push("Set SHARE_ENCRYPTION_SECRET in this Webmail Pages environment, then redeploy.");
  }
  if (!checks.sitePassword) {
    hints.push("SITE_PASSWORD is optional; set it only if the upstream mail Worker requires a site password.");
  }
  if (!checks.shareAdminCorsOrigins) {
    hints.push("Set SHARE_ADMIN_CORS_ORIGINS when Admin and Webmail run on different origins.");
  }

  return {
    version: 1,
    ok: missing.length === 0,
    status: missing.length === 0 ? "ready" : "incomplete",
    checks,
    required: [...REQUIRED_BINDINGS],
    optional: [...OPTIONAL_BINDINGS],
    missing,
    optionalMissing,
    hints,
  };
}
