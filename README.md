# jnk Live Assist

Wireless control for OBS in public-viewing setups. A laptop runs OBS to a beamer and speakers — jnk Live Assist lets a phone or tablet switch scenes and adjust audio over WiFi, so one person can focus on the game while another runs the show.

Built for the case where you're streaming a match, both hands are on the controller, and a friend needs to switch from live feed to halftime music or tweak the volume for the room.

## What it does

- **Scene switching** — `Live Übertragung` (match), `Spotify` (halftime), `Zen` (idle) — picked from your phone
- **Per-app audio faders** — separate volume for the game feed, music player, browser, etc.
- **Mute toggles** — one-tap silence for each channel
- **Smooth fades** — slider movements ramp volume over ~1 second, no jump-cuts
- **Auto-profiles** — audio settings follow scenes (e.g. lower game audio automatically when switching to halftime)
- **Live activity log** — every action timestamped and visible in-app
- **PWA** — install on iOS / Android home screen, runs fullscreen
- **Multi-device** — phone, tablet, laptop can all be controllers in parallel

## Use case

Typical setup:

```
  Beamer ──── HDMI ───► Laptop (OBS Studio)
                              │
                              │ speakers/PA
                              ▼
                         Audio out
                              ▲
                              │ WiFi
                              │
                       Phone / Tablet
                       (Live Assist)
```

- OBS runs fullscreen preview to the beamer
- Audio goes to the room's speakers
- A separate person operates jnk Live Assist on a phone, switching scenes and audio without touching the laptop
- No mouse, no keyboard, no display needed on the controlling device

## Quick start

### Windows

```bat
start.bat
```

Installs deps, copies `.env.example` to `.env` if missing, starts the server.

### Manual

```sh
npm install
cp .env.example .env
# Edit .env with your OBS WebSocket password
node server.js
```

Open `http://localhost:3000` on the main PC, or use the network IP printed at startup to open it on the controlling phone/tablet.

## Setup

### Node.js

The `native` audio backend uses `native-sound-mixer`, which currently only ships an **x64** prebuilt. On **Windows arm64** (Surface Pro X, Snapdragon X Elite, etc.) you must run an **x64** Node.js — Windows on arm64 emulates it natively.

| Workflow | How to get x64 |
|----------|---------------|
| Production launcher (`start.bat`) | Auto-detects the system x64 Node at `C:\Program Files\nodejs\` and refuses to start on arm64 |
| **Dev (any terminal)** | `dev.cmd node server.js` / `dev.cmd nodemon server.js` — prepends the x64 Node to PATH and forwards the rest of the command line |
| **Dev (VS Code)** | `.vscode/settings.json` sets `FNM_ARCH=x64` in the integrated terminal only, no global change |
| Manual | `& "C:\Program Files\nodejs\node.exe" server.js` |

If you use fnm with `--arch=arm64` in your global profile, leave it alone — the per-project options above override it just for this workspace.

### OBS

1. **Tools → WebSocket Server Settings → Enable WebSocket server** (OBS 28+)
2. Copy the password into `OBS_WEBSOCKET_PASSWORD` in `.env`
3. Default URL is `ws://localhost:4455`
4. Set the OBS scene you want on the beamer as **fullscreen preview** (right-click the preview → Fullscreen Projector)

### Scenes

Edit `SCENES` in `.env`. The defaults are:
```
SCENES=Live Übertragung,Spotify,Zen
```
Names must match your OBS scenes exactly. Typical setup:

| OBS scene | Purpose |
|-----------|---------|
| `Live Übertragung` | The match feed (game source on fullscreen) |
| `Spotify` | Halftime / breaks — music, no game |
| `Zen` | Idle / pre-game — logos, attract loop |

### Audio channels

jnk Live Assist maps two logical channels onto apps running on the laptop:

| Channel | Default apps | Role |
|---------|-------------|------|
| **3** — TV | `obs64.exe, chrome.exe, firefox.exe, msedge.exe, discord.exe` | Anything producing the broadcast audio (browser stream, game, comms, OBS monitor) |
| **4** — Spotify | `spotify.exe` | The halftime music |

These are arbitrary — change them with `AUDIO_CHANNEL_3_APPS` and `AUDIO_CHANNEL_4_APPS` in `.env`. Use process names without `.exe`. Apps not running report as silent rather than erroring.

**How it works without Voicemeeter:** the `native` backend uses `native-sound-mixer` to talk to the Windows Core Audio API. Each listed app's master volume is set directly in Windows. If OBS is capturing the system default audio device (via the *Desktop-Audio* source), the broadcast mix tracks those per-app levels automatically — lower Spotify in Windows → less Spotify in the broadcast.

