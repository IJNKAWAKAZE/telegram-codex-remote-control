#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"

FORCE="${FORCE:-0}"

ensure_repo_layout
require_bootstrap_os
install_docker_on_ubuntu
ensure_docker_files

if [ ! -f "${DOCKER_ENV_FILE}" ] || is_truthy "${FORCE}"; then
  write_docker_env_file "${FORCE}"
fi

write_relay_config_file "${FORCE}"

WORKSPACE_HOST_PATH="$(resolve_workspace_host_path)"
ensure_host_workspace "${WORKSPACE_HOST_PATH}"

compose_in_docker_dir up -d --build

log "Bootstrap completed."
log "Project root: ${PROJECT_ROOT}"
log "Workspace path: ${WORKSPACE_HOST_PATH}"
log "Skills path: ${DOCKER_DATA_DIR}/codex-home/skills"
