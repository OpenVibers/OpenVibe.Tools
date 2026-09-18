# OpenVibe.Tools

The tools suite of the OpenVibe network — `openvibe.tools` plus dozens of
tool subdomains under `*.openvibe.tools`.

Identity is provided by **OpenVibe.Network** (`https://openvibe.network`).
This repo contains no identity provider: the gateway is an OAuth2 **client**
(`client_id: tools`) that sets the shared `ov_token` cookie on
`.openvibe.tools`; every satellite reads that cookie and verifies the JWT
offline against the Network's public key (JWKS).

## Layout

```
apps/
├── gateway   # apex directory + Net.OpenVibe, Dev.OpenVibe, Paste.OpenVibe (Host routing)
├── maps      # Maps.OpenVibe  — survival map for North America
├── food      # Food.OpenVibe  — grocery / food bank finder (proxies maps backend)
├── img       # Img.OpenVibe   — image converter & processing tools
├── yt        # YT.OpenVibe    — YouTube downloader
├── audio     # Audio.OpenVibe — audio converter & effects
├── text      # Text.OpenVibe + Logo.OpenVibe — text generators & logo makers
└── docs      # Docs.OpenVibe  — PDF & document tools
vendor/
└── openvibe-shared  # vendored shared package (canonical copy lives in OpenVibe.Network)
```

## Ports

| App | Domain | Port |
|---|---|---|
| gateway | openvibe.tools + net./dev./pastes. + tool aliases | **4001** |
| maps | maps.openvibe.tools | **4010** |
| food | food.openvibe.tools | **4011** |
| img | img.openvibe.tools + format aliases | **4012** |
| yt | yt.openvibe.tools | **4013** |
| audio | audio.openvibe.tools + effect aliases | **4014** |
| text | text.openvibe.tools + logo.openvibe.tools + aliases | **4015** |
| docs | docs.openvibe.tools + pdf.openvibe.tools | **4016** |

Related services: Network **4000** (SSO/JWKS/themes/shared assets),
Media **4100** (backs Paste.OpenVibe, app_id `live`), Live **3000**.

## Dev quickstart

```bash
# install everything (vendored shared package first)
npm run install:all

# gateway — http://localhost:4001
cd apps/gateway && cp .env.example .env   # set OV_OAUTH_CLIENT_SECRET
npm run start:gateway

# any satellite, e.g. maps on http://localhost:4010
npm run start:maps
```

Host-header routing without DNS:

```bash
curl -H 'Host: net.openvibe.tools' http://localhost:4001/
```

The full OAuth round-trip needs OpenVibe.Network running on port 4000
(`BOOTSTRAP_PROFILE=local-dev` seeds a `tools` client with a
`http://localhost:4001/auth/callback` redirect).

## Auth model

- `GET /auth/login` on the gateway → Network `/oauth/authorize`
  (client_id `tools`, scope `profile theme`, state cookie).
- `GET /auth/callback` → server-side code exchange → sets `ov_token`
  (JS-readable, `Domain=.openvibe.tools`, SameSite=Lax, Secure) and
  `ov_refresh` (httpOnly, Path=/auth).
- `GET /auth/login?silent=1&next=…` adds `prompt=none`: the shared navbar
  uses it for one silent sign-in attempt per tab when the browser carries
  `ov_sso_hint=account`. No Network session → straight back to `next` with
  `?sso=none`. A successful callback sets `ov_sso_hint=account` (1 year,
  JS-readable, `Domain=.openvibe.tools`); `/auth/logout` sets it to `guest`.
- `next` must be a relative path, an `https://*.openvibe.tools` URL or an
  `https://openvibe.network/...` URL (the Network's sign-in/sign-out
  everywhere chain hops through the gateway).
- `GET /auth/me`, `POST /auth/refresh`, `GET /auth/logout`.
- Satellites never talk OAuth — they read `ov_token` and verify offline
  via the Network JWKS (`GET /api/.well-known/jwks`).
- Browser pages load shared JS absolutely from
  `https://openvibe.network/shared/` (theme-loader, navbar, …).

## Deploy

- Production path: `/opt/openvibe.tools` (apps under `apps/<name>`)
- Env file: `/etc/openvibe/tools.env` (0600) — shared by all units; per-app
  `PORT` is set in each systemd unit, so tools.env must NOT define PORT.
- Units: `openvibe-tools.service` (gateway) and
  `openvibe-tools-<name>.service` per satellite
  (`apps/<name>/deploy/systemd/`).
- Nginx: satellites have specific `server_name` blocks; the gateway's
  wildcard `*.openvibe.tools` block catches everything else. TLS via
  `/etc/letsencrypt/live/openvibe.tools/`.
