#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}"
readonly DEFAULT_GUARD_FILE="${CONFIG_ROOT}/the-burrow/deploy-guard"
readonly GUARD_FILE="${BURROW_DEPLOY_GUARD_FILE:-${DEFAULT_GUARD_FILE}}"
readonly PASSWORD_VERSION="v1"
readonly PASSWORD_ITERATIONS="310000"
readonly MIN_PASSWORD_LENGTH=12

case "$GUARD_FILE" in
  "$SCRIPT_DIR"|"$SCRIPT_DIR"/*)
    printf 'deploy: password configuration must remain outside the repository\n' >&2
    exit 1
    ;;
esac

usage() {
  cat <<'EOF'
Usage:
  ./deploy.sh                    Authenticate, confirm, and deploy
  ./deploy.sh --set-password     Create or replace the deployment password
  ./deploy.sh --check-password   Verify the password without deploying
  ./deploy.sh -- [wrangler args] Authenticate and pass arguments to wrangler

The password is never stored. A salted PBKDF2 digest is kept outside the
repository in the user's configuration directory.
EOF
}

die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
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

password_digest() {
  local salt="$1"
  local iterations="$2"
  node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const password = fs.readFileSync(0);
    const salt = Buffer.from(process.argv[1], "hex");
    const iterations = Number(process.argv[2]);
    process.stdout.write(crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex"));
  ' "$salt" "$iterations"
}

constant_time_equal() {
  node -e '
    const crypto = require("node:crypto");
    const actual = Buffer.from(process.argv[1], "hex");
    const expected = Buffer.from(process.argv[2], "hex");
    const matches = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    process.exit(matches ? 0 : 1);
  ' "$1" "$2"
}

create_password() {
  local first
  local second
  local salt
  local digest
  local guard_dir
  local temporary_guard

  while true; do
    first="$(prompt_secret "Create deployment password (minimum ${MIN_PASSWORD_LENGTH} characters): ")"
    if (( ${#first} < MIN_PASSWORD_LENGTH )); then
      printf 'Password must contain at least %d characters.\n' "$MIN_PASSWORD_LENGTH" >&2
      continue
    fi
    second="$(prompt_secret 'Confirm deployment password: ')"
    if [[ "$first" != "$second" ]]; then
      printf 'Passwords did not match. Try again.\n' >&2
      continue
    fi
    break
  done

  salt="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
  digest="$(printf '%s' "$first" | password_digest "$salt" "$PASSWORD_ITERATIONS")"
  first=''
  second=''

  guard_dir="$(dirname -- "$GUARD_FILE")"
  umask 077
  mkdir -p -- "$guard_dir"
  temporary_guard="$(mktemp "${GUARD_FILE}.tmp.XXXXXX")"
  {
    printf '%s\n' "$PASSWORD_VERSION"
    printf '%s\n' "$PASSWORD_ITERATIONS"
    printf '%s\n' "$salt"
    printf '%s\n' "$digest"
  } >"$temporary_guard"
  chmod 600 "$temporary_guard"
  mv -f -- "$temporary_guard" "$GUARD_FILE"
  printf 'Deployment password configured outside the repository.\n'
}

verify_password() {
  local version
  local iterations
  local salt
  local expected
  local supplied
  local actual
  local attempt

  [[ -f "$GUARD_FILE" ]] || die "no deployment password configured; run ./deploy.sh --set-password"
  [[ ! -L "$GUARD_FILE" ]] || die "deployment password configuration cannot be a symbolic link"
  chmod 600 "$GUARD_FILE"
  version="$(sed -n '1p' "$GUARD_FILE")"
  iterations="$(sed -n '2p' "$GUARD_FILE")"
  salt="$(sed -n '3p' "$GUARD_FILE")"
  expected="$(sed -n '4p' "$GUARD_FILE")"

  [[ "$version" == "$PASSWORD_VERSION" ]] || die "unsupported deployment password format"
  [[ "$iterations" =~ ^[0-9]+$ ]] || die "invalid deployment password configuration"
  [[ "$salt" =~ ^[0-9a-f]{32}$ ]] || die "invalid deployment password configuration"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "invalid deployment password configuration"

  for attempt in 1 2 3; do
    supplied="$(prompt_secret 'Deployment password: ')"
    actual="$(printf '%s' "$supplied" | password_digest "$salt" "$iterations")"
    supplied=''
    if constant_time_equal "$actual" "$expected"; then
      actual=''
      return 0
    fi
    actual=''
    printf 'Incorrect password (%d/3).\n' "$attempt" >&2
  done

  die "authentication failed"
}

require_command node

case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  --set-password)
    if [[ -f "$GUARD_FILE" ]]; then
      verify_password
    fi
    create_password
    exit 0
    ;;
  --check-password)
    verify_password
    printf 'Deployment password verified.\n'
    exit 0
    ;;
  --)
    shift
    ;;
  '')
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if [[ ! -f "$GUARD_FILE" ]]; then
  printf 'No deployment password exists yet. Configure one before deploying.\n'
  create_password
  printf 'Password saved. Run pnpm run deploy again to deploy.\n'
  exit 0
fi

verify_password
require_command git
require_command pnpm

cd "$SCRIPT_DIR"
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || die "working tree is not clean; commit or remove local changes first"

readonly REVISION="$(git rev-parse --short HEAD)"
printf 'Authenticated. Deploy commit %s to Cloudflare? [y/N] ' "$REVISION" >/dev/tty
IFS= read -r confirmation </dev/tty
[[ "$confirmation" == 'y' || "$confirmation" == 'Y' ]] || die "deployment cancelled"

pnpm --filter @burrow/client build
pnpm --filter @burrow/edge exec wrangler deploy "$@"
