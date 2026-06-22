# jnk Live Assist

A one-person broadcast desk for public-viewing matches. A laptop runs OBS to a
beamer and speakers; **jnk Live Assist** turns a phone or tablet into a wireless
control surface — switching the live feed to halftime, riding the audio, running
the score & countdown, and pushing sponsor graphics — all over WiFi, no second
monitor, no mouse, no keyboard.

Built for the case where you're streaming a match, and dont want to keep running back and
forth from your seat to the Laptop.

> **First time here?** [`SETUP.md`](SETUP.md) is a 10-minute guided install
> (app side). [`OBS-SETUP.md`](OBS-SETUP.md) covers the broadcast side
> (live-feed capture, beamer projection). This README is the reference.

## What it does

### Live control (the main controller — `/`)

- **Scene switching** — `Live Übertragung` (match), `Spotify` (halftime), `Zen`
  (idle), tapped from your phone
- **One-tap Game / Break actions** — the big buttons. They switch the OBS scene
  *and* crossfade the audio in one move: Game brings the broadcast up and fully
  mutes music; Break does the reverse. Each side remembers the level you last
  set, so Game always returns to *your* TV volume, not a default
- **Per-app audio faders** — separate volume for the broadcast mix and the music
  player, mapped onto Windows processes (no Voicemeeter required)
- **Mute toggles & smooth fades** — slider moves ramp volume over ~1s, no jump-cuts
- **Audio profiles** — save snapshots of both faders and recall them later;
  scenes can auto-load a profile on switch
- **Live peek** — tap the eye to grab one frame of the live feed, so you can see
  whether the match has resumed while the beamer shows the halftime deck
- **Live activity log** — every action timestamped, in a slide-up drawer
- **Dim mode** — drop the screen brightness for dark rooms

### Halftime deck (audience-facing — `/break.html`)

A full-screen slide deck designed to run as an **OBS Browser Source @ 1080p** on
the beamer during breaks. It crossfades through any combination of:

| Slide | Shows |
|-------|-------|
| **clock** | Big numeral halftime countdown |
| **radial** | Countdown as a depleting ring |
| **score** | Editorial scoreboard split (home / away) |
| **message** | Full-screen pushed announcement |
| **ad** | Rotating sponsor bumpers (logo, name, tagline, QR) |
| **weather** | Live local conditions + 6-hour forecast strip (Open-Meteo, no API key) |
| **brand / mercury / flowfield / nebel** | Atmospheric attract motion |

The server owns the countdown clock, so a refresh or a second device never loses
time, and every device sees identical numbers. State is persisted to disk, so a
mid-match restart doesn't wipe the score.

### Operator tools

- **Break editor** (`/break-control.html`) — drive the deck from your phone:
  start/pause/reset the timer, ± the score, type teams & a message, toggle &
  pin slides, set the dwell, and manage sponsors (add, edit, **upload a logo
  straight from the phone**)
- **Settings** (`/config.html`) — a live `.env` editor. Change the OBS password,
  audio backend, channel apps, peek source, or stadium coordinates and it
  hot-reloads OBS, audio, and weather without restarting the server. No
  filesystem, no text editor
- **Health dashboard** (`/dashboard.html`) — uptime, connected clients, memory &
  system stats, plus one-tap force-reconnect for OBS and the audio backend

### Everywhere

- **PWA** — install on iOS / Android home screen, launches fullscreen
- **Multi-device** — phone, tablet, laptop are all controllers in parallel;
  every action broadcasts to every connected screen

## The setup at a glance

```
  Live feed ──────► OBS ───── HDMI ─────► Beamer
                       │                    │
                       │  + Browser Source  └─ /break.html (the halftime deck)
                       │
                       │  audio out ─► Speakers (room)
                       │     ▲
                       │     │ per-app levels, controlled by either:
                       │     │   • Windows Core Audio  (native backend)
                       │     │   • Voicemeeter         (voicemeeter backend)
                       │
  Express + Socket.IO (0.0.0.0:3000) ──► OBS WebSocket + audio backend
                       ▲
                       │ WiFi
                 Phone / Tablet (operator)
                 ├── /                    main controller
                 ├── /break-control.html  break editor
                 ├── /config.html         settings
                 └── /dashboard.html      health
```

- OBS runs a fullscreen projector to the beamer; during breaks the beamer shows
  `/break.html` via a Browser Source instead
- The room audio comes out of the laptop's speakers; depending on the backend,
  the app rides either per-app Windows levels (native) or Voicemeeter strips —
  anything OBS captures follows those controls automatically
- A separate person operates the phone — no mouse, keyboard, or display needed
  on the controlling device

## Quick start

### Recommended — guided installer (Windows)

On the **broadcast PC**, open PowerShell (Win+X → **Terminal**) and paste:

```powershell
irm https://raw.githubusercontent.com/jjannix/live-assist-install/main/install.ps1 | iex
```

