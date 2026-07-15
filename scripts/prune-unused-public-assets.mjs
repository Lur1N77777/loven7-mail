import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRelative = String(process.argv[2] || "").replace(/\\/g, "/");
if (!/^apps\/(admin|webmail)$/.test(appRelative)) {
  throw new Error("Usage: node scripts/prune-unused-public-assets.mjs apps/admin|apps/webmail");
}

const appRoot = resolve(repoRoot, appRelative);
const publicRoot = resolve(appRoot, "public");
const distRoot = resolve(appRoot, "dist");
const largeAssetExtensions = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const minimumPruneBytes = 100 * 1024;

function filesUnder(root, shouldSkip = () => false) {
  if (!existsSync(root)) return [];
  const results = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (shouldSkip(path, entry)) continue;
    if (entry.isDirectory()) results.push(...filesUnder(path, shouldSkip));
    else if (entry.isFile()) results.push(path);
  }
  return results;
}

const sourceText = filesUnder(appRoot, (path, entry) => {
  if (!entry.isDirectory()) return false;
  return ["dist", "node_modules", "public"].includes(path.split(/[\\/]/).at(-1));
})
  .filter((path) => [".css", ".html", ".js", ".json", ".mjs", ".ts", ".tsx"].includes(extname(path)))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

let removedBytes = 0;
const removed = [];
for (const publicPath of filesUnder(publicRoot)) {
  const stats = statSync(publicPath);
  if (stats.size < minimumPruneBytes || !largeAssetExtensions.has(extname(publicPath).toLowerCase())) continue;
  const publicRelative = relative(publicRoot, publicPath).replace(/\\/g, "/");
  const filename = publicRelative.split("/").at(-1) || publicRelative;
  if (sourceText.includes(publicRelative) || sourceText.includes(filename)) continue;
  const distPath = resolve(distRoot, publicRelative);
  if (!existsSync(distPath)) continue;
  removedBytes += statSync(distPath).size;
  removed.push(publicRelative);
  rmSync(distPath, { force: true });
}

console.log(JSON.stringify({
  app: appRelative,
  removed,
  removedBytes,
  retainedSourceAssets: true,
}));
