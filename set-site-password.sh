#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly MIN_PASSWORD_LENGTH=12
# Cloudflare Workers Web Crypto currently caps PBKDF2 at 100,000 iterations.
readonly PASSWORD_ITERATIONS=100000

die() {
  printf 'site-password: %s\n' "$*" >&2
  exit 1
}

prompt_secret() {
  local prompt="$1"
  local value
  [[ -t 0 ]] || die "an interactive terminal is required"
  printf '%s' "$prompt" >/dev/tty
  if ! IFS= read -r -s value </dev/tty; then
    printf '\n' >/dev/tty
    die "unable to read from the terminal"
  fi
  printf '\n' >/dev/tty
  printf '%s' "$value"
}

command -v node >/dev/null 2>&1 || die "required command not found: node"
command -v pnpm >/dev/null 2>&1 || die "required command not found: pnpm"

first="$(prompt_secret "New site password (minimum ${MIN_PASSWORD_LENGTH} characters): ")"
(( ${#first} >= MIN_PASSWORD_LENGTH )) || die "password must contain at least ${MIN_PASSWORD_LENGTH} characters"
second="$(prompt_secret 'Confirm site password: ')"
[[ "$first" == "$second" ]] || die "passwords did not match"
second=''

verifier="$(printf '%s' "$first" | node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const password = fs.readFileSync(0);
  const iterations = Number(process.argv[1]);
  const salt = crypto.randomBytes(16);
  const digest = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  process.stdout.write(`v1$${iterations}$${salt.toString("hex")}$${digest.toString("hex")}`);
' "$PASSWORD_ITERATIONS")"
first=''

cd "$SCRIPT_DIR"
printf '%s' "$verifier" | pnpm --filter @burrow/edge exec wrangler secret put SITE_PASSWORD_HASH
verifier=''
session_secret="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
printf '%s' "$session_secret" | pnpm --filter @burrow/edge exec wrangler secret put SITE_SESSION_SECRET
session_secret=''
printf 'Production site password updated in Cloudflare. Existing browser sessions were invalidated.\n'
