# Img.OpenVibe — Image Conversion Hub

Multi-subdomain image processing service: convert, compress, resize, and crop.

## Subdomains

18 hostnames served by a single Express backend:

| Domain | Tool |
|--------|------|
| `img.openvibe.tools` | Hub — all tools |
| `png/jpg/webp/avif/heic/svg/gif/ico/tiff/bmp.openvibe.tools` | Auto-convert to format |
| `compress/resize/crop.openvibe.tools` | Direct tool access |
| `convert.openvibe.tools` | Format conversion |
| `favicon.openvibe.tools` | ICO generation |

## Stack

- **Express** + **Sharp** for image processing
- **multer** for uploads (50MB max, memory storage)
- **to-ico** for ICO/favicon generation
- RS256 JWT verification (openvibe.tools auth, optional)
- Ephemeral storage: 1hr (anon), 24hr (authed)

## Development

```bash
npm install
npm run dev   # PORT=4012
```

## Deploy

```bash
# Systemd + Nginx configs in deploy/
sudo cp deploy/systemd/openvibe-tools-img.service /etc/systemd/system/
sudo cp deploy/nginx/img.openvibe.tools.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/img.openvibe.tools.conf /etc/nginx/sites-enabled/
sudo systemctl enable --now openvibe-tools-img
sudo nginx -t && sudo systemctl reload nginx
```
