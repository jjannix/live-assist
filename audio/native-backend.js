/**
 * NativeBackend — per-app volume via native-sound-mixer.
 *
 * For users who don't want (or can't) install Voicemeeter. Talks straight
 * to the Windows Core Audio API through the `native-sound-mixer` native
 * addon — no PowerShell, no sidecar, no extra software.
 *
 * Channel mapping is env-driven (defaults match the VM layout):
 *   AUDIO_CHANNEL_3_APPS=obs64,chrome   → logical channel 3 (TV)
 *   AUDIO_CHANNEL_4_APPS=spotify        → logical channel 4 (Spotify)
 *
 * Each "channel" is a *group* of Windows audio sessions (one per app).
 * Setting the channel volume sets every still-active session in the
 * group. Reading the channel volume returns the *average* of active
 * sessions in the group.
 *
 * Sessions come and go as apps start/stop, so we rescan the device list
 * every RESCAN_MS. EXPIRED sessions are skipped on read/write so apps
 * that just closed don't throw.
 *
 * Volume normalisation lives in ./conversions:
 *   -60 dB ↔ 0.0 scalar,  0 dB ↔ 0.833 scalar,  +12 dB ↔ 1.0 scalar
 */

const AudioBackend = require('./interface');
const { dbToScalar, scalarToDb } = require('./conversions');

const RESCAN_MS = 10_000;     // how often we look for newly-started apps

class NativeBackend extends AudioBackend {
    constructor({ channelMap = {} } = {}) {
        super();
        this.name = 'native';
        this._sm = null;
        this._connected = false;
        this._scanTimer = null;

        // channelMap: { 3: { name, apps: ['obs64', 'chrome'] }, 4: { … } }
        this._channelMap = channelMap;
        this._channelIds = Object.keys(channelMap).map(Number);

        // channelId → AudioSession[] (refreshed on every rescan)
        this._sessions = {};
        for (const id of this._channelIds) this._sessions[id] = [];

        // Server-side mute tracking — read-on-demand from the addon can be
        // racy and we want the UI to reflect exactly what we last wrote.
        this._muteState = {};
        for (const id of this._channelIds) this._muteState[id] = false;
    }

    // ── Lifecycle ─────────────────────────────────────────────────

    async init() {
        // Lazy require so missing/broken native binary doesn't kill the
        // whole server — the factory falls back to NullBackend instead.
        let sm;
        try {
            sm = require('native-sound-mixer');
        } catch (e) {
            throw new Error('native-sound-mixer module not available: ' + (e.message || e));
        }
        // The package exports `default` AND the enum types on the same
        // object. The mixer is the default export.
        this._sm = sm.default || sm;

        // Sanity check — bail early if the addon didn't load properly
        // (e.g. the prebuilt binary doesn't match the host arch).
        if (!this._sm || !Array.isArray(this._sm.devices)) {
            throw new Error('native-sound-mixer returned no device list — is the native binary compatible with this system?');
        }

        // First scan has to succeed (or at least not throw) before we
        // claim the backend is online. If no apps are running yet every
        // channel will simply be empty — that's still a valid state.
        this._rescan();

        this._connected = true;
        this._log('Native audio backend ready (' + this._sm.devices.length + ' device(s))');
        this._logSessionMap();
        this._emitStatus(true, 'Native audio backend ready');

        // Periodic rescan so newly-started apps join their channel
        this._scanTimer = setInterval(() => {
            try { this._rescan(); this._logSessionMap(); } catch (e) {
                this._log('Rescan failed: ' + (e && e.message ? e.message : e));
            }
        }, RESCAN_MS);
    }

    async shutdown() {
        if (this._scanTimer) { clearInterval(this._scanTimer); this._scanTimer = null; }
        this._connected = false;
    }

    isConnected() { return this._connected; }

    getCapabilities() {
        // The native backend can do volume + mute per channel, can fade,
        // but doesn't have a "save preset" concept — VM-side profiles
        // stay a VM-only feature.
        return Object.freeze({
            perChannelVolume: true,
            mute: true,
            profiles: false,
            sceneAutoProfile: false,
            fade: true,
            units: 'db',
        });
    }

    // ── Channel operations ───────────────────────────────────────

    async getChannelState(channelId) {
        const sessions = this._activeSessions(channelId);
        if (sessions.length === 0) {
            // Nothing to read — return last-known / safe default
            return { gainDb: -60, muted: this._muteState[channelId] ?? false };
        }
        let sum = 0;
        for (const s of sessions) sum += (typeof s.volume === 'number' ? s.volume : 0);
        return { gainDb: scalarToDb(sum / sessions.length), muted: this._muteState[channelId] ?? false };
    }

    async setChannelGain(channelId, gainDb) {
        const scalar = dbToScalar(gainDb);
        const sessions = this._activeSessions(channelId);
        for (const s of sessions) {
            try { s.volume = scalar; } catch (e) { /* expired mid-call */ }
        }
        if (sessions.length === 0 && this._log) {
            // Quiet hint — apps that aren't running shouldn't be loud
            this._log('setChannelGain(' + channelId + '): no active app sessions for this channel');
        }
    }

