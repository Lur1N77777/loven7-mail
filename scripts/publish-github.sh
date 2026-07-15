#!/usr/bin/env bash
set -euo pipefail

REPO_NAME="${1:-loven7-mail-cloudflare-suite}"
VISIBILITY="${VISIBILITY:---public}"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI gh is not installed. Install it first: https://cli.github.com/" >&2
  exit 1
fi
if [ ! -d .git ]; then
  echo "Please run this script from the repository root." >&2
  exit 1
fi

echo "Checking GitHub authentication..."
gh auth status

BRANCH="$(git branch --show-current)"
if [ -z "$BRANCH" ]; then
  echo "Cannot determine current git branch." >&2
  exit 1
fi

echo "Creating GitHub repository: $REPO_NAME ($VISIBILITY)"
if ! gh repo create "$REPO_NAME" "$VISIBILITY" --source . --remote origin --push; then
  echo "Repository creation may have failed or repository may already exist. Trying normal push..." >&2
  git remote get-url origin >/dev/null
  git push -u origin "$BRANCH"
fi

gh repo view --json url --jq .url
