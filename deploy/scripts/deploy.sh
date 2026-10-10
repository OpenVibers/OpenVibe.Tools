#!/usr/bin/env bash
# OpenVibe.Tools deploy wrapper: ovhost deploy, rollback, or plan tools.
set -euo pipefail
OVHOST="${OVHOST:-/usr/local/bin/ovhost}"
if [ "${OVHOST_SUDO-auto}" = auto ]; then if [ "$(id -u)" -eq 0 ]; then SUDO=(); else SUDO=(sudo); fi; elif [ -n "${OVHOST_SUDO}" ]; then SUDO=("$OVHOST_SUDO"); else SUDO=(); fi
CMD=deploy
FLAGS=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --wait-idle|--restart|--force) FLAGS+=("$1"); shift ;;
        --rollback) CMD=rollback; shift ;;
        *) echo "Usage: $0 [--wait-idle] [--restart] [--force] [--rollback]   (DRY_RUN=1 for the plan)" >&2; exit 1 ;;
    esac
done
if ! command -v "$OVHOST" >/dev/null 2>&1; then
    echo "[tools-deploy] ovhost not found ($OVHOST)" >&2
    exit 1
fi
if [ "${DRY_RUN:-0}" = 1 ]; then exec "${SUDO[@]}" "$OVHOST" plan tools; fi
exec "${SUDO[@]}" "$OVHOST" "$CMD" tools "${FLAGS[@]}"
