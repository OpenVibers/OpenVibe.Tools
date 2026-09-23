#!/usr/bin/env bash
# Deploy OpenVibe.Tools on the host: pull, install dependencies in each app whose package.json
# changed (that includes a new openvibe-shared release tag), restart the units, check health.
set -euo pipefail
cd "$(dirname "$0")/../.."
BEFORE=$(git rev-parse HEAD); git pull -q --ff-only; AFTER=$(git rev-parse HEAD)
for app in apps/*/; do
  [ -f "$app/package.json" ] || continue
  if git diff --name-only "$BEFORE" "$AFTER" -- "$app/package.json" | grep -q . || [ ! -d "$app/node_modules" ]; then (cd "$app" && npm install --omit=dev --no-audit --no-fund --silent); fi
done
UNITS=$(systemctl list-unit-files 'openvibe-tools*' --no-legend | awk '{print $1}')
sudo systemctl restart $UNITS
sleep 5
for u in $UNITS; do printf '%-34s %s\n' "$u" "$(systemctl is-active "$u")"; done
curl -fsS -o /dev/null -H 'Host: openvibe.tools' http://127.0.0.1:4001/api/health && echo "gateway healthy ($BEFORE → $AFTER)"
