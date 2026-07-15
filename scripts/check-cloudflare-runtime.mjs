function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  return url.toString().replace(/\/+$/, "");
}

function argValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || "";
  return "";
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function probeHtml(baseUrl) {
  const response = await fetch(baseUrl, { cache: "no-store" });
  const text = await response.text();
  return {
    ok: response.ok && /<html/i.test(text),
    status: response.status,
  };
}

async function probeRuntimeDiagnostics(baseUrl) {
  const response = await fetch(`${baseUrl}/api/runtime`, { cache: "no-store" });
  const data = await readJsonResponse(response);
  const isObject = Boolean(data && typeof data === "object" && !Array.isArray(data));
  const hasRuntimeShape = Boolean(
    isObject &&
      data.version === 1 &&
      data.checks &&
      typeof data.checks === "object" &&
      Array.isArray(data.missing) &&
      Array.isArray(data.hints)
  );

  return {
    available: response.ok && hasRuntimeShape,
    ok: response.ok && hasRuntimeShape && Boolean(data.ok),
    status: response.status,
    cacheControl: response.headers.get("cache-control") || "",
    checks: hasRuntimeShape ? data.checks : undefined,
    missing: hasRuntimeShape ? data.missing : undefined,
    optionalMissing: hasRuntimeShape ? data.optionalMissing || [] : undefined,
    hints: hasRuntimeShape ? data.hints.slice(0, 10) : [],
  };
}

async function probeShareRuntime(baseUrl) {
  const probeToken = `__runtime_probe_${Date.now().toString(36)}__`;
  const response = await fetch(`${baseUrl}/api/share/${encodeURIComponent(probeToken)}`, { cache: "no-store" });
  const data = await readJsonResponse(response);
  const code = String(data?.error?.code || "");
  return {
    ok: response.status === 404 && code === "share_not_found",
    status: response.status,
    code,
  };
}

async function probeMailRuntime(baseUrl) {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "loven7-runtime-probe@example.invalid",
      password: "definitely-wrong",
    }),
  });
  const data = await readJsonResponse(response);
  const code = String(data?.error?.code || "");
  return {
    ok: response.status === 401 && code === "invalid_login",
    status: response.status,
    code,
  };
}

function skippedMailRuntime(reason, code) {
  return {
    ok: false,
    skipped: true,
    status: 0,
    code,
    reason,
  };
}

function runtimeHint(result) {
  if (result.code === "share_kv_not_configured") return "Bind SHARE_KV in this Webmail Pages environment, then redeploy.";
  if (result.code === "share_secret_not_configured") return "Set SHARE_ENCRYPTION_SECRET in this Webmail Pages environment, then redeploy.";
  if (result.code === "mail_worker_not_configured") return "Set MAIL_WORKER_BASE_URL in this Webmail Pages environment, then redeploy.";
  if (result.code === "upstream_error") return "Check MAIL_WORKER_BASE_URL, optional SITE_PASSWORD, and upstream Worker availability.";
  return "";
}

const webmailUrl = normalizeBaseUrl(
  argValue("--webmail-url") ||
    process.env.WEBMAIL_RUNTIME_URL ||
    process.env.WEBMAIL_PREVIEW_URL ||
    process.env.WEBMAIL_PAGES_URL ||
    ""
);

if (!webmailUrl) {
  console.error("Missing Webmail URL. Set WEBMAIL_RUNTIME_URL or pass --webmail-url https://webmail.example.com");
  process.exit(2);
}

const results = {
  checkedAt: new Date().toISOString(),
  html: await probeHtml(webmailUrl),
};

results.runtime = await probeRuntimeDiagnostics(webmailUrl);
results.shareRuntime = await probeShareRuntime(webmailUrl);

if (results.runtime.available && results.runtime.checks?.mailWorkerBaseUrl === false) {
  results.mailRuntime = skippedMailRuntime(
    "Skipped fake login probe because /api/runtime reports MAIL_WORKER_BASE_URL is missing.",
    "mail_worker_not_configured"
  );
} else {
  results.mailRuntime = await probeMailRuntime(webmailUrl);
}

const runtimeOk = results.runtime.available ? results.runtime.ok : true;
const mailOk = results.mailRuntime.skipped ? true : results.mailRuntime.ok;
results.ok = Boolean(results.html.ok && runtimeOk && results.shareRuntime.ok && mailOk);
results.hints = [
  ...(results.runtime.available ? results.runtime.hints : []),
  runtimeHint(results.shareRuntime),
  runtimeHint(results.mailRuntime),
].filter(Boolean);
results.hints = [...new Set(results.hints)];

console.log(JSON.stringify(results, null, 2));

if (!results.ok) process.exit(1);
