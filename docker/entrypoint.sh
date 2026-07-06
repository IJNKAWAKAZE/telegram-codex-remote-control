#!/bin/sh
set -eu

mkdir -p /app/config
mkdir -p /app/data/tmp
mkdir -p /app/data/codex-home
mkdir -p /workspace

exec "$@"
