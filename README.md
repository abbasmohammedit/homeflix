# HOMEFLIX

Stream the movies on your computer to your phone, tablet or TV over your home Wi-Fi.

Version **1.4.1+plus7**. It adds 4K HDR (HEVC Main 10) for devices that can play it, HDR-to-SDR conversion for the rest, Intel GPU (VA-API) conversion, user accounts with profiles and My List, and genre and language rows.

Only devices on your home network can connect. Requests from the internet are refused.

## Repository layout

| Path | What it is |
| --- | --- |
| `server.js` | The streaming server (library scan, HLS conversion with ffmpeg, accounts) |
| `genres.js` | Genre detection |
| `public/` | The web app that phones, tablets and TVs open |
| `electron/` | The desktop app (window, tray icon, settings) |
| `packages/` | Built `.deb` packages (stored with Git LFS) |
| `docker/` | Run HOMEFLIX headless in Docker |

## Getting the .deb

The `.deb` files are stored with [Git LFS](https://git-lfs.com). Install it before cloning, or the package will be a small pointer file:

```bash
sudo apt install -y git-lfs
git lfs install
git clone <repo-url>
# already cloned without LFS?
git lfs pull
```

## Install on a laptop (Ubuntu / Debian, amd64)

```bash
sudo apt update
sudo apt install -y ./packages/HOMEFLIX-1.4.1+plus7-linux-amd64.deb
homeflix
```

Use `apt install ./file.deb`, not `dpkg -i`, so that apt installs the dependencies:
`libgtk-3-0t64, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0t64, libuuid1, libsecret-1-0, libasound2t64, libgbm1` (recommended: `libappindicator3-1`).
On Ubuntu 22.04 / Debian 12 the same libraries are named without `t64`.

Open the app, add your video folders, then scan the QR code or open the address it shows from a device on the same Wi-Fi. The default port is **8080**. If the firewall is on:

```bash
sudo ufw allow 8080/tcp
```

To uninstall: `sudo apt remove homeflix`.

### Intel GPU conversion (optional)

Conversion uses the Intel GPU through VA-API when it is available and falls back to the CPU otherwise. Install the driver and check it:

```bash
sudo apt install -y intel-media-va-driver-non-free vainfo
vainfo
```

The 4K HDR stream needs a GPU that can encode HEVC Main 10.

## Run in Docker (no desktop needed)

The image installs the `.deb` from `packages/` and runs only the server.

```bash
cd docker
VIDEOS_DIR=/path/to/your/videos docker compose up -d --build
docker logs homeflix        # shows the address to open
```

- Videos are mounted read-only at `/videos`. To use more folders, add more volumes in `docker-compose.yml` and list them under `folders` in `docker/config.json`.
- Converted video is kept in the `homeflix-cache` volume, and accounts and profiles in `homeflix-data`.
- `docker/config.json` sets `port`, `folders`, `minSizeMB` and, optionally, `"pin": "1234"`.
- For GPU conversion in the container, add `devices: ["/dev/dri:/dev/dri"]` to the service. The image doesn't include a VA-API driver yet, so this alone won't enable it.

To stop: `docker compose down`. To update, replace the `.deb` in `packages/`, change `DEB` in `docker/Dockerfile`, and run `docker compose up -d --build`.

## Run from source

Needs a recent Node.js (the packaged app runs on Node 24) and `ffmpeg`/`ffprobe` on the `PATH`.

```bash
npm install
cat > config.json <<'EOF'
{ "port": 8080, "folders": ["/home/you/Videos"], "minSizeMB": 5 }
EOF
node server.js
```

`config.json` is git-ignored. Without it, the server uses `~/Videos` and `~/Downloads`.
