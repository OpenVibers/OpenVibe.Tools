#!/usr/bin/env bash
# Deploy OpenVibe.Tools on the host: pull, install dependencies in each app whose package.json
# changed (that includes a new openvibe-shared release tag), restart the units, check health.
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
  [ -f "$app/package.json" ] || continue
  if git diff --name-only "$BEFORE" "$AFTER" -- "$app/package.json" | grep -q . || [ ! -d "$app/node_modules" ]; then (cd "$app" && npm install --omit=dev --no-audit --no-fund --loglevel=error); fi
done
# Every app must resolve its dependencies before anything restarts. A dependency that used to be a
# file: link can leave an empty directory npm treats as installed (2026-09-23: vendor/openvibe-shared
# kept an untracked lockfile, every unit crash-looped on 'openvibe-shared/brand'); reinstall those.
for app in apps/*/; do
  [ -f "$app/package.json" ] || continue
  for dep in $(node -e 'console.log(Object.keys(require("./"+process.argv[1]+"package.json").dependencies||{}).join(" "))' "$app"); do
    if [ ! -f "$app/node_modules/$dep/package.json" ]; then
      echo "reinstalling $dep in $app (missing package.json)"; rm -rf "$app/node_modules/$dep"
      (cd "$app" && npm install --omit=dev --no-audit --no-fund --loglevel=error)
      [ -f "$app/node_modules/$dep/package.json" ] || { echo "ABORT: $app cannot resolve $dep; nothing restarted" >&2; exit 1; }
    fi
  done
done
# Apps that run jobs (apps/_shared/jobs, required by relative path) hand it their own better-sqlite3 and
# openvibe-contracts: check both load under this Node (a native-module ABI mismatch shows up here, not in
# a crash loop) and that the shared runtime itself loads.
for app in img audio docs; do
  (cd "apps/$app" && node -e "const D=require('better-sqlite3'); new D(':memory:').close(); require('openvibe-contracts'); require('../_shared/jobs')") \
    || { echo "ABORT: apps/$app cannot load the jobs runtime; nothing restarted" >&2; exit 1; }
done
UNITS=$(systemctl list-unit-files 'openvibe-tools*' --no-legend | awk '{print $1}')
sudo systemctl restart $UNITS
sleep 5
for u in $UNITS; do printf '%-34s %s\n' "$u" "$(systemctl is-active "$u")"; done
curl -fsS -o /dev/null -H 'Host: openvibe.tools' http://127.0.0.1:4001/api/health && echo "gateway healthy ($BEFORE → $AFTER)"
