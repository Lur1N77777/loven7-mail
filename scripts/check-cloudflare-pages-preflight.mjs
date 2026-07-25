import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readText(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function exists(relativePath) {
  return existsSync(resolve(repoRoot, relativePath));
}

function isGitTracked(relativePath) {
  const result = spawnSync(
    "git",
    ["ls-files", "--error-unmatch", relativePath],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) return null;
  return result.status === 0;
}

function hasAll(text, snippets) {
  return snippets.every((snippet) => text.includes(snippet));
}

function pagesProjectName(value, fallback) {
  return String(value || fallback || "").trim();
}

function envWasSet(name) {
  return (
    Object.prototype.hasOwnProperty.call(process.env, name) &&
    String(process.env[name] || "").trim() !== ""
  );
}

function validateProjectName(name, label, errors, warnings) {
  if (!name) {
    errors.push(`${label} is empty.`);
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/i.test(name)) {
    errors.push(
      `${label} must be 1-63 characters and start/end with a letter or number.`,
    );
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    warnings.push(
      `${label} should use lowercase letters, numbers, and hyphens only for Cloudflare Pages compatibility: ${name}`,
    );
  }
}

const errors = [];
const warnings = [];
const checked = [];

const requiredFiles = [
  "package.json",
  "apps/admin/package.json",
  "apps/admin/index.html",
  "apps/admin/public/theme-init.js",
  "apps/admin/public/_headers",
  "apps/admin/functions/api/image.ts",
  "apps/admin/src/index.css",
  "apps/admin/vite.config.ts",
  "apps/webmail/package.json",
  "apps/webmail/index.html",
  "apps/webmail/src/styles.css",
  "apps/admin/scripts/deploy-pages.mjs",
  "apps/webmail/scripts/deploy-pages.mjs",
  "apps/webmail/scripts/check-functions-headers.mjs",
  "apps/webmail/scripts/check-share-cors.mjs",
  "apps/webmail/scripts/check-image-proxy.mjs",
  "apps/webmail/functions/_lib/runtime.ts",
  "apps/webmail/functions/api/runtime.ts",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-cloudflare-pages.yml",
  "scripts/check-public-release.mjs",
  "scripts/check-cloudflare-runtime.mjs",
  "scripts/prune-unused-public-assets.mjs",
  "apps/admin/wrangler.toml",
  "docs/DEPLOYMENT_QUICKSTART.md",
  "docs/CLOUDFLARE_PAGES.md",
  "docs/GITHUB_ACTIONS.md",
  "docs/AGENT_DEPLOY_PROMPT.md",
  "docs/CONFIGURATION_BOUNDARY.md",
  "docs/VERSIONING.md",
  "CHANGELOG.md",
  ".env.example",
  "apps/webmail/.dev.vars.example",
];

for (const file of requiredFiles) {
  if (exists(file)) checked.push(file);
  else errors.push(`Missing required Cloudflare preflight file: ${file}`);
}

if (exists("apps/admin/index.html")) {
  const adminHtml = readText("apps/admin/index.html");
  if (!adminHtml.includes('<script src="/theme-init.js"></script>')) {
    errors.push("Admin index must load the CSP-safe external /theme-init.js before the app.");
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(adminHtml)) {
    errors.push("Admin index must not contain inline scripts blocked by the production CSP.");
  }
  if (/fonts\.(?:googleapis|gstatic)\.com/i.test(adminHtml)) {
    errors.push("Admin index must not depend on Google Fonts; production CSP only permits self-hosted fonts.");
  }
  if (/maximum-scale\s*=|user-scalable\s*=\s*no/i.test(adminHtml)) {
    errors.push("Admin viewport must preserve browser zoom for accessibility.");
  }
}

if (exists("apps/webmail/index.html")) {
  const webmailHtml = readText("apps/webmail/index.html");
  if (/rel=["']preload["'][^>]+loven7-portal-hero/i.test(webmailHtml)) {
    errors.push("Webmail must not preload the large login-only hero image for authenticated sessions.");
  }
}

for (const styleFile of [
  "apps/admin/src/index.css",
  "apps/webmail/src/styles.css",
]) {
  if (exists(styleFile) && /font-display\s*:\s*block/i.test(readText(styleFile))) {
    errors.push(`${styleFile} must use font-display: swap or optional so the brand never disappears while loading.`);
  }
}

if (exists("apps/admin/vite.config.ts")) {
  const adminVite = readText("apps/admin/vite.config.ts");
  if (/registerType:\s*["']autoUpdate["']/.test(adminVite)
    || /skipWaiting:\s*true/.test(adminVite)
    || /clientsClaim:\s*true/.test(adminVite)) {
    errors.push("Admin PWA must not force-activate a new service worker over clients still running old lazy chunks.");
  }
}

const ciReferencedScriptFiles = [
  "apps/webmail/scripts/check-functions-headers.mjs",
  "apps/webmail/scripts/check-share-cors.mjs",
  "apps/webmail/scripts/check-image-proxy.mjs",
  "scripts/check-cloudflare-pages-preflight.mjs",
  "scripts/check-public-release.mjs",
  "scripts/check-cloudflare-runtime.mjs",
  "apps/webmail/functions/_lib/runtime.ts",
  "apps/webmail/functions/api/runtime.ts",
];

for (const file of ciReferencedScriptFiles) {
  if (!exists(file)) continue;
  const tracked = isGitTracked(file);
  if (tracked === false) {
    warnings.push(
      `${file} exists locally but is not tracked by Git yet. Include it in the next commit, otherwise GitHub Actions will not have this script.`,
    );
  } else if (tracked === null) {
    warnings.push(
      `Could not verify whether ${file} is tracked by Git; ensure CI-referenced scripts are committed.`,
    );
  }
}

if (exists("package.json")) {
  const rootPackage = readJson("package.json");
  const scripts = rootPackage.scripts || {};
  for (const [name, expected] of Object.entries({
    "build:admin": "npm --prefix apps/admin run build",
    "build:webmail": "npm --prefix apps/webmail run build",
    build: "npm run build:admin && npm run build:webmail",
  })) {
    if (scripts[name] !== expected)
      errors.push(`Root package script "${name}" should be "${expected}".`);
  }
  if (!scripts["check:cloudflare"])
    warnings.push(
      'Root package is missing "check:cloudflare"; add it to make preflight easy to run locally and in CI.',
    );
  if (scripts["test:frontend"] !== "npm --prefix apps/admin test && npm --prefix apps/webmail test") {
    errors.push("Root package must expose both Admin and Webmail frontend regression tests.");
  }
  if (!String(scripts["check:release"] || "").includes("npm run test:frontend")) {
    errors.push("Release checks must run frontend regression tests before deployment.");
  }
  if (scripts["check:public"] !== "node scripts/check-public-release.mjs") {
    errors.push(
      'Root package must expose "check:public" as "node scripts/check-public-release.mjs".',
    );
  }
  if (!String(scripts["check:release"] || "").includes("npm run check:public")) {
    errors.push("Release checks must run the public privacy gate before deployment.");
  }
  if (
    scripts["check:cloudflare:runtime"] !==
    "node scripts/check-cloudflare-runtime.mjs"
  ) {
    warnings.push(
      'Root package should expose "check:cloudflare:runtime" as "node scripts/check-cloudflare-runtime.mjs" for post-deploy runtime probes.',
    );
  }
}

if (exists(".gitignore")) {
  const gitignore = readText(".gitignore");
  if (!gitignore.includes(".dev.vars"))
    warnings.push(
      ".gitignore should ignore .dev.vars so local Cloudflare runtime secrets are not committed.",
    );
}

if (exists("apps/admin/package.json")) {
  const adminPackage = readJson("apps/admin/package.json");
  const scripts = adminPackage.scripts || {};
  for (const name of ["build", "lint", "smoke:local"]) {
    if (!scripts[name])
      errors.push(`apps/admin/package.json is missing script "${name}".`);
  }
  if (!String(scripts.build || "").includes("prune-unused-public-assets.mjs")) {
    errors.push("Admin build must prune unreferenced large public assets from the deployment bundle.");
  }
}

if (exists("apps/webmail/package.json")) {
  const webmailPackage = readJson("apps/webmail/package.json");
  const scripts = webmailPackage.scripts || {};
  for (const name of [
    "build",
    "deploy",
    "check:functions:headers",
    "check:functions:cors",
    "check:functions:image",
    "smoke:local",
  ]) {
    if (!scripts[name])
      errors.push(`apps/webmail/package.json is missing script "${name}".`);
  }
  if (scripts.deploy && !scripts.deploy.includes("scripts/deploy-pages.mjs")) {
    errors.push(
      "apps/webmail deploy script should use scripts/deploy-pages.mjs so wrangler.toml handling stays consistent.",
    );
  }
  if (!String(scripts.build || "").includes("prune-unused-public-assets.mjs")) {
    errors.push("Webmail build must prune unreferenced large public assets from the deployment bundle.");
  }
}

if (exists("apps/webmail/scripts/deploy-pages.mjs")) {
  const deployScript = readText("apps/webmail/scripts/deploy-pages.mjs");
  if (!deployScript.includes("WEBMAIL_PAGES_PROJECT_NAME is required")) {
    errors.push(
      "Webmail deploy must require an explicit WEBMAIL_PAGES_PROJECT_NAME target.",
    );
  }
  if (deployScript.includes("DEFAULT_PROJECT_NAME") || deployScript.includes("EXPECTED_PROJECT_NAME")) {
    errors.push("Webmail deploy must not guess or pin a Pages project target.");
  }
  if (
    !hasAll(deployScript, [
      "WEBMAIL_USE_LOCAL_WRANGLER_CONFIG",
      "wrangler.toml",
      "pages deploy dist",
      "--project-name",
      "--branch",
    ])
  ) {
    errors.push(
      "deploy-pages.mjs should preserve Pages runtime bindings by ignoring local wrangler.toml unless explicitly opted in.",
    );
  }
  if (!deployScript.includes("npx --yes wrangler@4.86.0 pages deploy")) {
    errors.push(
      "deploy-pages.mjs should pin Wrangler 4.86.0 for reproducible non-interactive deployment.",
    );
  }
}

if (exists("apps/admin/scripts/deploy-pages.mjs")) {
  const deployScript = readText("apps/admin/scripts/deploy-pages.mjs");
  if (!deployScript.includes("ADMIN_PAGES_PROJECT_NAME is required")) {
    errors.push("Admin deploy must require an explicit ADMIN_PAGES_PROJECT_NAME target.");
  }
  if (deployScript.includes("DEFAULT_PROJECT_NAME") || deployScript.includes("EXPECTED_PROJECT_NAME")) {
    errors.push("Admin deploy must not guess or pin a Pages project target.");
  }
  if (
    !hasAll(deployScript, [
      "ADMIN_USE_LOCAL_WRANGLER_CONFIG",
      "wrangler.toml",
      "pages deploy dist",
      "--project-name",
      "--branch",
    ])
  ) {
    errors.push(
      "Admin deploy must ignore local wrangler.toml by default so Dashboard bindings are preserved.",
    );
  }
  if (!deployScript.includes("npx --yes wrangler@4.86.0 pages deploy")) {
    errors.push(
      "Admin deploy must pin Wrangler 4.86.0 for reproducible non-interactive deployment.",
    );
  }
}

for (const wranglerFile of [
  "apps/admin/wrangler.toml",
  "apps/webmail/wrangler.toml",
]) {
  if (!exists(wranglerFile)) continue;
  const wranglerText = readText(wranglerFile);
  const activeKvIds = [
    ...wranglerText.matchAll(/^\s*(?:id|preview_id)\s*=\s*["']([^"']+)["']/gm),
  ]
    .map((match) => match[1])
    .filter((value) => /^[a-f0-9]{32}$/i.test(value));
  if (activeKvIds.length) {
    errors.push(
      `${wranglerFile} contains real-looking KV Namespace IDs. Replace them with placeholders or keep the KV block commented before publishing.`,
    );
  }
}

if (exists(".github/workflows/deploy-cloudflare-pages.yml")) {
  const deployWorkflow = readText(
    ".github/workflows/deploy-cloudflare-pages.yml",
  );
  for (const snippet of [
    "ADMIN_PAGES_PROJECT_NAME",
    "WEBMAIL_PAGES_PROJECT_NAME",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "WEBMAIL_RUNTIME_URL",
    "workflow_run:",
    "workflows: [Build & Validate]",
    "github.event.workflow_run.conclusion == 'success'",
    "vars.AUTO_DEPLOY_PAGES == 'true'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
    "Validate Cloudflare deploy configuration",
    "github.event_name == 'workflow_dispatch'",
    "group: cloudflare-pages-production",
    "cancel-in-progress: false",
    "node scripts/deploy-pages.mjs",
    "npm run check:release",
    "npm run check:cloudflare:runtime",
  ]) {
    if (!deployWorkflow.includes(snippet))
      errors.push(`Deploy workflow missing expected snippet: ${snippet}`);
  }
  if (/^\s{2}push:\s*$/m.test(deployWorkflow)) {
    errors.push(
      "Deploy workflow must not run directly on push; it should wait for the Build & Validate workflow_run success event.",
    );
  }
  if (/group:\s*cloudflare-pages-.*(?:github\.sha|head_sha)/.test(deployWorkflow)) {
    errors.push(
      "Production Pages deployments must share one fixed concurrency group across different commits.",
    );
  }
  if (
    deployWorkflow.includes(
      'npx --yes wrangler@4.86.0 pages deploy dist --project-name "$ADMIN_PAGES_PROJECT_NAME"',
    )
  ) {
    errors.push(
      "Admin deployment must use its safe deploy wrapper instead of invoking Wrangler directly.",
    );
  }
}

if (exists(".github/workflows/ci.yml")) {
  const ciWorkflow = readText(".github/workflows/ci.yml");
  for (const snippet of [
    "npm run check:public",
    "npm run lint",
    "npm run check:webmail",
    "npm run test:frontend",
    "npm run build",
  ]) {
    if (!ciWorkflow.includes(snippet))
      errors.push(`CI workflow missing expected snippet: ${snippet}`);
  }
}

const envRequired = [
  "MAIL_WORKER_BASE_URL",
  "SITE_PASSWORD",
  "SHARE_ENCRYPTION_SECRET",
  "SHARE_ENCRYPTION_SECRET_V2",
  "SHARE_ADMIN_CORS_ORIGINS",
  "SHARE_PUBLIC_CORS_ORIGINS",
];

for (const envFile of [".env.example", "apps/webmail/.dev.vars.example"]) {
  if (!exists(envFile)) continue;
  const envText = readText(envFile);
  for (const name of envRequired) {
    if (!envText.includes(name)) errors.push(`${envFile} missing ${name}.`);
  }
  if (/SHARE_ADMIN_CORS_ORIGINS=["']?\*["']?/.test(envText)) {
    errors.push(`${envFile} must not use wildcard SHARE_ADMIN_CORS_ORIGINS.`);
  }
}

for (const docFile of ["docs/DEPLOYMENT_QUICKSTART.md", "apps/webmail/README.md"]) {
  if (exists(docFile) && !readText(docFile).includes("SHARE_ENCRYPTION_SECRET_V2")) {
    errors.push(`${docFile} should document the backward-compatible V2 share key rotation flow.`);
  }
}

for (const docFile of [
  "README.md",
  "docs/DEPLOYMENT_QUICKSTART.md",
  "docs/CLOUDFLARE_PAGES.md",
  "docs/GITHUB_ACTIONS.md",
  "apps/webmail/README.md",
]) {
  if (!exists(docFile)) continue;
  const text = readText(docFile);
  for (const snippet of [
    "SHARE_KV",
    "SHARE_ENCRYPTION_SECRET",
    "SHARE_ADMIN_CORS_ORIGINS",
    "MAIL_WORKER_BASE_URL",
  ]) {
    if (!text.includes(snippet))
      errors.push(`${docFile} should mention ${snippet}.`);
  }
}

for (const docFile of ["README.md", "docs/CLOUDFLARE_PAGES.md"]) {
  if (!exists(docFile)) continue;
  const text = readText(docFile);
  for (const snippet of [
    "Preview",
    "Production",
    "WEBMAIL_PREVIEW_RUNTIME_CONFIRMED",
  ]) {
    if (!text.includes(snippet))
      warnings.push(
        `${docFile} should mention ${snippet} so preview deployments do not silently miss runtime bindings.`,
      );
  }
  if (!text.includes("check:cloudflare:runtime")) {
    warnings.push(
      `${docFile} should mention npm run check:cloudflare:runtime so deployed Pages runtime can be probed without reading secrets.`,
    );
  }
  if (!text.includes("/api/runtime")) {
    warnings.push(
      `${docFile} should mention /api/runtime so deployed Pages runtime diagnostics are easy to verify without reading secrets.`,
    );
  }
  if (!/ADMIN_PAGES_PROJECT_NAME|WEBMAIL_PAGES_PROJECT_NAME/.test(text)) {
    warnings.push(
      `${docFile} should explain setting ADMIN_PAGES_PROJECT_NAME and WEBMAIL_PAGES_PROJECT_NAME when reusing existing Cloudflare Pages projects.`,
    );
  }
}

const adminProjectName = pagesProjectName(
  process.env.ADMIN_PAGES_PROJECT_NAME,
  "loven7-mail-admin",
);
const webmailProjectName = pagesProjectName(
  process.env.WEBMAIL_PAGES_PROJECT_NAME,
  "loven7-mail-webmail",
);
validateProjectName(
  adminProjectName,
  "ADMIN_PAGES_PROJECT_NAME",
  errors,
  warnings,
);
validateProjectName(
  webmailProjectName,
  "WEBMAIL_PAGES_PROJECT_NAME",
  errors,
  warnings,
);

if (!envWasSet("ADMIN_PAGES_PROJECT_NAME")) {
  warnings.push(
    "ADMIN_PAGES_PROJECT_NAME is not set; using the documentation default loven7-mail-admin. If you are reusing an existing Cloudflare Pages project, set ADMIN_PAGES_PROJECT_NAME explicitly before deploy.",
  );
}
if (!envWasSet("WEBMAIL_PAGES_PROJECT_NAME")) {
  warnings.push(
    "WEBMAIL_PAGES_PROJECT_NAME is not set; using the documentation default loven7-mail-webmail. If you are reusing an existing Cloudflare Pages project, set WEBMAIL_PAGES_PROJECT_NAME explicitly before deploy.",
  );
}

const branch = String(
  process.env.CF_PAGES_BRANCH || process.env.GITHUB_REF_NAME || "main",
).trim();
if (!/^[a-z0-9._/-]+$/i.test(branch))
  errors.push(
    `CF_PAGES_BRANCH/GITHUB_REF_NAME contains unsupported characters: ${branch}`,
  );
const isPreviewBranch = branch !== "main" && branch !== "production";

if (isPreviewBranch) {
  warnings.push(
    `CF_PAGES_BRANCH/GITHUB_REF_NAME is "${branch}". Cloudflare Pages preview deployments use independent preview runtime variables, secrets, and KV bindings; production MAIL_WORKER_BASE_URL, SHARE_ENCRYPTION_SECRET, and SHARE_KV do not automatically prove preview is configured.`,
  );
  if (process.env.WEBMAIL_PREVIEW_RUNTIME_CONFIRMED !== "1") {
    warnings.push(
      "Set WEBMAIL_PREVIEW_RUNTIME_CONFIRMED=1 only after confirming the Webmail preview environment has MAIL_WORKER_BASE_URL, optional SITE_PASSWORD, SHARE_ENCRYPTION_SECRET, SHARE_ADMIN_CORS_ORIGINS, and SHARE_KV binding configured.",
    );
  }
}

if (!process.env.CLOUDFLARE_API_TOKEN)
  warnings.push(
    "CLOUDFLARE_API_TOKEN is not set; local preflight can pass, but deploy will be skipped/fail until Cloudflare auth is configured.",
  );
if (!process.env.CLOUDFLARE_ACCOUNT_ID)
  warnings.push(
    "CLOUDFLARE_ACCOUNT_ID is not set; local preflight can pass, but deploy will be skipped/fail until Cloudflare account id is configured.",
  );
if (!exists("apps/admin/dist"))
  warnings.push(
    "apps/admin/dist does not exist yet; run npm --prefix apps/admin run build before manual Pages deploy.",
  );
if (!exists("apps/webmail/dist"))
  warnings.push(
    "apps/webmail/dist does not exist yet; run npm --prefix apps/webmail run build before manual Pages deploy.",
  );
if (exists("apps/webmail/wrangler.toml"))
  warnings.push(
    "apps/webmail/wrangler.toml exists; deploy-pages.mjs intentionally ignores it by default so Cloudflare Pages project bindings are preserved.",
  );

const result = {
  ok: errors.length === 0,
  checked,
  projects: {
    admin: adminProjectName,
    adminSource: envWasSet("ADMIN_PAGES_PROJECT_NAME") ? "env" : "default",
    webmail: webmailProjectName,
    webmailSource: envWasSet("WEBMAIL_PAGES_PROJECT_NAME") ? "env" : "default",
    branch,
    environment: isPreviewBranch ? "preview" : "production",
  },
  publicDefaults: {
    admin: "loven7-mail-admin",
    webmail: "loven7-mail-webmail",
    webmailRuntimeUrl: "https://webmail.example.com",
  },
  requiredWebmailRuntime: [
    "MAIL_WORKER_BASE_URL",
    "SHARE_ENCRYPTION_SECRET_V2 preferred; SHARE_ENCRYPTION_SECRET retained for legacy records",
    "SHARE_ADMIN_CORS_ORIGINS when Admin/Webmail are different origins",
    "SHARE_KV binding",
  ],
  previewRuntimeChecklist: isPreviewBranch
    ? [
        "Cloudflare Pages → Webmail project → Settings → Variables and Secrets → Preview: MAIL_WORKER_BASE_URL",
        "Cloudflare Pages → Webmail project → Settings → Variables and Secrets → Preview: SITE_PASSWORD when the upstream Worker requires it",
        "Cloudflare Pages → Webmail project → Settings → Variables and Secrets → Preview: SHARE_ENCRYPTION_SECRET",
        "Cloudflare Pages → Webmail project → Settings → Variables and Secrets → Preview: SHARE_ENCRYPTION_SECRET_V2 (preferred write key)",
        "Cloudflare Pages → Webmail project → Settings → Variables and Secrets → Preview: SHARE_ADMIN_CORS_ORIGINS when Admin/Webmail are different origins",
        "Cloudflare Pages → Webmail project → Settings → Bindings → Preview: KV namespace binding named SHARE_KV",
        "After changing preview runtime settings, redeploy the preview branch and probe /api/runtime first; fallback probes use /api/share/<missing-token> plus /api/session.",
      ]
    : [],
  warnings,
  errors,
};

console.log(JSON.stringify(result, null, 2));

if (errors.length) process.exit(1);
