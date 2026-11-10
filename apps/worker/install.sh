#!/usr/bin/env bash
# Ubuntu installer. Dry mode is unprivileged and never registers or accepts jobs.
set -euo pipefail
umask 022
prefix=/opt/openvibe-tools-worker
gateway=https://openvibe.tools
worker_id= token_file= slots=2 dry=0 update=0
while (($#)); do
    case "$1" in
        --dry-run) dry=1; shift ;;
        --update) update=1; shift ;;
        --prefix) prefix=$2; shift 2 ;;
        --gateway) gateway=$2; shift 2 ;;
        --worker-id) worker_id=$2; shift 2 ;;
        --token-file) token_file=$2; shift 2 ;;
        --slots) slots=$2; shift 2 ;;
        *) echo 'Unknown installer option' >&2; exit 2 ;;
    esac
done
if ((dry)); then
    [[ "$prefix" == /* && "$prefix" != /opt/openvibe-tools-worker && ! -e "$prefix" ]] || { echo 'Dry mode needs a new absolute --prefix directory' >&2; exit 2; }
    ((update == 0)) || exit 2
else
    [[ $EUID == 0 && "$prefix" == /opt/openvibe-tools-worker ]] || { echo 'Run as root; custom prefixes are dry-mode only' >&2; exit 2; }
    mkdir -p "$prefix"
    exec 9>"$prefix/update.lock"
    flock -n 9 || { echo 'Worker update already running'; exit 0; }
    if ((update)); then
        # This root-owned file has only a gateway, worker id and slot count, never a token.
        while IFS='=' read -r key value; do
            case "$key" in TOOLS_GATEWAY) gateway=$value ;; TOOLS_WORKER_ID) worker_id=$value ;; TOOLS_WORKER_SLOTS) slots=$value ;; esac
        done < /etc/openvibe-tools-worker/config
        [[ "$worker_id" =~ ^wrk_[a-f0-9]{24}$ && "$slots" =~ ^[1-8]$ ]] || exit 2
    else
        [[ "$worker_id" =~ ^wrk_[a-f0-9]{24}$ && "$slots" =~ ^[1-8]$ && -f "$token_file" ]] || { echo 'Supply --worker-id, --token-file and --slots 1..8' >&2; exit 2; }
        apt-get update -qq
        apt-get install -y -qq ca-certificates curl python3 xz-utils ffmpeg qpdf poppler-utils
    fi
fi
python3 - "$gateway" <<'PY'
import sys,urllib.parse
u=urllib.parse.urlsplit(sys.argv[1])
if u.scheme!='https' or not u.hostname or u.username or u.password or u.path not in ('','/') or u.query or u.fragment or any(c.isspace() for c in sys.argv[1]): raise SystemExit('Gateway must be an HTTPS origin')
PY
mkdir -p "$prefix/releases"
stage=$(mktemp -d "$prefix/.stage-XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
get() { curl --fail --silent --show-error --location --max-redirs 3 --connect-timeout 15 --max-time 180 --proto '=https' --proto-redir '=https' "$1" -o "$2"; }
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    ((dry == 0)) || { echo 'Dry mode requires Node 22 or newer' >&2; exit 2; }
    case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo 'Install Node 22+ for this architecture first' >&2; exit 2 ;; esac
    get https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt "$stage/node-sums"
    node_archive=$(awk -v suffix="linux-$arch.tar.xz" '$2 ~ suffix "$" {print $2}' "$stage/node-sums")
    [[ "$node_archive" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || exit 1
    get "https://nodejs.org/dist/latest-v22.x/$node_archive" "$stage/$node_archive"
    (cd "$stage"; awk -v name="$node_archive" '$2==name' node-sums | sha256sum -c - >/dev/null)
    tar -xJf "$stage/$node_archive" -C /usr/local --strip-components=1 --no-same-owner
fi
# Resolve the production release to its immutable full commit; never follow a development branch.
get "$gateway/release.json" "$stage/release.json"
revision=$(python3 -c 'import json,sys,re; s=json.load(open(sys.argv[1]))["release"]; assert re.fullmatch("[0-9a-f]{12,40}",s); print(s)' "$stage/release.json")
get "https://api.github.com/repos/OpenVibers/OpenVibe.Tools/commits/$revision" "$stage/commit.json"
revision=$(python3 -c 'import json,sys,re; s=json.load(open(sys.argv[1]))["sha"]; assert re.fullmatch("[0-9a-f]{40}",s) and s.startswith(sys.argv[2]); print(s)' "$stage/commit.json" "$revision")
release="$prefix/releases/$revision"
if [[ ! -d "$release" ]]; then
    get "https://codeload.github.com/OpenVibers/OpenVibe.Tools/tar.gz/$revision" "$stage/source.tar.gz"
    mkdir "$stage/source"
    tar -xzf "$stage/source.tar.gz" -C "$stage/source" --strip-components=1 --no-same-owner
    for app in gateway img docs audio; do
        npm_config_userconfig=/dev/null npm_config_cache="$prefix/npm-cache" npm install --prefix "$stage/source/apps/$app" --omit=dev --no-audit --no-fund >"$stage/npm-$app.log" 2>&1 || { echo "Dependency installation failed for $app" >&2; exit 1; }
    done
    chmod +x "$stage/source/apps/worker/install.sh"
    mv "$stage/source" "$release"
fi
mkdir -p "$prefix/check-state"
(cd "$prefix/check-state"; TOOLS_GATEWAY="$gateway" node "$release/apps/worker/server/index.js" --dry-run)
if ((dry)); then
    echo "dry-install: release=$revision; service_installed=false; accepts_real_jobs=false"
    exit 0
fi
if ((!update)); then
    install -d -m 700 /etc/openvibe-tools-worker
    python3 - "$token_file" <<'PY'
import sys,re
with open(sys.argv[1]) as f: token=f.read().strip()
if not re.fullmatch('[A-Za-z0-9_-]{43}',token): raise SystemExit('Invalid worker credential file')
PY
    install -m 600 "$token_file" /etc/openvibe-tools-worker/token
    printf 'TOOLS_GATEWAY=%s\nTOOLS_WORKER_ID=%s\nTOOLS_WORKER_SLOTS=%s\n' "$gateway" "$worker_id" "$slots" > /etc/openvibe-tools-worker/config
    chmod 600 /etc/openvibe-tools-worker/config
fi
previous=$(readlink "$prefix/current" || true)
rm -f "$prefix/current.next"
ln -s "$release" "$prefix/current.next"
mv -Tf "$prefix/current.next" "$prefix/current"
install -m 644 "$release/apps/worker/deploy/"*.service "$release/apps/worker/deploy/"*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now openvibe-tools-worker-update.timer
if [[ "$previous" != "$release" ]] || ((!update)); then
    if ! systemctl restart openvibe-tools-worker.service || ! systemctl is-active --quiet openvibe-tools-worker.service; then
        if [[ -n "$previous" && -d "$previous" ]]; then
            ln -s "$previous" "$prefix/current.rollback"
            mv -Tf "$prefix/current.rollback" "$prefix/current"
            install -m 644 "$previous/apps/worker/deploy/"*.service "$previous/apps/worker/deploy/"*.timer /etc/systemd/system/
            systemctl daemon-reload
            systemctl restart openvibe-tools-worker.service
        fi
        echo 'Worker update failed; previous release restored when available' >&2
        exit 1
    fi
fi
systemctl enable openvibe-tools-worker.service
systemctl is-active --quiet openvibe-tools-worker.service
# Retain the previous release for rollback, remove only old releases created by this installer.
for old in "$prefix/releases/"*; do
    [[ "$old" == "$release" || "$old" == "$previous" ]] || rm -rf -- "$old"
done
echo "worker-installed: release=$revision; outbound_only=true; enable routing in the owner console when ready"
