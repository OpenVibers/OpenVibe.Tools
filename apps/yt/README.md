# YT.OpenVibe — YouTube Downloader

Free YouTube video and audio downloader at `yt.openvibe.tools`.

## Features

- Video: Best, 1080p, 720p, 480p, 360p, WebM
- Audio: MP3, M4A, OPUS, FLAC
- Real-time SSE progress streaming
- Tiered rate limiting (anon: 5/hr, authed: 20/hr)

## Stack

- **Express** backend with **yt-dlp** (system binary)
- RS256 JWT verification (openvibe.tools auth, optional)
- Ephemeral storage: 1hr (anon), 24hr (authed)

## Requirements

- `yt-dlp` installed system-wide
- `ffmpeg` for audio extraction

## Development

```bash
npm install
pip install yt-dlp   # or system package
npm run dev           # PORT=4013
```

## Deploy

```bash
sudo cp deploy/systemd/openvibe-tools-yt.service /etc/systemd/system/
sudo cp deploy/nginx/yt.openvibe.tools.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/yt.openvibe.tools.conf /etc/nginx/sites-enabled/
sudo systemctl enable --now openvibe-tools-yt
sudo nginx -t && sudo systemctl reload nginx
```
