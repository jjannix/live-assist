# Euro Studio

A unified control panel for live European sports broadcasts on OBS. One-click scene switching, per-app volume faders, mute toggles, audio profiles, and a live activity log — all from a phone or tablet on the same network.

Built for the case where you're streaming, both hands are on the controller, and a friend needs to switch scenes or nudge audio without interrupting you.

## What it does

- **Scene switching** — `Live Übertragung` (game), `Spotify` (break), `Zen` (idle) — assigned to OBS scenes
- **Audio faders** — per-app volume control (OBS, Spotify, Chrome, etc.) via Windows Core Audio
- **Mute toggles** — one-tap mute for each audio channel
- **Smooth fades** — slider movements ramp volume over 900ms instead of jumping
- **Auto-profiles** — switch audio settings automatically when scenes change (e.g. lower game audio when going to break)
- **Live terminal** — every action logged in-app with timestamps
- **Multi-device** — phone, tablet, laptop, all in parallel
- **PWA** — install as a web app on iOS / Android home screen

## Quick start

### Windows

```bat
start.bat
```

That's it. Installs deps, copies `.env.example` to `.env` if missing, starts the server.

### Manual

```sh
npm install
cp .env.example .env
# Edit .env with your OBS WebSocket password
node server.js
```

Then open `http://localhost:3000` on the main PC, or scan the network IP shown in the terminal to open it on a phone/tablet.

## Setup

### OBS

1. **Tools → WebSocket Server Settings → Enable WebSocket server** (OBS 28+)
2. Copy the password into `OBS_WEBSOCKET_PASSWORD` in `.env`
3. Default URL is `ws://localhost:4455`

### Scenes

Edit `SCENES` in `.env`. The defaults are:
```
SCENES=Live Übertragung,Spotify,Zen
```
Names must match OBS exactly.

### Audio channels

Euro Studio treats apps as two logical channels:

| Channel | Default apps | Maps to OBS source |
|---------|-------------|-------------------|
| **3** — TV | `obs64.exe, chrome.exe` | The broadcast |
| **4** — Spotify | `spotify.exe` | The break music |

Change with `AUDIO_CHANNEL_3_APPS` and `AUDIO_CHANNEL_4_APPS` in `.env`. Use process names without `.exe`.

## Network access

The server binds to `0.0.0.0:3000` by default, so any device on the same network can reach it.

| Network | Works? | Notes |
|---------|--------|-------|
| Same WiFi (home / office) | ✓ | Phone and PC on same router |
| **Eduroam / public WiFi** | ✗ | Client isolation blocks device-to-device |
| **Eduroam + Windows Hotspot** | ✓ | See below |

### Eduroam workaround

Eduroam isolates clients — your phone can't reach the PC even on the same SSID. The fix is to use Windows Mobile Hotspot on a **dual-band** WiFi adapter:

1. PC stays on Eduroam (5 GHz) for the OBS stream
2. PC broadcasts a personal hotspot (2.4 GHz) for the phone
3. Phone connects to the hotspot, opens `http://<hotspot-ip>:3000`

The startup log prints every reachable IPv4 address — pick the one that matches the hotspot's range (usually `192.168.137.x`).

## Configuration

All settings live in `.env`. See `.env.example` for the full annotated reference.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST` | `0.0.0.0` | Bind address (`localhost` for local-only) |
| `PORT` | `3000` | HTTP port |
| `OBS_WEBSOCKET_URL` | `ws://localhost:4455` | OBS WebSocket endpoint |
| `OBS_WEBSOCKET_PASSWORD` | — | OBS WebSocket password |
| `AUDIO_BACKEND` | `auto` | `auto`, `voicemeeter`, `windows-simple`, or `none` |
| `AUDIO_CHANNEL_3_APPS` | `obs64.exe,chrome.exe` | Apps in logical channel 3 (TV) |
| `AUDIO_CHANNEL_4_APPS` | `spotify.exe` | Apps in logical channel 4 (Spotify) |
| `SCENES` | `Live Übertragung,Spotify,Zen` | OBS scene names, comma-separated |
| `AUDIO_FADE_DURATION_MS` | `900` | Volume ramp time |
| `AUDIO_DEBUG` | `0` | Set to `1` for verbose audio logs |

## Audio backends

Euro Studio abstracts audio behind a pluggable backend (`audio/interface.js`). Three options:

### `voicemeeter` (default for power users)

Full control via Voicemeeter. Supports per-strip volume, mute, profiles, and auto-profiles. Requires Voicemeeter installed and running.

### `windows-simple` (no Voicemeeter)

Per-app volume via Windows Core Audio. No extra software. Apps not running simply report as silent. Profiles not supported.

### `none`

Disables all audio. Scene switching still works.

The `auto` mode tries Voicemeeter first, then falls back to `windows-simple`.

## File structure

```
.
├── server.js                  # Express + Socket.IO server
├── package.json
├── start.bat                  # Windows launcher
├── .env.example               # All config options
├── public/                    # Frontend (PWA)
│   ├── index.html             # Main controller
│   ├── dashboard.html         # Health dashboard
│   ├── app.js                 # Client logic
│   ├── style.css
│   ├── manifest.json
│   └── service-worker.js
├── audio/                     # Audio backend abstraction
│   ├── interface.js           # Base AudioBackend class
│   ├── voicemeeter-backend.js # Voicemeeter implementation
│   ├── windows-simple-backend.js  # Windows Core Audio
│   ├── factory.js             # createBackend()
│   └── sidecar-coreaudio.cs   # C# COM interop for windows-simple
└── scripts/                   # Utility scripts
```

## PWA install

On iPhone: Safari → Share → **Add to Home Screen**
On Android: Chrome → menu → **Install app**

## License

ISC
