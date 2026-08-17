# OpenVibe.Tools — Gateway

The gateway for `openvibe.tools` and its many tool subdomains. Serves the apex
directory page and Host-header-routes the aliased tool subdomains to their SPAs.

Identity lives on **OpenVibe.Network** (`https://openvibe.network`) — this
service is an OAuth2 **client** (`client_id: tools`), not a provider.

## What it does

- **Apex directory** — `openvibe.tools` lists every tool in the suite plus links
  to the rest of the network (Live, Games, Network).
- **Net.OpenVibe** — 38 network/internet diagnostic tools (`net.openvibe.tools`
  plus one subdomain per tool: `dns.`, `ping.`, `ssl.`, `whois.`, …).
- **Dev.OpenVibe** — 26 developer & SEO tools (`dev.openvibe.tools` plus
  `json.`, `base64.`, `jwt.`, `regex.`, …).
- **Paste.OpenVibe** — `pastes.openvibe.tools` front-end; pastes are stored in
  OpenVibe.Media under app_id `live` and proxied server-side via `MEDIA_URL`.
- **Session layer** — `/auth/login`, `/auth/callback`, `/auth/logout`,
  `/auth/me`, `/auth/refresh`. Sets the shared `ov_token` cookie on
  `.openvibe.tools` so every satellite subdomain can read it and verify it
  offline against the Network's public key (JWKS).

## Architecture

```
apps/gateway (port 4001)
├── server/
│   ├── index.js       # Express app, CORS, Host routing, paste proxy
│   ├── config.js      # Port, Network URLs, OAuth client, Media URL
│   ├── auth/routes.js # OAuth2 client session layer (+ offline JWT verify)
│   ├── net/           # Net.OpenVibe API + tool/alias definitions
│   └── dev/           # Dev.OpenVibe API + tool/alias definitions
├── public/            # index, net, dev, paste, audio, img landing pages
└── deploy/            # nginx + systemd + deploy script
```

There is no local database — net/dev tool config falls back to built-in
defaults, and auth state is entirely cookie + JWT.

## Development

```bash
npm install
cp .env.example .env   # then set OV_OAUTH_CLIENT_SECRET
npm run dev            # http://localhost:4001
```

Test Host routing locally:

```bash
curl -H 'Host: net.openvibe.tools' http://localhost:4001/
```

## Environment

See `.env.example`. Key variables: `PORT` (4001), `OV_NETWORK_URL`,
`OV_NETWORK_INTERNAL_URL`, `OV_OAUTH_CLIENT_ID`, `OV_OAUTH_CLIENT_SECRET`,
`OV_OAUTH_REDIRECT_URI`, `MEDIA_URL`, `COOKIE_DOMAIN`.

## Deploy

- Path: `/opt/openvibe.tools/apps/gateway`
- Env: `/etc/openvibe/tools.env`
- Unit: `deploy/systemd/openvibe-tools.service`
- Nginx: `deploy/nginx/openvibe.tools.conf` (apex + wildcard; satellites have
  their own more-specific server blocks)
