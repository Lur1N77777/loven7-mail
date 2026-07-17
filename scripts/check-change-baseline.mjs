import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function toRepoPath(path) {
  return path.replace(/\\/g, "/");
}

function readText(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function fileExists(path) {
  return existsSync(resolve(repoRoot, path));
}

function changedFiles() {
  const tracked = git(["diff", "--name-only"])
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked].map(toRepoPath))].sort();
}

const groupRules = [
  {
    name: "releaseBaseline",
    label: "仓库卫生和发布基线",
    test: (path) =>
      path === ".gitattributes" ||
      path === ".gitignore" ||
      path === "package.json" ||
      path === ".github/workflows/deploy-cloudflare-pages.yml" ||
      path === "scripts/check-cloudflare-pages-preflight.mjs" ||
      path === "scripts/check-change-baseline.mjs" ||
      path === "apps/admin/wrangler.toml" ||
      [
        "docs/OPERATIONS_RUNBOOK.md",
        "docs/GITHUB_ACTIONS.md",
        "docs/CLOUDFLARE_PAGES.md",
        "docs/PROJECT_STRUCTURE.md",
        "docs/PROJECT_OPTIMIZATION_REPORT.md",
        "docs/CHANGE_BASELINE_PLAN.md",
      ].includes(path),
  },
  {
    name: "adminIdentity",
    label: "管理后台服务端代理和账号体系",
    test: (path) =>
      path.startsWith("apps/admin/functions/") ||
      [
        "apps/admin/src/components/BackendLogin.tsx",
        "apps/admin/src/lib/userAuth.ts",
        "apps/admin/src/views/AccountConsole.tsx",
        "apps/admin/src/lib/storage.ts",
        "apps/admin/src/lib/constants.ts",
        "apps/admin/src/lib/api.ts",
        "apps/admin/src/App.tsx",
        "apps/admin/src/components/AuthPanel.tsx",
        "apps/admin/README.md",
      ].includes(path),
  },
  {
    name: "webmailUserShare",
    label: "Webmail 用户能力和分享用户接口",
    test: (path) =>
      path.startsWith("apps/webmail/functions/api/user/") ||
      path.startsWith("apps/webmail/functions/api/share/user/") ||
      [
        "apps/webmail/functions/_lib/user.ts",
        "apps/webmail/functions/_lib/shareUser.ts",
        "apps/webmail/functions/_lib/http.ts",
        "apps/webmail/functions/_lib/share.ts",
        "apps/webmail/functions/api/share/index.ts",
        "apps/webmail/scripts/check-share-cors.mjs",
        "apps/webmail/src/api.ts",
        "apps/webmail/src/auth.ts",
        "apps/webmail/src/types.ts",
        "apps/webmail/src/App.tsx",
        "apps/webmail/src/vite-env.d.ts",
        "apps/webmail/wrangler.toml",
      ].includes(path),
  },
  {
    name: "visualAssets",
    label: "视觉资产和登录体验",
    test: (path) =>
      path.startsWith("apps/admin/public/") ||
      path.startsWith("apps/webmail/public/") ||
      [
        "apps/admin/preview-login.png",
        "apps/admin/index.html",
        "apps/webmail/index.html",
        "apps/admin/src/index.css",
        "apps/webmail/src/styles.css",
        "apps/admin/src/components/BrandIcons.tsx",
        "apps/admin/src/components/Shell.tsx",
        "apps/admin/vite.config.ts",
        "apps/webmail/public/_headers",
        "apps/admin/public/_headers",
      ].includes(path),
  },
  {
    name: "productDocs",
    label: "文档和 README 截图",
    test: (path) =>
      [
        "README.md",
        "docs/ENGINEER_HANDOFF.md",
        "docs/SECURITY_DESENSITIZATION.md",
      ].includes(path),
  },
  {
    name: "adminFeatureWork",
    label: "后台页面和功能改动",
    test: (path) =>
      [
        "apps/admin/src/views/AddressView.tsx",
        "apps/admin/src/views/MailWorkspace.tsx",
        "apps/admin/src/views/UsersView.tsx",
      ].includes(path),
  },
];

function classify(path) {
  return groupRules.find((group) => group.test(path)) || null;
}

const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".toml",
  ".yml",
  ".yaml",
]);

const binaryExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".zip",
]);

function allReferenceText() {
  const tracked = git(["ls-files"])
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const extra = git(["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([...tracked, ...extra].map(toRepoPath))]
    .filter((path) => textExtensions.has(extname(path).toLowerCase()))
    .map((path) => {
      try {
        return readText(path);
      } catch {
        return "";
      }
    })
    .join("\n");
}

function largeUnreferencedAssets(files) {
  const referenceText = allReferenceText();
  return files
    .filter((path) => binaryExtensions.has(extname(path).toLowerCase()))
    .filter(
      (path) =>
        path.startsWith("apps/admin/public/") ||
        path.startsWith("apps/webmail/public/") ||
        path === "apps/admin/preview-login.png",
    )
    .map((path) => {
      const absolute = resolve(repoRoot, path);
      const sizeKb = statSync(absolute).size / 1024;
      const basename = path.split("/").pop() || path;
      return {
        path,
        sizeKb: Math.round(sizeKb * 10) / 10,
        referenced: referenceText.includes(basename),
      };
    })
    .filter((asset) => asset.sizeKb >= 1024 && !asset.referenced)
    .sort((a, b) => b.sizeKb - a.sizeKb);
}

function requiredText(path, snippets) {
  if (!fileExists(path)) return [`Missing required baseline file: ${path}`];
  const text = readText(path);
  return snippets
    .filter((snippet) => !text.includes(snippet))
    .map((snippet) => `${path} should mention ${snippet}.`);
}

const files = changedFiles();
const groups = Object.fromEntries(
  groupRules.map((group) => [group.name, { label: group.label, files: [] }]),
);
const unclassified = [];

for (const file of files) {
  const group = classify(file);
  if (group) groups[group.name].files.push(file);
  else unclassified.push(file);
}

const errors = [];
const warnings = [];

for (const message of requiredText(".gitattributes", [
  "* text=auto eol=lf",
  "*.png binary",
  "*.woff2 binary",
]))
  errors.push(message);
for (const message of requiredText("docs/CHANGE_BASELINE_PLAN.md", [
  "推荐提交顺序",
  "仓库卫生和发布基线",
  "管理后台服务端代理和账号体系",
]))
  errors.push(message);
for (const message of requiredText("docs/OPERATIONS_RUNBOOK.md", [
  "loven7-mail-pwa",
  "cloudmail-webmail",
  "Rollback to this deployment",
]))
  errors.push(message);

if (unclassified.length) {
  warnings.push(`Unclassified changed files: ${unclassified.join(", ")}`);
}

const largeAssets = largeUnreferencedAssets(files);
if (largeAssets.length) {
  warnings.push(
    `Large public assets without direct filename references: ${largeAssets.map((asset) => `${asset.path} (${asset.sizeKb} KB)`).join(", ")}`,
  );
}

const result = {
  ok: errors.length === 0,
  changedFileCount: files.length,
  groups: Object.fromEntries(
    Object.entries(groups).map(([name, group]) => [
      name,
      {
        label: group.label,
        count: group.files.length,
        files: group.files,
      },
    ]),
  ),
  unclassified,
  largeUnreferencedAssets: largeAssets,
  warnings,
  errors,
};

console.log(JSON.stringify(result, null, 2));

if (errors.length) process.exit(1);