It checks for Git, Node.js, and OBS (installing any that are missing), drops the
app in place, and runs `npm install`. Then follow [`SETUP.md`](SETUP.md) to wire
up OBS and the WebSocket password. Launch everything with:

```bat
start.bat
```

`start.bat` pulls the latest from GitHub, starts Voicemeeter (if installed) and
OBS, runs the server with the correct x64 Node, and opens the controller.

### Manual

```sh
git clone https://github.com/jjannix/live-assist.git
cd live-assist
npm install
cp .env.example .env   # then edit .env with your OBS WebSocket password
node server.js
```

Open `http://localhost:3000` on the main PC, or use the network IP printed at
startup to open it on the controlling phone/tablet.

## The surfaces

| Route | Purpose | Who opens it |
|-------|---------|--------------|
| `/` | Main controller — faders, scenes, Game/Break, peek | Operator's phone |
| `/break-control.html` | Editor for the halftime deck (score, timer, sponsors, slides) | Operator's phone |
| `/break.html` | The audience-facing slide deck | **OBS Browser Source** on the beamer |
| `/config.html` | Live settings editor | Operator's phone or the laptop |
| `/dashboard.html` | Health & reconnect dashboard | The laptop |

## Setup

### Node.js & Windows arm64

The `native` audio backend uses `native-sound-mixer`, which ships an **x64-only**
prebuilt. On **Windows arm64** (Surface Pro X, Snapdragon X Elite, etc.) you must
run an **x64** Node.js — Windows emulates it natively.

| Workflow | How to get x64 |
|----------|----------------|
| `start.bat` | Auto-detects the system x64 Node at `C:\Program Files\nodejs\` and refuses to start on arm64 |
| **Dev (any terminal)** | `dev.cmd node server.js` — prepends x64 Node to PATH and forwards the rest of the line |
| **Dev (VS Code)** | `.vscode/settings.json` sets `FNM_ARCH=x64` in the integrated terminal only |
| Manual | `& "C:\Program Files\nodejs\node.exe" server.js` |

If you use fnm with `--arch=arm64` in your global profile, leave it alone — the
per-project options above override it just for this workspace.

### OBS

1. **Tools → WebSocket Server Settings → Enable WebSocket server** (OBS 28+)
2. Copy the password into `OBS_WEBSOCKET_PASSWORD` (`.env`, or the Settings page)
3. Default URL is `ws://localhost:4455`
4. Right-click the preview → **Fullscreen Projector** to send a scene to the beamer
5. Add a **Browser Source** (1920×1080) pointing at `http://localhost:3000/break.html`
   for the halftime deck, and toggle it on/off per scene as needed

For capturing the live feed itself, see [`OBS-SETUP.md`](OBS-SETUP.md).

### Scenes

Scene names must match OBS **exactly** (spaces and accents included). Defaults:

```
SCENES=Live Übertragung,Spotify,Zen
```

| OBS scene | Purpose |
|-----------|---------|
| `Live Übertragung` | The match feed (game source on fullscreen) |
| `Spotify` | Halftime / breaks — music, no game |
| `Zen` | Idle / pre-game — logos, attract loop |

### Audio channels

Two logical channels map onto apps running on the laptop:

| Channel | Default name | Default apps | Role |
|---------|--------------|--------------|------|
| **3** | TV | `obs64, chrome, firefox, msedge, edge, opera, zen, vivaldi, brave, arc, helium, thorium` | Anything producing broadcast audio |
| **4** | Spotify | `spotify` | The halftime music |

All arbitrary — rename them with `AUDIO_CHANNEL_3_NAME` / `AUDIO_CHANNEL_4_NAME`
and remap apps with `AUDIO_CHANNEL_3_APPS` / `AUDIO_CHANNEL_4_APPS`. Use process
names **without** `.exe`. Apps not running report as silent rather than erroring.

**How it works without Voicemeeter:** the `native` backend uses
`native-sound-mixer` to talk to the Windows Core Audio API and set each listed
app's master volume directly. If OBS captures the system default device (via the
*Desktop-Audio* source), the broadcast mix tracks those per-app levels
automatically — lower Spotify in Windows → less Spotify in the broadcast.

## Network access

The server binds to `0.0.0.0:3000`, so any device on the same network can reach
it. The startup log prints every reachable IPv4 address.

| Network | Works? | Notes |
|---------|--------|-------|
| Home / office WiFi | ✓ | Phone and PC on same router |
| **Eduroam / public WiFi** | ✗ | Client isolation blocks device-to-device |
| **Eduroam + Windows Hotspot** | ✓ | See below |

### Eduroam workaround

Eduroam (and most public / campus WiFi) isolates clients — your phone can't
reach the laptop even on the same SSID. The fix is **Windows Mobile Hotspot** on
a dual-band adapter:

1. Laptop stays on Eduroam (5 GHz) for internet and OBS
2. Laptop broadcasts a personal hotspot (2.4 GHz) for the phone
3. Phone connects to the hotspot, opens `http://<hotspot-ip>:3000`

