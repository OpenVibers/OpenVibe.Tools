#!/usr/bin/env bash
# OpenVibe.Tools — deploy: a thin wrapper around `ovhost deploy tools` (OpenVibe.Host, strategy multi-app;
# roadmap WS-N task 11; OpenVibe.Host docs/deploy-strategies.md).
#
# ovhost now does what this script did, as the checkout owner: untracked apps/*/package-lock.json files the
# release tracks are removed before the merge; npm install in each app whose lockfile or dependencies changed
# (apps/_* are packages, not apps); every dependency resolves (reinstalled once, else ABORT with nothing
# restarted); each app's data/ exists; the jobs runtime loads in img/audio/docs and the guard in every app;
# every openvibe-tools* unit restarts; the gateway answers /api/ready with Host: openvibe.tools and its
# /release.json names the new sha, every unit is active; the release is announced. New: a release that does
# not come up is rolled back (the checkout, its dependencies, a second restart; exit 3), and every attempt
# is in `ovhost releases tools`.
#
#   deploy/scripts/deploy.sh               ovhost deploy tools
#   deploy/scripts/deploy.sh --wait-idle   ovhost deploy tools --wait-idle   (hold until no tool job runs)
#   deploy/scripts/deploy.sh --restart     ovhost deploy tools --restart
#   deploy/scripts/deploy.sh --rollback    ovhost rollback tools
#   DRY_RUN=1 deploy/scripts/deploy.sh     ovhost plan tools
#
# ovhost runs as root (sudo is used when this runs as another user). Fallback: deploy-legacy.sh, the
# previous script unchanged, when ovhost is missing or too old (no `capabilities`, deploy-api < 1), or the
# host inventory does not deploy tools with strategy multi-app; OVHOST_LEGACY=1 forces it. The legacy
# script takes no flags: --rollback, --wait-idle and DRY_RUN=1 are refused rather than ignored there.
set -euo pipefail

SERVICE=tools
STRATEGY=multi-app
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LEGACY="${DEPLOY_LEGACY:-$HERE/deploy-legacy.sh}"
OVHOST="${OVHOST:-/usr/local/bin/ovhost}"
if [ "${OVHOST_SUDO-auto}" = auto ]; then if [ "$(id -u)" -eq 0 ]; then SUDO=(); else SUDO=(sudo); fi; elif [ -n "${OVHOST_SUDO}" ]; then SUDO=("$OVHOST_SUDO"); else SUDO=(); fi

CMD=deploy
FLAGS=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --wait-idle|--restart|--force) FLAGS+=("$1"); shift ;;
        --rollback) CMD=rollback; shift ;;
        --) shift; break ;;
        *) echo "Usage: $0 [--wait-idle] [--restart] [--force] [--rollback]   (DRY_RUN=1 for the plan)"; exit 1 ;;
    esac
done

legacy() {
    echo "[tools-deploy] $1 — running deploy-legacy.sh (the previous deploy script) instead"
    if [ "$CMD" = rollback ] || [ "${DRY_RUN:-0}" = 1 ] || [[ " ${FLAGS[*]:-} " == *" --wait-idle "* ]]; then
        echo "[tools-deploy] ✗ deploy-legacy.sh has no --rollback, --wait-idle or DRY_RUN; nothing was done" >&2
        exit 1
    fi
    exec bash "$LEGACY"
}

REASON=""
probe() {
    if [ "${OVHOST_LEGACY:-0}" = 1 ]; then REASON="OVHOST_LEGACY=1"; return 1; fi
    if ! command -v "$OVHOST" >/dev/null 2>&1; then REASON="ovhost not found ($OVHOST)"; return 1; fi
    local caps api
    if ! caps=$("${SUDO[@]}" "$OVHOST" capabilities "$SERVICE" 2>/dev/null); then REASON="this ovhost has no 'capabilities' (too old) or no inventory entry for $SERVICE"; return 1; fi
    api=$(printf '%s\n' "$caps" | sed -n 's/^deploy-api=//p')
    case "$api" in ''|*[!0-9]*) REASON="this ovhost reports no deploy-api (too old)"; return 1 ;; esac
    if [ "$api" -lt 1 ]; then REASON="this ovhost's deploy-api is $api, 1 is needed"; return 1; fi
    if ! printf '%s\n' "$caps" | grep -qx "strategy=$STRATEGY"; then REASON="the host inventory does not deploy $SERVICE with strategy $STRATEGY ($(printf '%s\n' "$caps" | sed -n 's/^strategy=//p'))"; return 1; fi
    if ! printf '%s\n' "$caps" | grep -qx "managed=yes"; then REASON="ovhost does not manage $SERVICE"; return 1; fi
    return 0
}

probe || legacy "$REASON"

if [ "${DRY_RUN:-0}" = 1 ]; then exec "${SUDO[@]}" "$OVHOST" plan "$SERVICE"; fi
echo "[tools-deploy] ovhost $CMD $SERVICE ${FLAGS[*]:-}"
exec "${SUDO[@]}" "$OVHOST" "$CMD" "$SERVICE" "${FLAGS[@]}"
