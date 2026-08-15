import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const errors = [];
const checked = [];

const requiredPublicFiles = [
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "deployment/upstream-lock.json",
  "docs/AGENT_DEPLOY_PROMPT.md",
  "docs/BEGINNER_GUIDE.md",
  "docs/CLOUDFLARE_DOMAIN_AND_EMAIL.md",
  "docs/INSTALLER.md",
  "docs/CONFIGURATION_BOUNDARY.md",
  "docs/DEPLOYMENT_QUICKSTART.md",
  "docs/VERSIONING.md",
];

const privateOnlyNamePatterns = [
  /audit.report/i,
  /change.baseline/i,
  /engineer.handoff/i,
  /operations.runbook/i,
  /optimization.report/i,
  /production.assets/i,
];

const publicSurfaceRoots = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  ".env.example",
  ".github",
  "deployment",
  "docs",
  "scripts",
  "apps",
];

const textExtensions = new Set([
  "",
  ".cjs",
  ".env",
  ".example",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".svg",
  ".yaml",
  ".yml",
]);

const allowedExternalHosts = new Set([
  "github.com",
  "api.github.com",
  "cli.github.com",
  "img.shields.io",
  "linux.do",
  "developers.cloudflare.com",
  "dash.cloudflare.com",
  "deploy.workers.cloudflare.com",
  "api.cloudflare.com",
  "cloudflare-dns.com",
  "challenges.cloudflare.com",
  "nodejs.org",
  "www.npmjs.com",
  "temp-mail-docs.awsl.uk",
  "semver.org",
  "www.w3.org",
]);

function normalized(path) {
  return path.replaceAll("\\", "/");
}

function walk(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    // Build tools create these directories locally. They are ignored by Git and
    // must not make a clean public source checkout fail its privacy gate.
    if (["node_modules", "dist", ".git", ".wrangler", "tmp"].includes(entry.name)) return [];
    if (entry.name === "package-lock.json") return [];
    return walk(join(path, entry.name));
  });
}

function isTextFile(path) {
  return textExtensions.has(extname(path).toLowerCase());
}

function isExampleHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return (
    isIP(host) !== 0 ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "example" ||
    host.endsWith(".example") ||
    host === "test" ||
    host.endsWith(".test") ||
    host === "invalid" ||
    host.endsWith(".invalid") ||
    host.endsWith(".localhost") ||
    host === "example.com" ||
    host.endsWith(".example.com") ||
    host === "example.org" ||
    host.endsWith(".example.org") ||
    host === "example.net" ||
    host.endsWith(".example.net") ||
    host === "example.workers.dev" ||
    host.endsWith(".example.workers.dev") ||
    host === "example.pages.dev" ||
    host.endsWith(".example.pages.dev")
  );
}

