import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const typescriptRoot = path.dirname(require.resolve('typescript/package.json'));
const tscEntry = path.join(typescriptRoot, 'bin', 'tsc');

function emittedPath(outDir, sourceRoot, sourcePath) {
  const relative = path.relative(sourceRoot, sourcePath).replace(/\.(?:cts|mts|tsx?|jsx?)$/i, '.js');
  return path.join(outDir, relative);
}

function normalizeRelativeSpecifier(specifier) {
  if (/\.(?:[cm]?js|json|node)$/i.test(specifier)) return specifier;
  if (/\.(?:cts|mts|tsx?|jsx?)$/i.test(specifier)) return specifier.replace(/\.(?:cts|mts|tsx?|jsx?)$/i, '.js');
  return `${specifier}.js`;
}

function patchRelativeImports(source) {
  const patch = (_match, before, specifier, after) => `${before}${normalizeRelativeSpecifier(specifier)}${after}`;
  return source
    .replace(/((?:from|import)\s*["'])(\.{1,2}\/[^"']+)(["'])/g, patch)
    .replace(/(import\s*\(\s*["'])(\.{1,2}\/[^"']+)(["'])/g, patch);
}

async function walkJavaScript(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkJavaScript(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

export async function compileTypeScriptFiles({ sourceRoot, rootFiles, outDir }) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedOutDir = path.resolve(outDir);
  const resolvedRootFiles = rootFiles.map((file) => path.resolve(file));
  await mkdir(resolvedOutDir, { recursive: true });

  try {
    await execFileAsync(process.execPath, [
      tscEntry,
      '--pretty', 'false',
      '--ignoreConfig',
      '--target', 'ES2022',
      '--module', 'ESNext',
      '--moduleResolution', 'Bundler',
      '--noCheck',
      '--skipLibCheck',
      '--rootDir', resolvedSourceRoot,
      '--outDir', resolvedOutDir,
      ...resolvedRootFiles,
    ], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const details = [error?.stdout, error?.stderr].filter(Boolean).join('\n').trim();
    throw new Error(details || error?.message || 'TypeScript compilation failed', { cause: error });
  }

  await writeFile(path.join(resolvedOutDir, 'package.json'), '{"type":"module"}\n', 'utf8');
  for (const outputPath of await walkJavaScript(resolvedOutDir)) {
    const source = await readFile(outputPath, 'utf8');
    const patched = patchRelativeImports(source);
    if (patched !== source) await writeFile(outputPath, patched, 'utf8');
  }
}

export async function importStandaloneTypeScriptModule(sourceUrl) {
  const sourcePath = fileURLToPath(sourceUrl);
  const sourceRoot = path.dirname(sourcePath);
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'loven7-typescript-module-'));
  const outDir = path.join(tempRoot, 'compiled');

  try {
    await compileTypeScriptFiles({ sourceRoot, rootFiles: [sourcePath], outDir });
    return await import(pathToFileURL(emittedPath(outDir, sourceRoot, sourcePath)).href);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
