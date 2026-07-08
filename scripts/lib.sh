#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
DOCKER_DIR="${PROJECT_ROOT}/docker"
DOCKER_COMPOSE_EXAMPLE="${DOCKER_DIR}/docker-compose.example.yml"
DOCKER_COMPOSE_FILE="${DOCKER_DIR}/docker-compose.yml"
DOCKER_ENV_FILE="${DOCKER_DIR}/.env"
DOCKER_CONFIG_DIR="${DOCKER_DIR}/config"
DOCKER_DATA_DIR="${DOCKER_DIR}/data"
DOCKER_SECRETS_DIR="${DOCKER_DIR}/secrets"
RELAY_CONFIG_FILE="${DOCKER_CONFIG_DIR}/relay.config.json"

log() {
  printf '[deploy] %s\n' "$*"
}

warn() {
  printf '[deploy] Warning: %s\n' "$*" >&2
}

die() {
  printf '[deploy] Error: %s\n' "$*" >&2
  exit 1
}

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

json_escape() {
  printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

normalize_json_bool() {
  case "${1:-}" in
    true|TRUE|True|1|yes|YES|on|ON) printf 'true\n' ;;
    false|FALSE|False|0|no|NO|off|OFF) printf 'false\n' ;;
    *) die "Invalid boolean value: ${1:-<empty>}" ;;
  esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi

  require_command sudo
  sudo "$@"
}

docker_exec() {
  require_command docker

  if docker info >/dev/null 2>&1; then
    docker "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    sudo docker "$@"
    return
  fi

  die "Docker daemon is unavailable. Start Docker first or run bootstrap.sh."
}

compose_in_docker_dir() {
  (
    cd "${DOCKER_DIR}"
    docker_exec compose "$@"
  )
}

ensure_repo_layout() {
  [ -f "${PROJECT_ROOT}/package.json" ] || die "Not a relay project root: ${PROJECT_ROOT}"
  [ -f "${DOCKER_COMPOSE_EXAMPLE}" ] || die "Missing compose template: ${DOCKER_COMPOSE_EXAMPLE}"
  [ -f "${PROJECT_ROOT}/config/relay.config.docker.example.json" ] || die "Missing Docker config template"
}

ensure_compose_file() {
  if [ -f "${DOCKER_COMPOSE_FILE}" ]; then
    return
  fi

  cp "${DOCKER_COMPOSE_EXAMPLE}" "${DOCKER_COMPOSE_FILE}"
  log "Created ${DOCKER_COMPOSE_FILE}"
}

read_env_file_value() {
  local key="$1"
  local file="$2"

  [ -f "${file}" ] || return 1

  while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in
      ''|'#'*) continue ;;
      "${key}"=*)
        printf '%s\n' "${line#*=}"
        return 0
        ;;
    esac
  done < "${file}"

  return 1
}

resolve_workspace_host_path() {
  if [ -n "${WORKSPACE_HOST_PATH:-}" ]; then
    printf '%s\n' "${WORKSPACE_HOST_PATH}"
    return
  fi

  if read_env_file_value WORKSPACE_HOST_PATH "${DOCKER_ENV_FILE}" >/dev/null 2>&1; then
    read_env_file_value WORKSPACE_HOST_PATH "${DOCKER_ENV_FILE}"
    return
  fi

  printf '/srv/codex/workspace\n'
}

resolve_owner_user() {
  if [ -n "${SUDO_USER:-}" ]; then
    printf '%s\n' "${SUDO_USER}"
    return
  fi

  id -un
}

resolve_owner_group() {
  local user="$1"
  id -gn "${user}"
}

ensure_directory() {
  local dir="$1"
  mkdir -p "${dir}"
}

ensure_private_directory() {
  local dir="$1"
  mkdir -p "${dir}"
  chmod 700 "${dir}"
}

ensure_host_workspace() {
  local workspace_path="$1"
  local owner_user
  local owner_group

  owner_user="$(resolve_owner_user)"
  owner_group="$(resolve_owner_group "${owner_user}")"

  run_as_root mkdir -p "${workspace_path}"
  run_as_root chown "${owner_user}:${owner_group}" "${workspace_path}"
}

validate_reasoning_effort() {
  case "${1:-}" in
    minimal|low|medium|high|xhigh) ;;
    *) die "Unsupported reasoning effort: ${1:-<empty>}" ;;
  esac
}

validate_base_url() {
  case "${1:-}" in
    http://*|https://*) ;;
    *) die "BASE_URL must start with http:// or https://" ;;
  esac
}

validate_non_negative_integer() {
  case "${1:-}" in
    ''|*[!0-9]*) die "Expected a non-negative integer, got: ${1:-<empty>}" ;;
    *) ;;
  esac
}

