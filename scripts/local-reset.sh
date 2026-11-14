#!/usr/bin/env bash
# Wipe the LOCAL dev database + files and re-apply migrations (never touches Cloudflare).
set -euo pipefail
rm -rf .wrangler/state
npx wrangler d1 migrations apply practice-app-db --local