    async toggleMute(channelId) {
        const nowMuted = !this._muteState[channelId];
        this._muteState[channelId] = nowMuted;
        const sessions = this._activeSessions(channelId);
        for (const s of sessions) {
            try { s.mute = nowMuted; } catch (e) { /* expired mid-call */ }
        }
        return { muted: nowMuted };
    }

    /**
     * Tight, native-optimised fade. The base-class fade works but pays
     * the cost of `await setMultiChannelGain` per step, and
     * `setMultiChannelGain` then awaits per-channel, then we await
     * per-session. That's three layers of unnecessary `await` for what
     * is fundamentally a synchronous property write into the addon.
     * Result: a 900 ms fade runs in ~1.9 s on the native backend.
     *
     * Here we do one conversion + one tight loop of session writes per
     * channel per step, and only the per-step timing is awaited. 30
     * steps is plenty for a smooth ramp, and we measure the per-step
     * FFI work so we can shorten the next setTimeout by that amount,
     * keeping the total fade close to the requested `durationMs` even
     * with 4–5 active sessions per channel.
     */
    async applyPreset({ channels, durationMs }) {
        const fadeSteps = 30;
        const stepMs = Math.max(1, Math.round(durationMs / fadeSteps));
        // Cache the session list per channel so we don't refilter on
        // every step. Rescanning mid-fade is wasted work; if a session
        // expires during a fade we just skip it.
        const targets = channels.map(ch => ({
            id: ch.id,
            fromDb: ch.fromDb,
            toDb: ch.toDb,
            sessions: this._activeSessions(ch.id),
        }));
        for (const t of targets) {
            if (t.sessions.length === 0) {
                this._log('applyPreset: channel ' + t.id + ' has no active app sessions — fade is a no-op for this channel');
            }
        }
        const fadeStart = Date.now();
        for (let i = 0; i <= fadeSteps; i++) {
            const p = i / fadeSteps;
            // Linear dB ramp
            for (const t of targets) {
                const gainDb = t.fromDb * (1 - p) + t.toDb * p;
                const scalar = dbToScalar(gainDb);
                for (const s of t.sessions) {
                    try { s.volume = scalar; } catch (e) { /* expired mid-call */ }
                }
            }
            // Sleep until the *next* step should fire, measured from the
            // start of the fade. This is more accurate than per-step
            // setTimeout, which on Windows has an effective granularity
            // of ~15 ms that would stretch a 1000 ms fade to ~1500 ms.
            // We yield with setImmediate so the event loop stays
            // responsive to socket / OBS events mid-fade.
            const target = fadeStart + Math.round((i + 1) * stepMs);
            while (Date.now() < target) {
                await new Promise(r => setImmediate(r));
            }
        }
    }

    syncInitialState() {
        const mute = {}, fader = {};
        for (const id of this._channelIds) {
            const s = this._activeSessions(id);
            if (s.length === 0) continue;
            // Average volume of currently-active sessions
            let sum = 0;
            for (const sess of s) sum += (typeof sess.volume === 'number' ? sess.volume : 0);
            fader[id] = scalarToDb(sum / s.length);
            mute[id] = this._muteState[id];
        }
        return { mute, fader };
    }

    // ── Internal: session discovery ──────────────────────────────

    /**
     * Walk every device → every session, match against the channel map
     * by process / display name (case-insensitive substring). Updates
     * this._sessions.
     */
    _rescan() {
        const devices = this._sm.devices;
        // Wipe and rebuild — session objects from the previous scan
        // may be stale (process exited) and we want a fresh view.
        const next = {};
        for (const id of this._channelIds) next[id] = [];

        for (const dev of devices) {
            // Both render (speakers/headphones) and capture (mic) can host
            // sessions we care about, but most use-cases are on the
            // render device. Walk all of them — it's cheap.
            const sessions = dev.sessions || [];
            for (const sess of sessions) {
                if (sess.state === 2 /* EXPIRED */) continue;
                const ch = this._matchChannel(sess);
                if (ch !== null) next[ch].push(sess);
            }
        }
        this._sessions = next;
    }

    /** Log current channel → session mapping (debug aid). */
    _logSessionMap() {
        for (const id of this._channelIds) {
            const list = this._activeSessions(id);
            if (list.length === 0) {
                this._log('  channel ' + id + ' (' + this._channelMap[id].name + '): no active app sessions');
            } else {
                const names = list.map(s => s.name || s.appName || '?').join(', ');
                this._log('  channel ' + id + ' (' + this._channelMap[id].name + '): ' + list.length + ' session(s) — ' + names);
            }
        }
    }

    _matchChannel(session) {
        // The session exposes `name` (display name) and `appName` (exe
        // path) on Windows. Match either, case-insensitive substring.
        const hay = ((session.name || '') + ' ' + (session.appName || '')).toLowerCase();
        for (const id of this._channelIds) {
            const apps = this._channelMap[id].apps || [];
            for (const app of apps) {
                if (!app) continue;
                if (hay.includes(app.toLowerCase())) return id;
            }
        }
        return null;
    }

    _activeSessions(channelId) {
        const list = this._sessions[channelId] || [];
        // Filter out anything that's gone EXPIRED between scans
        return list.filter(s => s && s.state !== 2);
    }

}

module.exports = NativeBackend;