write_docker_env_file() {
  local force="${1:-0}"
  local github_enable
  local github_username
  local github_email
  local github_token_file

  if [ -f "${DOCKER_ENV_FILE}" ] && ! is_truthy "${force}"; then
    log "Keeping existing ${DOCKER_ENV_FILE}"
    return
  fi

  : "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"
  : "${ALLOWED_TELEGRAM_USER_ID:?ALLOWED_TELEGRAM_USER_ID is required}"
  : "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"

  WORKSPACE_HOST_PATH="$(resolve_workspace_host_path)"
  github_enable="$(normalize_json_bool "${GITHUB_ENABLE:-false}")"
  github_username="${GITHUB_USERNAME:-}"
  github_email="${GITHUB_EMAIL:-}"
  github_token_file="${GITHUB_TOKEN_FILE:-/run/secrets/github_token}"

  cat > "${DOCKER_ENV_FILE}" <<EOF
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
ALLOWED_TELEGRAM_USER_ID=${ALLOWED_TELEGRAM_USER_ID}
OPENAI_API_KEY=${OPENAI_API_KEY}
WORKSPACE_HOST_PATH=${WORKSPACE_HOST_PATH}
GITHUB_ENABLE=${github_enable}
GITHUB_USERNAME=${github_username}
GITHUB_EMAIL=${github_email}
GITHUB_TOKEN_FILE=${github_token_file}
EOF

  log "Wrote ${DOCKER_ENV_FILE}"
}

write_relay_config_file() {
  local force="${1:-0}"
  local model
  local base_url
  local reasoning_effort
  local approval_policy
  local sandbox_mode
  local skip_git_repo_check
  local network_access_enabled
  local poll_timeout_seconds

  if [ -f "${RELAY_CONFIG_FILE}" ] && ! is_truthy "${force}"; then
    log "Keeping existing ${RELAY_CONFIG_FILE}"
    return
  fi

  model="${MODEL:-gpt-5.4}"
  base_url="${BASE_URL:-https://api.openai.com/v1}"
  reasoning_effort="${REASONING_EFFORT:-high}"
  approval_policy="${APPROVAL_POLICY:-never}"
  sandbox_mode="${SANDBOX_MODE:-danger-full-access}"
  skip_git_repo_check="$(normalize_json_bool "${SKIP_GIT_REPO_CHECK:-true}")"
  network_access_enabled="$(normalize_json_bool "${NETWORK_ACCESS_ENABLED:-true}")"
  poll_timeout_seconds="${POLL_TIMEOUT_SECONDS:-10}"

  validate_base_url "${base_url}"
  validate_reasoning_effort "${reasoning_effort}"
  validate_non_negative_integer "${poll_timeout_seconds}"

  cat > "${RELAY_CONFIG_FILE}" <<EOF
{
  "defaultCwd": "/workspace",
  "dataDir": "./data",
  "tempDir": "./data/tmp",
  "stateFile": "./data/state.json",
  "codexHome": "./data/codex-home",
  "telegram": {
    "pollTimeoutSeconds": ${poll_timeout_seconds}
  },
  "codex": {
    "baseUrl": "$(json_escape "${base_url}")",
    "provider": {
      "id": "relay_proxy",
      "name": "Relay Proxy",
      "envKey": "OPENAI_API_KEY",
      "wireApi": "responses",
      "supportsWebsockets": false
    },
    "model": "$(json_escape "${model}")",
    "reasoningEffort": "$(json_escape "${reasoning_effort}")",
    "approvalPolicy": "$(json_escape "${approval_policy}")",
    "sandboxMode": "$(json_escape "${sandbox_mode}")",
    "skipGitRepoCheck": ${skip_git_repo_check},
    "networkAccessEnabled": ${network_access_enabled}
  }
}
EOF

  log "Wrote ${RELAY_CONFIG_FILE}"
}

ensure_docker_files() {
  ensure_compose_file
  ensure_directory "${DOCKER_CONFIG_DIR}"
  ensure_directory "${DOCKER_DATA_DIR}"
  ensure_private_directory "${DOCKER_SECRETS_DIR}"
}

require_bootstrap_os() {
  [ -f /etc/os-release ] || die "bootstrap.sh currently supports Ubuntu only"
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || die "bootstrap.sh currently supports Ubuntu only"
}

install_docker_on_ubuntu() {
  log "Installing Docker packages"

  run_as_root apt-get update
  run_as_root apt-get install -y ca-certificates curl gnupg
  run_as_root install -m 0755 -d /etc/apt/keyrings

  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | run_as_root gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    run_as_root chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  local arch
  arch="$(dpkg --print-architecture)"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' "${arch}" "${VERSION_CODENAME}" | run_as_root tee /etc/apt/sources.list.d/docker.list >/dev/null

  run_as_root apt-get update
  run_as_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run_as_root systemctl enable --now docker

  if [ "$(id -u)" -ne 0 ] && ! id -nG "$(id -un)" | grep -qw docker; then
    run_as_root usermod -aG docker "$(id -un)"
    warn "Added $(id -un) to the docker group. A new login session may be required for passwordless docker commands."
  fi
}

validate_runtime_files() {
  [ -f "${DOCKER_ENV_FILE}" ] || die "Missing ${DOCKER_ENV_FILE}. Run scripts/bootstrap.sh first."
  [ -f "${RELAY_CONFIG_FILE}" ] || die "Missing ${RELAY_CONFIG_FILE}. Run scripts/bootstrap.sh first."
}
