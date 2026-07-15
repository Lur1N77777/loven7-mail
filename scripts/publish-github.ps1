param(
  [string]$RepoName = "loven7-mail-cloudflare-suite",
  [switch]$Private
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI gh is not installed. Install it first: https://cli.github.com/"
}
if (-not (Test-Path ".git")) {
  throw "Please run this script from the repository root."
}

Write-Host "Checking GitHub authentication..."
gh auth status | Out-Host

$visibility = if ($Private) { "--private" } else { "--public" }
$currentBranch = (git branch --show-current).Trim()
if (-not $currentBranch) { throw "Cannot determine current git branch." }

Write-Host "Creating GitHub repository: $RepoName ($visibility)"
try {
  gh repo create $RepoName $visibility --source . --remote origin --push
} catch {
  Write-Host "Repository creation may have failed or repository may already exist. Trying normal push..." -ForegroundColor Yellow
  if (-not (git remote get-url origin 2>$null)) {
    throw "No origin remote configured. If the repository already exists, run: git remote add origin <repo-url>"
  }
  git push -u origin $currentBranch
}

$repoUrl = (gh repo view --json url --jq .url).Trim()
Write-Host "Done: $repoUrl" -ForegroundColor Green