## Network access

The server binds to `0.0.0.0:3000` by default, so any device on the same network can reach it.

| Network | Works? | Notes |
|---------|--------|-------|
| Home / office WiFi | ✓ | Phone and PC on same router |
| **Eduroam / public WiFi** | ✗ | Client isolation blocks device-to-device |
| **Eduroam + Windows Hotspot** | ✓ | See below |

### Eduroam workaround

Eduroam (and most public / campus WiFi) isolates clients — your phone can't reach the laptop even on the same SSID. The fix is to use **Windows Mobile Hotspot** on a **dual-band** WiFi adapter:

1. Laptop stays on Eduroam (5 GHz) for internet and OBS
2. Laptop broadcasts a personal hotspot (2.4 GHz) for the phone
3. Phone connects to the hotspot, opens `http://<hotspot-ip>:3000`

The startup log prints every reachable IPv4 address — pick the one matching the hotspot range (usually `192.168.137.x`).

If your WiFi card doesn't support simultaneous client + AP, plug in a cheap USB WiFi dongle and use that for the hotspot.

## Configuration

All settings live in `.env`. See `.env.example` for the full annotated reference.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST` | `0.0.0.0` | Bind address (`localhost` for local-only) |
| `PORT` | `3000` | HTTP port |
| `OBS_WEBSOCKET_URL` | `ws://localhost:4455` | OBS WebSocket endpoint |
| `OBS_WEBSOCKET_PASSWORD` | — | OBS WebSocket password |
| `AUDIO_BACKEND` | `auto` | `auto`, `voicemeeter`, `native`, or `none` |
| `AUDIO_CHANNEL_3_APPS` | `obs64,chrome` | Apps in logical channel 3 |
| `AUDIO_CHANNEL_4_APPS` | `spotify` | Apps in logical channel 4 |
| `SCENES` | `Live Übertragung,Spotify,Zen` | OBS scene names, comma-separated |
| `AUDIO_FADE_DURATION_MS` | `900` | Volume ramp time |
| `AUDIO_DEBUG` | `0` | Set to `1` for verbose audio logs |

## Audio backends

jnk Live Assist abstracts audio behind a pluggable backend (`audio/interface.js`).

- **`voicemeeter`** — full control via Voicemeeter. Per-strip volume, mute, profiles, auto-profiles. Requires Voicemeeter installed and running.
- **`native`** *(default for users without Voicemeeter)* — per-app volume via Windows Core Audio through the `native-sound-mixer` native addon. No extra software, just `node server.js`. Profiles and per-scene auto-profiles are not supported (the faders themselves work the same).
- **`none`** — disables audio. Scene switching still works.

`auto` tries Voicemeeter first; if it's not installed or fails to connect, it falls back to `native`; if neither is available, audio is disabled but the rest of the app keeps working.

Pick a backend explicitly with `AUDIO_BACKEND=voicemeeter|native|none` in `.env`. The status pill in the top-right shows which one is active: `VM` (Voicemeeter), `APP` (native), `OFF` (none).

## File structure

```
.
├── server.js                  # Express + Socket.IO server
├── package.json
├── start.bat                  # Windows launcher
├── dev.cmd                    # x64 Node.js wrapper for dev
├── .env.example               # All config options
├── .gitignore
├── config/
│   └── config.js              # Reads .env, exports to server
├── docs/
│   ├── SETUP.md               # Extended setup guide
│   └── OBS-SETUP.md           # OBS-specific setup
├── data/                      # Runtime state (gitignored)
│   └── break-state.json       # Break screen state
├── public/                    # Frontend (PWA)
│   ├── index.html             # Main controller
│   ├── config.html            # In-app .env editor
│   ├── dashboard.html         # Health dashboard
│   ├── app.js                 # Client logic
│   ├── style.css
│   ├── manifest.json
│   └── service-worker.js
└── audio/                     # Audio backend abstraction
    ├── interface.js           # Base AudioBackend class
    ├── conversions.js         # dB ↔ scalar helpers
    ├── voicemeeter-backend.js # VoicemeeterRemote wrapper
    ├── native-backend.js      # native-sound-mixer (per-app volume)
    └── factory.js             # auto/voicemeeter/native/none picker
```

## PWA install

- **iPhone**: Safari → Share → **Add to Home Screen**
- **Android**: Chrome → menu → **Install app**

Once installed it launches fullscreen, no browser chrome.

## License

ISC
