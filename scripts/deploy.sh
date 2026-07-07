#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"

FORCE_REBUILD="${FORCE_REBUILD:-0}"
PULL="${PULL:-0}"
RESTART_ONLY="${RESTART_ONLY:-0}"
BUILD_ARGS=()

ensure_repo_layout
ensure_docker_files
validate_runtime_files

WORKSPACE_HOST_PATH="$(resolve_workspace_host_path)"
[ -n "${WORKSPACE_HOST_PATH}" ] || die "WORKSPACE_HOST_PATH is empty"
[ -d "${WORKSPACE_HOST_PATH}" ] || die "Workspace path does not exist: ${WORKSPACE_HOST_PATH}"

if is_truthy "${RESTART_ONLY}"; then
  compose_in_docker_dir restart relay
  log "Service restarted."
  exit 0
fi

if is_truthy "${PULL}"; then
  BUILD_ARGS+=(--pull)
fi

if is_truthy "${FORCE_REBUILD}"; then
  BUILD_ARGS+=(--no-cache)
fi

if [ "${#BUILD_ARGS[@]}" -gt 0 ]; then
  compose_in_docker_dir build "${BUILD_ARGS[@]}" relay
  compose_in_docker_dir up -d
else
  compose_in_docker_dir up -d --build
fi

log "Deployment completed."
log "Workspace path: ${WORKSPACE_HOST_PATH}"
log "Skills path: ${DOCKER_DATA_DIR}/codex-home/skills"
