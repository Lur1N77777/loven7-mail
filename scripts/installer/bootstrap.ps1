param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $SetupArgs = @()
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = Join-Path $PSHOME 'Modules'

$Repository = 'Lur1N77777/loven7-mail'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Loven7Mail\installer'
$MinimumNodeMajor = 22

function Write-Step([string] $Message) {
  Write-Host "`n[$Message]" -ForegroundColor Cyan
}

function Invoke-Download([string] $Uri, [string] $Destination) {
  Write-Host "Download: $Uri"
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
}

function Get-Release {
  $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers @{ 'User-Agent' = 'loven7-mail-installer' }
  if (-not $release.tag_name -or $release.draft -or $release.prerelease) {
    throw 'No stable GitHub release is available. Try again later.'
  }
  if ($release.tag_name -notmatch '^v\d+\.\d+\.\d+$') {
    throw "Unsupported release tag: $($release.tag_name)"
  }
  return $release
}

function Get-NodeCommand {
  $candidate = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($candidate) {
    try {
      $version = (& $candidate.Source --version).Trim()
      if ($version -match '^v(\d+)\.') {
        $major = [int]$Matches[1]
        if ($major -ge $MinimumNodeMajor) {
          $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
          $npmPath = if ($npmCommand) { $npmCommand.Source } else { Join-Path (Split-Path $candidate.Source) 'npm.cmd' }
          if (-not (Test-Path -LiteralPath $npmPath)) { throw 'Node.js 22 was found, but npm.cmd is missing.' }
          return @{ Node = $candidate.Source; Npm = $npmPath }
        }
      }
    } catch {
      # Fall through to the private portable Node.js runtime.
    }
  }

  Write-Step 'Preparing Node.js 22'
  $index = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json'
  $entry = @($index | Where-Object { $_.version -match '^v22\.' } | Select-Object -First 1)[0]
  if (-not $entry) { throw 'The official Node.js 22 Windows build was not found.' }
  $nodeVersion = $entry.version
  $nodeDir = Join-Path $InstallRoot "node-$nodeVersion-win-x64"
  $nodeExe = Join-Path $nodeDir 'node.exe'
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    $tempZip = Join-Path ([System.IO.Path]::GetTempPath()) "loven7-node-$nodeVersion.zip"
    $url = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
    Invoke-Download $url $tempZip
    $tempExtract = Join-Path ([System.IO.Path]::GetTempPath()) "loven7-node-$([guid]::NewGuid().ToString('N'))"
    try {
      Expand-Archive -LiteralPath $tempZip -DestinationPath $tempExtract -Force
      $extracted = Join-Path $tempExtract "node-$nodeVersion-win-x64"
      if (-not (Test-Path -LiteralPath (Join-Path $extracted 'node.exe'))) { throw 'The Node.js archive is incomplete.' }
      New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
      Move-Item -LiteralPath $extracted -Destination $nodeDir -Force
    } finally {
      Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  $env:Path = "$nodeDir;$env:Path"
  return @{ Node = $nodeExe; Npm = (Join-Path $nodeDir 'npm.cmd') }
}

function Ensure-Git {
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($git) { return $git.Source }

  Write-Step 'Preparing portable Git'
  $release = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'loven7-mail-installer' }
  $asset = @($release.assets | Where-Object { $_.name -match '^MinGit-.*-64-bit\.zip$' } | Select-Object -First 1)[0]
  if (-not $asset) { throw 'The official portable Git Windows build was not found.' }
  $gitRoot = Join-Path $InstallRoot 'git'
  $gitExe = Join-Path $gitRoot 'cmd\git.exe'
  if (-not (Test-Path -LiteralPath $gitExe)) {
    $tempZip = Join-Path ([System.IO.Path]::GetTempPath()) 'loven7-git.zip'
    try {
      Invoke-Download $asset.browser_download_url $tempZip
      New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
      if (Test-Path -LiteralPath $gitRoot) { Remove-Item -LiteralPath $gitRoot -Recurse -Force }
      Expand-Archive -LiteralPath $tempZip -DestinationPath $gitRoot -Force
    } finally {
      Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not (Test-Path -LiteralPath $gitExe)) { throw 'Portable Git was downloaded but git.exe is missing.' }
  $env:Path = "$(Split-Path $gitExe);$env:Path"
  return $gitExe
}

function Get-SourceRoot($release) {
  Write-Step 'Preparing Loven7 Mail files'
  New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
  $tag = [string]$release.tag_name
  $assetNames = @(
    "loven7-mail-$tag-source.zip",
    "loven7-mail-cloudflare-suite-$tag-source.zip"
  )
  $asset = $null
  foreach ($candidateName in $assetNames) {
    $asset = @($release.assets | Where-Object { $_.name -eq $candidateName })[0]
    if ($asset) { break }
  }
  $checksums = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' })[0]
  if (-not $asset -or -not $checksums) { throw "Release $tag is missing the verified installer assets." }
  $assetName = [string]$asset.name

  $versionRoot = Join-Path $InstallRoot $tag
  $sourceRoot = Join-Path $versionRoot "loven7-mail-$tag"
  $marker = Join-Path $versionRoot 'source.sha256'
  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "loven7-source-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  try {
    $zipPath = Join-Path $tempRoot $assetName
    $checksumsPath = Join-Path $tempRoot 'SHA256SUMS.txt'
    Invoke-Download $asset.browser_download_url $zipPath
    Invoke-Download $checksums.browser_download_url $checksumsPath
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
    $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match [regex]::Escape($assetName) } | Select-Object -First 1
    if (-not $checksumLine) { throw 'The release checksum file does not contain the source archive hash.' }
    $expectedHash = ($checksumLine -split '\s+')[0].ToLowerInvariant()
    if ($expectedHash -notmatch '^[0-9a-f]{64}$' -or $expectedHash -ne $actualHash) { throw 'Source archive SHA-256 verification failed.' }

    $knownHash = if (Test-Path -LiteralPath $marker) { (Get-Content -Raw -LiteralPath $marker).Trim() } else { '' }
    if ($knownHash -eq $actualHash -and (Test-Path -LiteralPath (Join-Path $sourceRoot 'package.json'))) {
      return $sourceRoot
    }

    $extractRoot = Join-Path $tempRoot 'extracted'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
    $candidate = Get-ChildItem -LiteralPath $extractRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') } | Select-Object -First 1
    if (-not $candidate) { throw 'The source archive does not contain a Loven7 Mail project root.' }
    if (Test-Path -LiteralPath $versionRoot) { Remove-Item -LiteralPath $versionRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $versionRoot -Force | Out-Null
    Move-Item -LiteralPath $candidate.FullName -Destination $sourceRoot
    Set-Content -LiteralPath $marker -Value $actualHash -NoNewline
    return $sourceRoot
  } finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Write-Host 'Loven7 Mail one-click installer' -ForegroundColor Green
  Write-Host 'It downloads a SHA-256 verified release and uses Wrangler official OAuth for Cloudflare.'
  $release = Get-Release
  $node = Get-NodeCommand
  if ($SetupArgs -contains '--new-worker') {
    Ensure-Git | Out-Null
  }
  $sourceRoot = Get-SourceRoot $release
  Write-Step 'Starting Cloudflare installer'
  Push-Location $sourceRoot
  try {
    & $node.Npm run setup @SetupArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    Pop-Location
  }
} catch {
  Write-Host "`nInstall failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Fix the issue and double-click the installer again. Downloaded files and checkpoints are kept.' -ForegroundColor Yellow
  exit 1
}
