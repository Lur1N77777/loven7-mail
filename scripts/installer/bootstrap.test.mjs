import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const bootstrap = readFileSync(resolve(rootDir, 'scripts/installer/bootstrap.ps1'), 'utf8');
const launcher = readFileSync(resolve(rootDir, 'scripts/installer/Install-Loven7-Mail.cmd'), 'utf8');
const workflow = readFileSync(resolve(rootDir, '.github/workflows/release-assets.yml'), 'utf8');

test('Windows launcher downloads the signed bootstrap from the latest release', () => {
  assert.match(launcher, /github\.com\/Lur1N77777\/loven7-mail\/releases\/latest/);
  assert.match(launcher, /releases\/latest\/download\/loven7-mail-bootstrap\.ps1/);
  assert.match(launcher, /Get-FileHash -Algorithm SHA256/);
  assert.match(launcher, /SHA256SUMS\.txt/);
  assert.match(launcher, /ExecutionPolicy Bypass/);
  assert.doesNotMatch(launcher, /CLOUDFLARE_API_TOKEN|ADMIN_PASSWORD|SITE_PASSWORD/);
});

test('Windows launcher passes PowerShell variables without escaping their sigils', () => {
  assert.doesNotMatch(
    launcher,
    /`\$(?:line|_|expected|actual|LASTEXITCODE)\b/,
    'cmd.exe does not expand PowerShell variables; a backtick here breaks PowerShell parsing',
  );
  for (const variable of ['$line', '$_', '$expected', '$actual', '$LASTEXITCODE']) {
    assert.ok(launcher.includes(variable), `launcher is missing ${variable}`);
  }
});

test('launcher and bootstrap isolate modules to the active PowerShell host', () => {
  const modulePathIsolation = "$env:PSModulePath = Join-Path $PSHOME 'Modules'";
  assert.ok(launcher.includes(modulePathIsolation));
  assert.ok(bootstrap.includes(modulePathIsolation));
});

test('bootstrap verifies the source archive before extraction and starts npm setup', () => {
  assert.match(bootstrap, /Lur1N77777\/loven7-mail/);
  assert.match(bootstrap, /loven7-mail-\$tag-source\.zip/);
  assert.match(bootstrap, /loven7-mail-cloudflare-suite-\$tag-source\.zip/);
  assert.match(bootstrap, /Get-FileHash -Algorithm SHA256/);
  assert.match(bootstrap, /Expand-Archive/);
  assert.match(bootstrap, /run setup/);
  assert.match(bootstrap, /wrangler official OAuth/i);
  assert.doesNotMatch(bootstrap, /ADMIN_PASSWORD|SITE_PASSWORD|CLOUDFLARE_API_TOKEN/);
});

test('release workflow publishes the launcher, bootstrap and checksums', () => {
  assert.match(workflow, /loven7-mail-\$\{tag\}-source\.zip/);
  assert.match(workflow, /loven7-mail-bootstrap\.ps1/);
  assert.match(workflow, /Install-Loven7-Mail\.cmd/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /gh release edit/);
  assert.match(workflow, /--notes-file release-assets\/RELEASE_NOTES\.md/);
  assert.match(workflow, /部署完成后还要做什么/);
  assert.match(workflow, /Compute → Email Service → Email Routing/);
  assert.match(workflow, /--title "Loven7 Mail \$\{tag#v\}"/);
});
