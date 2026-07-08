#!/bin/sh
set -eu

APP_HOME="${RELAY_HOME:-/app}"
CODEX_HOME_DIR="${CODEX_HOME:-${APP_HOME}/data/codex-home}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"

log() {
  printf '[entrypoint] %s\n' "$*"
}

die() {
  printf '[entrypoint] Error: %s\n' "$*" >&2
  exit 1
}

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

require_env() {
  name="$1"
  value="$2"

  [ -n "${value}" ] || die "${name} is required when GITHUB_ENABLE=true"
}

ensure_git_safe_directory() {
  path="$1"

  if ! git config --global --add safe.directory "${path}" >/dev/null 2>&1; then
    die "Failed to configure git safe.directory for ${path}"
  fi
}

init_github() {
  if ! is_truthy "${GITHUB_ENABLE:-false}"; then
    log "GitHub integration disabled"
    return 0
  fi

  require_env "GITHUB_USERNAME" "${GITHUB_USERNAME:-}"
  require_env "GITHUB_EMAIL" "${GITHUB_EMAIL:-}"
  require_env "GITHUB_TOKEN_FILE" "${GITHUB_TOKEN_FILE:-}"

  [ -r "${GITHUB_TOKEN_FILE}" ] || die "GitHub token file not found or unreadable: ${GITHUB_TOKEN_FILE}"
  [ -s "${GITHUB_TOKEN_FILE}" ] || die "GitHub token file is empty: ${GITHUB_TOKEN_FILE}"

  GH_TOKEN="$(tr -d '\r\n' < "${GITHUB_TOKEN_FILE}")"
  [ -n "${GH_TOKEN}" ] || die "GitHub token file is empty: ${GITHUB_TOKEN_FILE}"
  export GH_TOKEN

  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    die "GitHub CLI authentication failed"
  fi

  if ! gh auth setup-git --hostname github.com --force >/dev/null 2>&1; then
    die "GitHub CLI git integration setup failed"
  fi

  if ! gh config set git_protocol https --host github.com >/dev/null 2>&1; then
    die "GitHub CLI git protocol setup failed"
  fi

  if ! git config --global user.name "${GITHUB_USERNAME}" >/dev/null 2>&1; then
    die "Failed to configure git user.name"
  fi

  if ! git config --global user.email "${GITHUB_EMAIL}" >/dev/null 2>&1; then
    die "Failed to configure git user.email"
  fi

  ensure_git_safe_directory "${WORKSPACE_DIR}"
  ensure_git_safe_directory "${WORKSPACE_DIR}/*"

  log "GitHub integration enabled for ${GITHUB_USERNAME}"
}

mkdir -p "${APP_HOME}/config"
mkdir -p "${APP_HOME}/data/tmp"
mkdir -p "${CODEX_HOME_DIR}"
mkdir -p "${WORKSPACE_DIR}"

init_github

exec "$@"