Pick the IP matching the hotspot range (usually `192.168.137.x`). If your WiFi
card can't do simultaneous client + AP, add a cheap USB WiFi dongle for the
hotspot.

## Configuration

All settings live in `.env` and are editable from the in-app **Settings** page
(`/config.html`) — changes hot-reload without a restart. See `.env.example` for
the annotated reference.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST` | `0.0.0.0` | Bind address (`localhost` for local-only) |
| `PORT` | `3000` | HTTP port |
| `OBS_WEBSOCKET_URL` | `ws://localhost:4455` | OBS WebSocket endpoint |
| `OBS_WEBSOCKET_PASSWORD` | — | OBS WebSocket password |
| `AUDIO_BACKEND` | `auto` | `auto`, `voicemeeter`, `native`, or `none` |
| `AUDIO_CHANNEL_3_NAME` | `TV` | Label for channel 3 |
| `AUDIO_CHANNEL_3_APPS` | `obs64,chrome,…` | Apps in channel 3 |
| `AUDIO_CHANNEL_4_NAME` | `Spotify` | Label for channel 4 |
| `AUDIO_CHANNEL_4_APPS` | `spotify` | Apps in channel 4 |
| `AUDIO_FADE_DURATION_MS` | `900` | Volume ramp time |
| `AUDIO_DEBUG` | `false` | Verbose audio logs in the activity feed |
| `PREVIEW_SOURCE` | `Live Übertragung` | Scene/source the peek button captures |
| `PREVIEW_WIDTH` | `480` | Capture width in pixels |
| `PREVIEW_QUALITY` | `70` | JPEG quality (1–100) |
| `STADIUM_NAME` | — | Label on the weather slide (city / ground) |
| `STADIUM_LAT` | `49.318` | Latitude for the weather poll (decimal degrees) |
| `STADIUM_LON` | `7.344` | Longitude for the weather poll |

## Audio backends

Audio is abstracted behind a pluggable backend (`audio/`).

- **`voicemeeter`** — full control via Voicemeeter. Per-strip volume, mute,
  profiles, auto-profiles. Requires Voicemeeter installed and running.
- **`native`** *(default when Voicemeeter isn't installed)* — per-app volume via
  Windows Core Audio through `native-sound-mixer`. No extra software. The faders
  and Game/Break actions work identically; per-scene auto-profiles are not
  supported on this backend.
- **`none`** — disables audio. Scene switching and the break deck still work.

`auto` tries Voicemeeter first; if it's not installed or fails to connect, it
falls back to `native`, then `none`. Set it explicitly with
`AUDIO_BACKEND=voicemeeter|native|none`. The status pill in the top-right shows
which is active: `VM` (Voicemeeter), `APP` (native), `OFF` (none).

## File structure

```
.
├── server.js                  # Express + Socket.IO server, all socket handlers
├── config.js                  # Live .env reader/writer (backs /config.html)
├── break-state.js             # Source of truth for the halftime deck (persisted)
├── weather-state.js           # Open-Meteo poller → feeds the weather slide
├── package.json
├── start.bat                  # Windows launcher (git pull, OBS, VM, server)
├── dev.cmd                    # Run a command under the x64 Node
├── .env.example               # Annotated config reference
├── SETUP.md                   # Guided install (app side)
├── OBS-SETUP.md               # Broadcast setup (OBS, capture, beamer)
├── public/                    # Frontend (PWA)
│   ├── index.html             # Main controller
│   ├── break-control.html     # Break-deck operator editor
│   ├── break.html             # Audience-facing slide deck (OBS Browser Source)
│   ├── config.html            # Settings (live .env editor)
│   ├── dashboard.html         # Health dashboard
│   ├── app.js                 # Controller client logic
│   ├── style.css              # Controller + editor + dashboard theme
│   ├── broadcast.css          # Break-deck (beamer) theme & motion
│   ├── manifest.json          # PWA manifest
│   ├── service-worker.js
│   └── break-ads/             # Uploaded sponsor logos (served statically)
├── audio/                     # Audio backend abstraction
│   ├── interface.js           # Base AudioBackend class
│   ├── conversions.js         # dB ↔ scalar helpers
│   ├── voicemeeter-backend.js # VoicemeeterRemote wrapper
│   ├── native-backend.js      # native-sound-mixer (per-app volume)
│   └── factory.js             # auto/voicemeeter/native/none picker
├── scripts/
│   └── install.ps1            # Convenience copy of the one-line installer
└── data/                      # Runtime state
```

Runtime state files (gitignored, auto-created): `.env`, `break-state.json`,
`audio-profiles.json`, `public/break-ads/`.

## PWA install

- **iPhone**: Safari → Share → **Add to Home Screen**
- **Android**: Chrome → menu → **Install app**

Once installed it launches fullscreen, no browser chrome.

## License

ISC
