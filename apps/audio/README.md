# Audio.OpenVibe

Free online audio converter and processing tools. Part of the [OpenVibe Network](https://openvibe.network).

## Subdomains

One backend serves 40+ branded subdomains:

### Format Converters
`mp3.openvibe.tools` `wav.openvibe.tools` `flac.openvibe.tools` `ogg.openvibe.tools` `m4a.openvibe.tools` `aac.openvibe.tools` `opus.openvibe.tools` `wma.openvibe.tools` `aiff.openvibe.tools` `ac3.openvibe.tools`

### Audio Tools
`trim.openvibe.tools` `merge.openvibe.tools` `pitch.openvibe.tools` `speed.openvibe.tools` `reverse.openvibe.tools` `normalize.openvibe.tools` `fade.openvibe.tools` `loop.openvibe.tools` `bass.openvibe.tools` `equalizer.openvibe.tools` `vocal.openvibe.tools` `karaoke.openvibe.tools` `extract.openvibe.tools` `waveform.openvibe.tools` `ringtone.openvibe.tools` `podcast.openvibe.tools` `voice.openvibe.tools` `noise.openvibe.tools`

### Effects
`echo.openvibe.tools` `reverb.openvibe.tools` `chorus.openvibe.tools` `distortion.openvibe.tools` `compressor.openvibe.tools` `bitcrusher.openvibe.tools` `stereo.openvibe.tools` `silence.openvibe.tools` `metadata.openvibe.tools`

### Hub
`audio.openvibe.tools` — Main hub with all tools

## Architecture

Same pattern as Img.OpenVibe: domain → context → SPA adapts.

- `server/domain-map.js` — 40+ hostname → tool config mappings
- `server/tools/` — 25 tool handlers, each using FFmpeg via fluent-ffmpeg
- `server/retention/` — Temp file storage with auto-cleanup (1h anon / 24h authed)
- `public/` — Vanilla JS SPA with drag & drop, audio player preview

## Stack

- Node.js + Express
- FFmpeg via fluent-ffmpeg
- openvibe-shared (navbar, themes, auth JWT)
- No frameworks, no build step

## Deploy

```bash
# On production server (SSH)
sudo cp deploy/systemd/openvibe-tools-audio.service /etc/systemd/system/
sudo cp deploy/nginx/audio.openvibe.tools.conf /etc/nginx/sites-enabled/
sudo systemctl daemon-reload
sudo systemctl enable --now openvibe-tools-audio
sudo nginx -t && sudo systemctl reload nginx
```

## Requirements

- Node.js 20+
- FFmpeg installed system-wide (`apt install ffmpeg`)
- openvibe-shared package (vendored at `vendor/openvibe-shared`)

## Port

`4014` (configured in `server/config.js`)
