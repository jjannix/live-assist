# OBS Setup for jnk Live Assist

This is the **broadcast setup** — how to get your live feed into OBS and out to
the beamer. Do this once; afterwards the app just switches between the scenes
you build here.

If you only want the app side (install, password, phone), see
[`SETUP.md`](SETUP.md). This doc is for configuring OBS itself.

---

## The setup at a glance

```
  Live TV feed (browser / player)
        │  pop out as Picture-in-Picture
        ▼
  Floating video window (clean, no UI)
        │  OBS Window Capture
        ▼
  OBS Scene: "Live Übertragung"
        │  Fullscreen Projector
        ▼
        Beamer
```

The app then switches this scene ↔ **Spotify** (halftime).

---

## Before you start

| Thing | Why |
|-------|-----|
| The beamer connected to the laptop (HDMI) | It's the broadcast display |
| Windows display mode set to **Extend** | So the beamer is a separate screen, not a mirror |
| Your live stream open in a browser or player | The source you'll capture |

> 🔧 **Set "Extend" first:** Win + P → **Extend**. If it's on *Duplicate*,
> the beamer mirrors your laptop (showing the OBS interface, not the clean
> output) — the most common projection mistake.

---

## Step 1 — Open your live feed

Open the match stream in your browser (or media player) and start playback.
Make sure:

- It's actually playing video before you continue
- You're logged in / past any paywall
- The video has a **Picture-in-Picture** option (most browser video players do
  — look for the PiP icon, or right-click the video twice)

You don't need fullscreen here. You're about to pop just the video out.

---

## Step 2 — Pop it out as Picture-in-Picture

Trigger PiP on the video:

- **Browser video:** right-click the player → **Picture in Picture**
  (or click the PiP button in the player controls)
- **Some players:** a dedicated PiP / pop-out button

A small, borderless floating window appears containing **just the video** —
no browser chrome, no tabs, no player UI. This is what OBS will capture.

> 💡 **Why PiP instead of capturing the browser?** PiP gives you a clean video
> window free of toolbars, scrollbars, and ads. It's the most reliable way to
> get just the picture into OBS.
>
> 🔤 **Don't close the source browser/tab** while broadcasting — closing it
> ends the PiP window. You can minimise it; just don't close it.

Optionally drag the PiP window to a corner of your laptop screen and resize it.
(Window Capture grabs it at native resolution regardless of on-screen size, so
this is just to keep it out of your way.)

---

## Step 3 — Create the scenes in OBS

You need **2 scenes** (a 3rd is optional). Names must match **exactly** —
character for character, including spaces and accents — because the app looks
for these literal names.

| # | Scene name | What it shows | Required? |
|---|------------|---------------|-----------|
| 1 | **`Live Übertragung`** | The match (your PiP capture) | ✅ yes |
| 2 | **`Spotify`** | Halftime music | ✅ yes |
| 3 | **`Zen`** | Idle / pre-game logos | optional |

> 🔤 **Spelling matters.** It's `Live Übertragung` — capital `U`, `Ü`.
> Copy-paste from here if you can't type `Ü`. A wrong name means the app's
> scene button silently fails to switch.

Create the scenes in OBS (the **Scenes** box, bottom-left → `+`).

### Scene 1 — "Live Übertragung" (the match)

1. Select the scene, then in **Sources** → `+` → **Window Capture**
2. Name it e.g. `Live PiP`, click OK
3. In the properties, set **Window** to the floating PiP window
   (it's usually titled `Picture-in-Picture` or the video title)
4. Click OK — the video appears in the canvas
5. Right-click the source in the preview → **Transform → Fit to screen**
   (use **Stretch** instead if you want to fill the beamer and remove black bars)

> ⚠️ **Black box instead of video?** PiP windows are overlay windows, which
> some capture methods can't see. If Window Capture shows black, try these in
> order:
> 1. In the Window Capture properties, toggle **Compatibility Mode** on.
> 2. Delete it and add **Window Capture (Windows 10+)** instead — the modern
>    capture method handles overlays better.
> 3. Fall back to **Display Capture** of the screen the PiP sits on (less
>    clean, but always works).

### Scene 2 — "Spotify" (halftime)

This is what's on the beamer during breaks. Two common options:

- **Window Capture of Spotify** — shows the now-playing artwork/visualiser
- **An image source** (club logo / sponsor board)

Add whichever fits your break vibe.

### (Optional) Scene 3 — "Zen" (idle)

A static logo or attract image for pre-game / timeouts. Add an **Image**
source. Skip it entirely if you don't need an idle screen.

---

## Step 4 — Fullscreen projection to the beamer

Send the OBS output to the beamer:

1. In OBS, **right-click the preview** (the canvas)
2. → **Fullscreen Projector (Program)**
3. → Select the **beamer display** (the second monitor, usually "2")

The beamer now shows the OBS program output, fullscreen, no OBS UI. Your
laptop keeps the OBS control window.

> 💡 **Program vs Preview:** "Projector (Program)" shows what's actually live
> (after transitions). "Projector (Preview)" shows the scene you're hovering
> on. For public viewing use **Program** so the beamer never flashes an
> unready scene.

The beamer should now show your `Live Übertragung` scene full-bleed.

---

## Step 5 — Verify with the app

1. Start jnk Live Assist: `.\start.bat` (in the install folder)
2. Enter your OBS WebSocket password in the app's ⚙️ Settings if you haven't
3. Connect your phone (Settings → Phone Access → scan the QR code)
4. On the phone, tap **Live** and **Spotify**

The beamer should now switch scenes when you tap **Live** and **Spotify** in
the app.

If the beamer doesn't switch: check the OBS dot in the app's top bar is green
(see `SETUP.md` → Troubleshooting).

---

## Quick reference

| Want to… | Do this |
|----------|---------|
| Get clean video into OBS | PiP the source, then Window Capture the PiP window |
| Match the video to the beamer | Right-click source → Transform → Fit to screen |
| Send OBS to the beamer | Right-click preview → Fullscreen Projector (Program) → display 2 |
| Switch scenes by phone | That's the app — `start.bat` + ⚙️ Settings + scan QR |

---

## Common gotchas

- **Beamer shows the OBS interface, not just video** — Windows is on
  Duplicate. Win + P → **Extend**, then re-do the Fullscreen Projector.
- **Window Capture is black** — PiP is an overlay. Use **Window Capture
  (Windows 10+)** or toggle Compatibility Mode (see Step 3).
- **Scene button does nothing** — scene name spelling. Must be exactly
  `Live Übertragung` / `Spotify`.

---

*Once this is configured, you rarely touch OBS again. Day to day it's just
`.\start.bat` and your phone. See `SETUP.md` for the app side.*
