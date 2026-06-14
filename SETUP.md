# jnk Live Assist — Setup Guide

New here? This walks you through getting the app running for the first time.
It takes about 10 minutes. No coding or file editing required.

> **What it is:** a remote control for OBS that runs on your phone. You run
> OBS on a laptop connected to a beamer and speakers; jnk Live Assist lets
> someone switch scenes and adjust volume from a phone over WiFi — no mouse,
> keyboard, or second monitor needed.
>
> 📺 **Configuring OBS itself (capturing the live feed, beamer projection)?**
> See [`OBS-SETUP.md`](OBS-SETUP.md) — the broadcast setup. This guide is
> just the app side.

---

## What you'll need

| Thing | Why | How to check |
|-------|-----|--------------|
| **A Windows PC** (the broadcast laptop) | Runs OBS + the server | — |
| **OBS Studio 28+** | The thing being controlled | The installer adds it if missing |
| **A phone or tablet** | The remote control | Same WiFi as the PC |
| **WiFi** shared by both | Phone reaches the laptop | See [Network notes](#network-notes) if you're on campus/public WiFi |

The PC needs to stay on and awake during use. The phone just needs a browser.

---

## Step 1 — Install (2 min)

On the **broadcast PC**, open PowerShell (Win+X → **Terminal**) and paste:

```powershell
irm https://raw.githubusercontent.com/jjannix/live-assist-install/main/install.ps1 | iex
```

Press Enter. The installer:

1. Checks for Git, Node.js, OBS — installs any that are missing (it'll ask before each, type `Y`).
2. Downloads the app into `C:\Users\<you>\jnk-live-assist`.
3. Installs its dependencies (takes a few seconds).
4. Opens a summary page.

You'll see a "SETUP DONE" banner with a report card. **Don't run anything yet** —
finish OBS setup first.

> **If a step shows `[!] needs attention`**, that's fine for now. We'll resolve
> the OBS password in Step 4.

---

## Step 2 — Set up OBS (5 min)  ⚠️ the important part

> 📺 Setting up OBS for the first time (live feed capture, beamer
> projection, PiP window)? See **[`OBS-SETUP.md`](OBS-SETUP.md)** for the
> full broadcast walkthrough. The three things below are the minimum the
> app needs.

Open **OBS Studio** and do these three things. They're easy to miss.

### 2a. Create three scenes with these EXACT names

OBS scene names must match what the app expects, **character for character**
(spaces and accents included). Create three scenes named:

| Scene name | What goes in it |
|------------|-----------------|
| **`Live Übertragung`** | The live match feed (your game / capture source filling the screen) |
| **`Spotify`** | Halftime music (a Spotify window capture, or just blank + audio) |
| **`Zen`** | Idle / pre-game (logos, an attract loop, or anything calming) |

> 🔤 **Spelling matters.** It's `Live Übertragung` — with the capital `U` and
> the `Ü`. If your keyboard can't type `Ü`, copy-paste it from here. Wrong
> names = scene buttons silently fail to switch.

### 2b. Enable the WebSocket server

This is how the app talks to OBS. It's **off by default**.

1. In OBS: **Tools → WebSocket Server Settings**
2. Tick **Enable WebSocket server**
3. Leave the port at `4455` (the default)

### 2c. Copy the password

In the same WebSocket settings window:

1. Click **Show Password** (or **Authentication → Show connect info**)
2. Copy the password — you'll paste it into the app in Step 4

> 💡 This password is random and unique to your OBS. You can change it here if
> you like, but you don't need to.

---

## Step 3 — Start it (1 min)

In the same PowerShell window (or a new one):

```powershell
cd C:\Users\<you>\jnk-live-assist
.\start.bat
```

This one command:

- Updates the app from GitHub
- Starts Voicemeeter (only if you have it installed — otherwise it uses Windows audio directly)
- Launches OBS
- Starts the server (a window titled **"jnk Live Assist - Server"** — leave it open)
- Opens the controller in your browser

When you see the controller on screen, the green dots in the top bar mean
everything connected. **If the OBS dot is red/orange**, continue to Step 4.

---

## Step 4 — Enter your OBS password (1 min)

If this is your first launch, the OBS connection isn't configured yet. Fix it
in the app — no file editing:

1. In the controller, tap the **⚙️ gear icon** (top-right) → **Settings**
2. In **OBS WebSocket password**, paste the password you copied in Step 2c
   (leave it blank if you want to keep an existing one)
3. Tap **Save**

The OBS status dot flips to green within a second. Scene switching now works.

> The other fields (audio channels, fade duration) have sensible defaults —
> leave them unless something specific isn't working (see Troubleshooting).

---

## Step 5 — Connect your phone (1 min)

On the **broadcast PC**, open Settings (the ⚙️ icon) and scroll to
**Phone Access**. You'll see one or more URLs like `http://192.168.x.x:3000`
and a QR code.

On your **phone** (same WiFi as the PC):

- **Scan the QR code**, or
- **Type the URL** into the browser

The controller loads. For a native-app feel:

- **iPhone:** Safari → Share → **Add to Home Screen**
- **Android:** Chrome → menu → **Install app**

> 📱 You can connect multiple phones/tablets at once — they all stay in sync.

---

## Step 6 — Using the controller

Everything here also works on the PC's browser, but it's designed for a phone.

### Scenes (top)
Tap **Live / Spotify / Zen** to switch OBS scenes instantly.

### Volume faders
- **TV Broadcast** — the main audio (your game / stream / browser)
- **Spotify** — the halftime music
- Drag to set level, tap **🔇** to mute a channel
- **Double-tap a fader** to cycle through common levels

### The big buttons (bottom)
- **▶ Game On** — switches to the live feed *and* fades the music out
- **🎵 Break** — switches to Spotify *and* fades the broadcast audio down

These do two things at once (scene + smooth audio crossfade over ~1 second),
so one person can run a clean halftime transition with a single tap.

### Extras
- **🌙 moon icon** — dim the screen (for dark rooms)
- **≡ icon** — the activity log (timestamped history of every action)
- **timer** — how long since you connected

---

## Troubleshooting

### OBS dot is red, scenes don't switch
The WebSocket password is wrong or the server is off. In OBS: **Tools →
WebSocket Server Settings**, make sure it's **enabled**, then re-copy the
password and paste it into the app's Settings (⚙️). Click Save.

### Audio faders move but nothing changes
The app controls volume per **program name**. If your audio comes from an app
not in the list, the fader can't reach it. Open **Settings → Channel 3 apps**
and add the program's name (the `.exe`, without `.exe` — e.g. `vlc`, `discord`).
The defaults cover common browsers + OBS + Spotify.

### Phone says "can't connect"
The phone and PC aren't on the same network. Home/office WiFi works.
**Campus or public WiFi (Eduroam, hotel WiFi) blocks device-to-device
connections** — use a Windows Mobile Hotspot instead (Settings → Network →
Mobile Hotspot), connect the phone to that, and use the hotspot URL from
the Settings → Phone Access list.

### OBS shows "Failed to find locale/en-US.ini"
This was a launcher bug and is fixed — re-run `.\start.bat` (it auto-updates).
If it persists, fully close OBS and start it via `start.bat` again.

### Server window disappeared / app stopped
Close everything and re-run `.\start.bat`. If it keeps crashing, the
**"jnk Live Assist - Server"** window shows the error — open Settings →
Health (top bar) for live status, and check that window's output.

### I want to start fresh
Re-run the installer command from Step 1 — it updates the existing install
in place without losing your `.env`.

---

## Network notes

| Network | Works? | Notes |
|---------|--------|-------|
| Home / office WiFi | ✅ | Phone and PC on the same router |
| Ethernet (PC) + WiFi (phone, same router) | ✅ | Common — PC wired, phone wireless |
| Eduroam / public / campus WiFi | ❌ | Client isolation blocks phone→PC |
| Eduroam **+ Windows Mobile Hotspot** | ✅ | PC stays on Eduroam, phone joins the hotspot |

The server listens on all the PC's network addresses. Settings → Phone Access
lists every reachable URL — pick the one matching the network your phone is on.

---

## Day-to-day use

Once set up, you don't repeat Steps 1–2. Each time:

```powershell
cd C:\Users\<you>\jnk-live-assist
.\start.bat
```

Then open the controller on your phone (or bookmark it). That's it.

---

*Need more detail on every option? See `README.md`. Stuck? Open Settings →
Health in the app for live status, or check the server window for errors.*
