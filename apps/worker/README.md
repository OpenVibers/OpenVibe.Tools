# Tools worker protocol 1

A single Node 22 process reuses the image, PDF and audio satellite job handlers and their validation, bounded worker threads and hardened ffmpeg execution. Jobs arrive as bytes over an outbound TLS WebSocket; no HTTP listener is opened. The gateway stores only a SHA-256 credential hash, verifies timestamped HMAC signatures, refuses replayed handshakes and drops stale connections. Worker credentials are independent of person credentials.

`node apps/worker/server/index.js --dry-run` checks the production protocol without credentials, registering a worker or accepting any job. Real workers require `TOOLS_WORKER_ID`, `TOOLS_WORKER_TOKEN_FILE` (a private file), and optionally `TOOLS_WORKER_SLOTS` (1–8, default 2). `TOOLS_GATEWAY` defaults to `https://openvibe.tools` and must be an HTTPS origin.

Only img.process, docs.process and audio.process are supported. Each job is capped at 16 MiB of input and output; larger jobs remain on the host. Input types are sniffed again on the worker. SVG and URL-fetching jobs are refused. Tool options are validated by the same satellite definitions. The gateway retains job ownership, quotas and result storage. No caller token crosses the worker channel.

Worker routing is default-off. This first part installs the channel and execution runtime; routing and owner controls follow separately.
