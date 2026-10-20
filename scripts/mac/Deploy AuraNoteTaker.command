#!/bin/bash
# Deploy AuraNoteTaker: double-click to put the latest version from GitHub live on Base44.
#
# What it does: downloads the latest code from GitHub (read-only), checks it, and deploys it to the
# AuraNoteTaker app in Base44 using this Mac's Base44 sign-in. It changes nothing in Dentally.
#
# First run only: it asks for a GitHub read-only token and keeps it in the Mac's Keychain (never in a file).
set -euo pipefail

REPO="hishamsaqib-create/auranotetaker-pro"
APP_ID="6ad7288395750d0c318dc063"
DIR="$HOME/AuraNoteTaker"
KEYCHAIN_SERVICE="auranotetaker-github-read"

finish() {
  echo
  read -n 1 -s -r -p "Press any key to close this window."
  echo
}
trap finish EXIT

echo "AuraNoteTaker deploy"
echo "--------------------"

TOKEN=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
  echo "First time: paste your GitHub read-only token for auranotetaker-pro, then press Enter."
  echo "(Nothing will show as you paste. It is saved in your Keychain, not in a file.)"
  read -rs TOKEN
  echo
  security add-generic-password -s "$KEYCHAIN_SERVICE" -a github -w "$TOKEN" -U
fi

TMP=$(mktemp -d)
echo "1/4 Downloading the latest version from GitHub…"
if ! curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/tarball/main" -o "$TMP/src.tgz"; then
  echo "Could not download from GitHub. The token may have expired: it will be asked for again next time."
  security delete-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1 || true
  exit 1
fi
tar xzf "$TMP/src.tgz" -C "$TMP"
SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)
mkdir -p "$DIR"
rsync -a --delete --exclude node_modules --exclude dist --exclude 'base44/.app.jsonc' "$SRC/" "$DIR/"
rm -rf "$TMP"
cd "$DIR"
printf '{ "id": "%s" }\n' "$APP_ID" > base44/.app.jsonc

echo "2/4 Installing…"
npm ci --no-audit --no-fund --loglevel=error

echo "3/4 Checking and building…"
npm run --silent check:shared
npm run --silent build

echo "4/4 Deploying to Base44…"
if ! npx --yes base44@0.1.33 whoami >/dev/null 2>&1; then
  echo "Signing in to Base44 first (a browser window will open)…"
  npx --yes base44@0.1.33 login
fi
npx --yes base44@0.1.33 deploy -y

echo
echo "Done. AuraNoteTaker is up to date. Refresh it in your browser."
