#!/usr/bin/env bash
# Deploy OpenVibe.Tools on the host: pull, install dependencies in each app whose package.json
# changed (that includes a new openvibe-shared release tag), restart the units, check health, then
# announce the release to open tabs (`ovhost announce tools`; best effort, never fails the deploy).
set -euo pipefail
cd "$(dirname "$0")/../.."
BEFORE=$(git rev-parse HEAD)
# npm leaves untracked lockfiles in apps that did not track one; once the repo starts tracking it,
# `git pull` refuses to overwrite it. Those files are generated, so remove exactly those before pulling.
git fetch -q origin
for f in $(git diff --name-only HEAD "origin/$(git rev-parse --abbrev-ref HEAD)" -- 'apps/*/package-lock.json'); do
  if [ -f "$f" ] && ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then echo "removing untracked $f (the release tracks it)"; rm -f "$f"; fi
done
git pull -q --ff-only; AFTER=$(git rev-parse HEAD)
for app in apps/*/; do
  case "$app" in apps/_*) continue ;; esac   # apps/_shared is a package the apps require, not an app
  [ -f "$app/package.json" ] || continue
  if git diff --name-only "$BEFORE" "$AFTER" -- "$app/package.json" | grep -q . || [ ! -d "$app/node_modules" ]; then (cd "$app" && npm install --omit=dev --no-audit --no-fund --loglevel=error); fi
done
# Every app must resolve its dependencies before anything restarts. A dependency that used to be a
# file: link can leave an empty directory npm treats as installed (2026-09-23: vendor/openvibe-shared
# kept an untracked lockfile, every unit crash-looped on 'openvibe-shared/brand'); reinstall those.
for app in apps/*/; do
  case "$app" in apps/_*) continue ;; esac   # apps/_shared is a package the apps require, not an app
  [ -f "$app/package.json" ] || continue
  for dep in $(node -e 'console.log(Object.keys(require("./"+process.argv[1]+"package.json").dependencies||{}).join(" "))' "$app"); do
    if [ ! -f "$app/node_modules/$dep/package.json" ]; then
      echo "reinstalling $dep in $app (missing package.json)"; rm -rf "$app/node_modules/$dep"
      (cd "$app" && npm install --omit=dev --no-audit --no-fund --loglevel=error)
      [ -f "$app/node_modules/$dep/package.json" ] || { echo "ABORT: $app cannot resolve $dep; nothing restarted" >&2; exit 1; }
    fi
  done
done
# Apps that run jobs (apps/_shared/jobs, required by relative path) hand it their own openvibe-contracts
# and openvibe-sdk (openvibe-sdk/db for the job store in the one tools database, and the tools.job.*
# outbox relay): check they load under this Node and that the shared runtime itself loads. Nothing here
# needs better-sqlite3 any more (plan T8: no app depends on it).
for app in img audio docs; do
  (cd "apps/$app" && node -e "require('openvibe-contracts'); require('openvibe-sdk'); require('openvibe-sdk/db'); require('../_shared/jobs')") \
    || { echo "ABORT: apps/$app cannot load the jobs runtime; nothing restarted" >&2; exit 1; }
done
# Every app's guard (apps/_shared/guard) keeps its state in PostgreSQL (guard_abuse) and Valkey (salt, day
# counters, buckets); check it loads. The units' ReadWritePaths still name each data directory (uploads,
# job files), which must exist before systemd starts them.
for app in apps/*/; do
  case "$app" in apps/_*) continue ;; esac   # apps/_shared is a package the apps require, not an app
  [ -f "$app/package.json" ] || continue
  mkdir -p "$app/data"
  (cd "$app" && node -e "require('openvibe-sdk/db'); require('../_shared/guard')") \
    || { echo "ABORT: $app cannot load the guard; nothing restarted" >&2; exit 1; }
done
UNITS=$(systemctl list-unit-files 'openvibe-tools*' --no-legend | awk '{print $1}')
sudo systemctl restart $UNITS
sleep 5
for u in $UNITS; do printf '%-34s %s\n' "$u" "$(systemctl is-active "$u")"; done
curl -fsS -o /dev/null -H 'Host: openvibe.tools' http://127.0.0.1:4001/api/health && echo "gateway healthy ($BEFORE → $AFTER)" || exit $?
# Release notification (roadmap WS-P task 9): OpenVibe.Host publishes host.release.published for the release
# the apps' /release.json reports, once per release, so open tabs check it now instead of at their next
# poll. Best effort: skipped without an ovhost whose --help has `announce <service>`, 20 s at most, and it
# never changes the exit code. ovhost reads Host's credentials as root (OpenVibe.Host
# docs/release-notifications.md).
OVHOST_BIN=$(command -v "${OVHOST:-ovhost}" 2>/dev/null || true)
if [ -n "$OVHOST_BIN" ]; then
  case "$("$OVHOST_BIN" --help 2>/dev/null || true)" in
    *"announce <service>"*)
      SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo -n"
      timeout 20 $SUDO "$OVHOST_BIN" announce tools 2>&1 || echo "release notification not sent (the deploy stands)" ;;
    *) echo "release notification skipped: this ovhost has no announce" ;;
  esac
fi
exit 0
