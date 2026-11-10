# Run Tools on your own machine

The worker is one outbound process reusing the host's image, PDF and audio job handlers, validation, cancellation and time limits. It advertises installed operations, free slots and load. The Tools gateway uses a signed WebSocket because Link's current machine channel does not yet carry this Tools file-job protocol. No port forwarding, public home address, person token or caller-chosen URL reaches the worker.

URL-fetching jobs (including YouTube, maps and network tools), SVG inputs, and transfers over 16 MiB stay on the host. ffmpeg and ffprobe accept local file/pipe protocols only. Inputs arrive as bytes and results return over the same channel. The gateway retains job ownership and receipts. Worker routing starts **off**.

## Ubuntu setup

Use Ubuntu 22.04 or newer. The installer installs ffmpeg, qpdf and Poppler, and Node 22 if Node 22+ is missing. On either Dell Precision 3620, start with the default two slots; the systemd unit limits work to two CPU cores and 2 GiB RAM. Home upload is the bottleneck: keep URL-fetching traffic on the host.

1. In the owner's Network console, OpenVibe.Tools settings, create a worker labelled for this machine with location `home`. Copy its id and one-time token. Only the token hash remains in the gateway database. The worker controls are being added in the owner-view part of this rollout; the owner API is `POST /api/v1/owner/workers`.
2. Save the token in a private file on the tower (mode 600). Do not put it in a command, shell history, repository or log.
3. Download and inspect the installer, then run it with the id and the **path** to that file:

```sh
curl --fail --proto '=https' https://openvibe.tools/worker/install.sh -o install.sh
sudo bash install.sh --worker-id WORKER_ID --token-file /private/path/worker-token --slots 2
```

The id above is a placeholder, not a credential. The installer copies the credential to `/etc/openvibe-tools-worker/token` (root-only), then systemd supplies it through `LoadCredential`. Remove your temporary token file after installation. The root-only config contains the id, gateway and slots, never the token. A trusted alternative gateway can be selected with `--gateway https://your-gateway.example`.

4. Check `systemctl status openvibe-tools-worker` and confirm the worker appears with free slots in the owner console. Enable routing there when ready. Default order is home, then host. Drain before planned maintenance; a disconnect retries a job once elsewhere.

## Updates and maintenance

`openvibe-tools-worker-update.timer` checks daily, with a randomized delay. It reads the deployed gateway's `/release.json`, resolves that revision to an immutable commit of OpenVibers/OpenVibe.Tools, installs dependencies in a new release directory and checks the dry channel before switching the `current` symlink. The previous release is retained; a failed service restart restores it. The installer serializes updates with a lock. No git checkout or repository credential is needed.

Run `sudo systemctl start openvibe-tools-worker-update` to check now. Updates can interrupt a running job, which uses the normal retry path. For a quiet maintenance window, drain first. To stop updates: `sudo systemctl disable --now openvibe-tools-worker-update.timer`. To stop work: drain, then `sudo systemctl stop openvibe-tools-worker`. Revoke its credential in the console if retiring the machine. No inbound firewall rule is needed.

## Safe workstation check

With Node 22+ already installed, use a new throwaway directory:

```sh
bash install.sh --dry-run --prefix /tmp/tools-worker-check-new
```

This downloads the deployed release and dependencies, then checks HTTPS plus a dedicated anonymous WebSocket. It never registers a worker, reads a token, installs a service or accepts jobs. Success includes `service_installed=false; accepts_real_jobs=false`. Remove the throwaway directory when finished.

For an already installed checkout: `node apps/worker/server/index.js --dry-run`. Real startup requires `TOOLS_WORKER_ID`, `TOOLS_WORKER_TOKEN_FILE`, and optional `TOOLS_WORKER_SLOTS` (1–8, default 2) and `TOOLS_GATEWAY` (an HTTPS origin). Run from a private writable directory; processing files are temporary. These settings can be supervised outside systemd, but the installer is tested on Ubuntu.

## Routing API

The owner can GET/PUT `/api/v1/owner/worker-routing` with `{ "enabled": false, "order": ["home", "host"] }`; mutations require the owner and same origin. Order entries may name a worker id. Workers within a group rank by free slots, then recent latency. Run requests accept `X-Tools-Prefer: auto|home|host`; `host` stays on the host and `home` respects owner order. Receipts are at `result.data.execution` on success or `error.execution` on failure/cancellation. See [the API guide](https://openvibe.tools/developers#worker-routing).
