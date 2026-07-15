import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const projectDir = realpathSync(process.cwd());
const distDir = path.join(projectDir, 'dist-release');
const releaseDir = path.resolve(process.env.RELEASE_DIR || path.join(projectDir, 'release-cloudflare-pages'));
const zipName = process.env.RELEASE_ZIP_NAME || 'loven7-mail-admin-cloudflare-pages.zip';
const zipPath = path.join(releaseDir, zipName);
const readmePath = path.join(releaseDir, 'README-部署说明.txt');
const sumsPath = path.join(releaseDir, 'SHA256SUMS.txt');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return full;
  });
}

function readEnvValues() {
  const names = ['.env', '.env.local', '.env.production', '.env.production.local'];
  const values = [];
  for (const name of names) {
    const file = path.join(projectDir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
      if (!/(API|BASE|PASSWORD|PASS|TOKEN|SECRET|KEY|AUTH|EMAIL|MAIL|DOMAIN|HOST|URL)/i.test(key)) continue;
      const value = trimmed.slice(trimmed.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
      if (value.length >= 5) values.push(value);
    }
  }
  return values;
}

function scanSensitive() {
  const builtInPatterns = [
    'VITE_API_BASE=',
    'x-admin-auth:',
    'x-custom-auth:',
    'x-user-access-token:',
  ];
  const extra = (process.env.RELEASE_SENSITIVE_PATTERNS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const patterns = [...new Set([...builtInPatterns, ...readEnvValues(), ...extra])];
  const matches = [];
  for (const file of walk(distDir)) {
    const stat = statSync(file);
    if (stat.size > 3_000_000) continue;
    const content = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      if (pattern && content.includes(pattern)) {
        matches.push(`${path.relative(distDir, file)} contains "${pattern.slice(0, 24)}${pattern.length > 24 ? '…' : ''}"`);
      }
    }
  }
  if (matches.length) {
    throw new Error(`敏感信息扫描失败：\n${matches.join('\n')}`);
  }
}

function compressDist() {
  rmSync(zipPath, { force: true });
  if (process.platform === 'win32') {
    const command = [
      '$ErrorActionPreference="Stop";',
      `$src=${JSON.stringify(path.join(distDir, '*'))};`,
      `$dst=${JSON.stringify(zipPath)};`,
      'Compress-Archive -Path $src -DestinationPath $dst -Force;',
    ].join(' ');
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]);
  } else {
    run('zip', ['-qr', zipPath, '.'], { cwd: distDir });
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeReleaseDocs() {
  const readme = [
    'Loven7-Mail PWA Cloudflare Pages 直传部署包',
    '',
    '使用方法：',
    '1. 打开 Cloudflare Pages，选择 Direct Upload / 上传资产。',
    `2. 直接上传 ${zipName}；压缩包根目录已包含 index.html、assets/、_headers、_redirects、sw.js 等静态文件。`,
    '3. 首次打开后，在“管理员凭据”里填写你自己的 Worker API 地址和管理员密码。',
    '4. API 地址和凭据只会保存在当前浏览器本地缓存 / 同源 Cookie 镜像中；不需要重新打包。',
    '',
    '脱敏说明：',
    '- 构建使用 release mode 且强制 VITE_API_BASE 为空，不会内置任何个人 API。',
    '- 发布包不包含源码、node_modules、.env、Wrangler 状态或本地缓存。',
    '- 打包脚本会扫描当前 env 文件中的值和常见 token 前缀，发现疑似敏感信息会中止。',
    '',
    '适用条件：',
    '- 后端接口结构与 cloudflare_temp_email Worker 管理接口一致。',
    '- 若你绑定了自定义前端域名，请在系统设置里配置“前端登录链接前缀”。',
    '',
  ].join('\r\n');
  writeFileSync(readmePath, readme, 'utf8');
  writeFileSync(sumsPath, `${sha256(zipPath)}  ${zipName}\r\n`, 'utf8');
}

mkdirSync(releaseDir, { recursive: true });
rmSync(distDir, { recursive: true, force: true });
run(process.execPath, [path.join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--mode', 'release', '--outDir', 'dist-release', '--emptyOutDir'], {
  env: { ...process.env, VITE_API_BASE: '' },
});
scanSensitive();
compressDist();
writeReleaseDocs();

console.log(JSON.stringify({
  ok: true,
  releaseDir,
  zipPath,
  sha256: sha256(zipPath),
}, null, 2));