function findUrls(text) {
  return text.match(/https?:\/\/[^\s<>()"'`\]，。；：、]+/g) || [];
}

for (const file of requiredPublicFiles) {
  if (!existsSync(resolve(repoRoot, file))) {
    errors.push(`Missing public project file: ${file}`);
  }
}

for (const file of walk(resolve(repoRoot, "docs"))) {
  const relativePath = normalized(relative(repoRoot, file));
  if (privateOnlyNamePatterns.some((pattern) => pattern.test(relativePath))) {
    errors.push(`Private audit/operations artifact must not be published: ${relativePath}`);
  }
}

const files = [
  ...new Set(
    publicSurfaceRoots.flatMap((path) => walk(resolve(repoRoot, path))),
  ),
].filter(isTextFile);

for (const absolutePath of files) {
  const file = normalized(relative(repoRoot, absolutePath));
  const text = readFileSync(absolutePath, "utf8");
  const pathScanText = text.replaceAll("\\\\", "\\");
  checked.push(file);

  if (/\b[A-Za-z]:[\\/](?!Program Files(?: \(x86\))?[\\/])/i.test(pathScanText)) {
    errors.push(`${file} contains a local absolute Windows path.`);
  }
  if (/(?:^|[\s"'`])\/(?:Users|home)\/[A-Za-z0-9._-]+\//m.test(text)) {
    errors.push(`${file} contains a local absolute home path.`);
  }

  for (const rawUrl of findUrls(text)) {
    if (rawUrl.includes("${")) continue;
    let parsed;
    try {
      parsed = new URL(rawUrl.replace(/[.,;:]+$/, ""));
    } catch {
      continue;
    }
    const host = parsed.hostname.toLowerCase();
    if (!allowedExternalHosts.has(host) && !isExampleHost(host)) {
      errors.push(
        `${file} contains a non-public/non-example deployment URL host: ${host}`,
      );
    }
  }
}

const rootPackagePath = resolve(repoRoot, "package.json");
if (existsSync(rootPackagePath)) {
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
  if (rootPackage.name !== "loven7-mail") {
    errors.push("Root package name must use the independent Loven7 Mail project name.");
  }
  if (rootPackage.scripts?.["check:public"] !== "node scripts/check-public-release.mjs") {
    errors.push("package.json must expose check:public.");
  }
  if (!String(rootPackage.scripts?.["check:release"] || "").includes("check:public")) {
    errors.push("check:release must include the public-release privacy gate.");
  }
}

const adminPackagePath = resolve(repoRoot, "apps/admin/package.json");
if (existsSync(adminPackagePath)) {
  const adminPackage = JSON.parse(readFileSync(adminPackagePath, "utf8"));
  if (adminPackage.name !== "loven7-mail-admin") {
    errors.push("apps/admin package name must be the generic public name loven7-mail-admin.");
  }
}

for (const [file, requiredVariable] of [
  ["apps/admin/scripts/deploy-pages.mjs", "ADMIN_PAGES_PROJECT_NAME is required"],
  ["apps/webmail/scripts/deploy-pages.mjs", "WEBMAIL_PAGES_PROJECT_NAME is required"],
]) {
  const path = resolve(repoRoot, file);
  if (!existsSync(path)) continue;
  const source = readFileSync(path, "utf8");
  if (!source.includes(requiredVariable)) {
    errors.push(`${file} must require an explicit deployment target.`);
  }
  if (source.includes("DEFAULT_PROJECT_NAME") || source.includes("EXPECTED_PROJECT_NAME")) {
    errors.push(`${file} must not guess or pin a Pages deployment target.`);
  }
}

const deployWorkflowPath = resolve(
  repoRoot,
  ".github/workflows/deploy-cloudflare-pages.yml",
);
if (existsSync(deployWorkflowPath)) {
  const workflow = readFileSync(deployWorkflowPath, "utf8");
  if (!workflow.includes("vars.AUTO_DEPLOY_PAGES == 'true'")) {
    errors.push("Public Pages auto-deploy must be explicitly opt-in with AUTO_DEPLOY_PAGES=true.");
  }
  if (workflow.includes("github.repository ==")) {
    errors.push("Public deploy workflow must not contain a maintainer-specific repository condition.");
  }
}

const screenshotSourcePath = resolve(repoRoot, "scripts/capture-readme-screenshots.mjs");
if (existsSync(screenshotSourcePath)) {
  const source = readFileSync(screenshotSourcePath, "utf8");
  for (const marker of ["@loven7.test", "https://webmail.example.com"]) {
    if (!source.includes(marker)) {
      errors.push(`README screenshot mocks must use public-safe marker: ${marker}`);
    }
  }
}

const readmePath = resolve(repoRoot, "README.md");
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, "utf8");
  if (!readme.includes("# Loven7 Mail")) {
    errors.push("README must present Loven7 Mail as the independent project name.");
  }
  for (const guide of [
    "docs/BEGINNER_GUIDE.md",
    "docs/CLOUDFLARE_DOMAIN_AND_EMAIL.md",
  ]) {
    if (!readme.includes(guide)) errors.push(`README is missing beginner guide link: ${guide}`);
  }
  for (const heading of [
    "## 界面预览",
    "## 一条命令部署",
    "## 手动部署（已有 Worker）",
    "## 公开版与自用配置边界",
    "## 版本与升级",
  ]) {
    if (!readme.includes(heading)) errors.push(`README is missing section: ${heading}`);
  }

  const previewIndex = readme.indexOf("## 界面预览");
  const projectIndex = readme.indexOf("## 项目组成");
  if (previewIndex !== -1 && projectIndex !== -1 && previewIndex > projectIndex) {
    errors.push("README interface preview must appear before the project and deployment details.");
  }

  for (const mobileScreenshot of ["mobile-address-list.png", "mobile-address-actions.png"]) {
    const mobileScreenshotPath = `docs/screenshots/${mobileScreenshot}`;
    const mobileScreenshotTag = readme.match(new RegExp(`<img\\b[^>]*${mobileScreenshot.replace(".", "\\.")}[^>]*>`))?.[0];
    if (!existsSync(resolve(repoRoot, mobileScreenshotPath))) {
      errors.push(`README mobile screenshot asset is missing: ${mobileScreenshotPath}`);
    }
    if (!readme.includes(`<a href="${mobileScreenshotPath}">`)) {
      errors.push(`README mobile screenshot must link to its full-size asset: ${mobileScreenshotPath}`);
    }
    const mobileScreenshotHeight = mobileScreenshotTag?.match(/\bheight="(\d+)"/)?.[1];
    if (!mobileScreenshotHeight) {
      errors.push(`README mobile screenshot must declare a compact display height: ${mobileScreenshot}`);
    } else if (Number(mobileScreenshotHeight) > 420) {
      errors.push(`README mobile screenshot display height is too large: ${mobileScreenshot}`);
    }
  }
}

const promptPath = resolve(repoRoot, "docs/AGENT_DEPLOY_PROMPT.md");
if (existsSync(promptPath)) {
  const prompt = readFileSync(promptPath, "utf8");
  for (const requirement of [
    "不得输出密钥原文",
    "不得修改上游 Worker",
    "先检查，再执行",
    "停止并向用户报告",
    "验收清单",
    "回滚",
    "SHARE_KV",
    "SHARE_ENCRYPTION_SECRET",
    "/api/runtime",
  ]) {
    if (!prompt.includes(requirement)) {
      errors.push(`Agent deployment prompt is missing safety requirement: ${requirement}`);
    }
  }
  for (const requirement of [
    "连续执行与完成定义",
    "逐阶段重复询问",
    "按依赖顺序部署",
    "实际 Production origin",
  ]) {
    if (!prompt.includes(requirement)) {
      errors.push(`Agent deployment prompt is missing one-pass workflow requirement: ${requirement}`);
    }
  }
}

for (const [file, markers] of [
  ["docs/BEGINNER_GUIDE.md", [
    "```mermaid",
    "screenshots/admin-dashboard.png",
    "screenshots/webmail-login.png",
    "什么才算部署完成",
  ]],
  ["docs/CLOUDFLARE_DOMAIN_AND_EMAIL.md", [
    "把域名托管到 Cloudflare",
    "Compute → Email Service → Email Routing",
    "Send to a Worker",
    "```mermaid",
    "developers.cloudflare.com",
  ]],
]) {
  const path = resolve(repoRoot, file);
  if (!existsSync(path)) continue;
  const guide = readFileSync(path, "utf8");
  for (const marker of markers) {
    if (!guide.includes(marker)) errors.push(`${file} is missing required beginner-guide content: ${marker}`);
  }
}

const result = { ok: errors.length === 0, checkedFiles: checked.length, errors };
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exit(1);
