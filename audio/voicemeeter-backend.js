/**
 * VoicemeeterBackend — wraps voicemeeter-remote behind the AudioBackend
 * interface. 1:1 with the legacy hard-coded strip mapping:
 *
 *   3 → TV Broadcast
 *   4 → Spotify
 *
 * Full power-user behaviour preserved: health checks, exponential
 * reconnect, server-side mute tracking, auto-reconnect on disconnect.
 */

const AudioBackend = require('./interface');

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEALTH_CHECK_MS = 30000;

class VoicemeeterBackend extends AudioBackend {
    constructor({ healthProbeStrip = 3 } = {}) {
        super();
        this.name = 'voicemeeter';
        this._vm = null;
        this._connected = false;
        this._shuttingDown = false;
        this._reconnectAttempt = 0;
        this._reconnectTimer = null;
        this._healthTimer = null;
        this._healthProbeStrip = healthProbeStrip;

        // Mute state tracked server-side (VM reads can be stale)
        this._muteState = { 3: false, 4: false };

        // The last gain we successfully commanded per channel.
        // Voicemeeter's reported gain can lag behind our writes — its
        // parameter cache refreshes on Voicemeeter's own schedule
        // (that's what VBVMR_IsParametersDirty() exists to signal) —
        // so save/restore snapshots must trust what we SENT, not what
        // VM currently reports, or switching Game↔Break captures the
        // wrong level and the channel "never goes back up". Seeded
        // from a real VM read on connect (syncInitialState).
        this._commandedGain = {};
    }

    // ── Lifecycle ─────────────────────────────────────────────────

    async init() {
        try {
            this._vm = require('voicemeeter-remote');
        } catch (e) {
            throw new Error('voicemeeter-remote module not available: ' + (e.message || e));
        }
        await this._connect();
    }

    async shutdown() {
        this._shuttingDown = true;
        this._stopHealthCheck();
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        this._connected = false;
    }

    isConnected() { return this._connected; }

    getCapabilities() {
        return Object.freeze({
            perChannelVolume: true,
            mute: true,
            profiles: true,
            sceneAutoProfile: true,
            fade: true,
            units: 'db',
        });
    }

    // ── Channel operations ───────────────────────────────────────

    async getChannelState(channelId) {
        if (!this._connected) return { gainDb: -60, muted: true };
        try {
            return { gainDb: this._vm.getStripGain(channelId), muted: this._muteState[channelId] ?? false };
        } catch (e) {
            return { gainDb: -60, muted: true };
        }
    }

    async setChannelGain(channelId, gainDb) {
        if (!this._connected) return;
        this._vm.setStripGain(channelId, gainDb);
        this._commandedGain[channelId] = gainDb;
    }

    /**
     * Last gain we sent to a channel (or undefined if never set).
     * Prefer this over a fresh VM read for save/restore snapshots —
     * VM's parameter cache can lag, so a read right after a write can
     * return the OLD value and corrupt the snapshot.
     */
    getLastCommandedGain(channelId) {
        return this._commandedGain[channelId];
    }

    async toggleMute(channelId) {
        if (!this._connected) return { muted: false };
        const nowMuted = !this._muteState[channelId];
        this._muteState[channelId] = nowMuted;
        this._vm.setStripMute(channelId, nowMuted);
        return { muted: nowMuted };
    }

    /** Voicemeeter is synchronous — bypass the sequential default. */
    async setMultiChannelGain(gains) {
        if (!this._connected) return;
        for (const [id, db] of Object.entries(gains)) {
            const n = Number(id);
            this._vm.setStripGain(n, db);
            this._commandedGain[n] = db;
        }
    }

    /**
     * Voicemeeter-optimised fade.
     *
     *   • Batches every channel into ONE `VBVMR_SetParameters` script
     *     call per step (one FFI transition instead of N) so Voicemeeter
     *     applies them atomically — no inter-channel skew, and far less
     *     DLL traffic for the ramp to keep up with.
     *   • Schedules each step from the fade START time, compensating
     *     for Windows' ~15 ms timer granularity. A naive per-step
     *     setTimeout stretches a 900 ms fade to ~1.5 s and makes the
     *     ramp sound lumpy.
     *   • Yields with setImmediate between steps so socket / OBS
     *     traffic stays responsive mid-fade.
     *   • A step that throws (transient DLL hiccup) is logged but does
     *     NOT abort the fade. The final target is always re-committed
     *     at the end as a safety net so the fade never gets stuck
     *     part-way — which is what users hear as a "jump to zero".
     *   • Calls onProgress(gains) each step so callers can animate UI
     *     faders in lockstep with the actual audio ramp.
     */
    async applyPreset({ channels, durationMs, onProgress }) {
        if (!this._connected || !channels || channels.length === 0) return;
        const fadeSteps = 60;
        const stepMs = Math.max(1, Math.round(durationMs / fadeSteps));
        const fadeStart = Date.now();
        let lastErr = null;
        for (let i = 0; i <= fadeSteps; i++) {
            const p = i / fadeSteps;
            const gains = {};
            const parts = [];
            for (const ch of channels) {
                const g = ch.fromDb * (1 - p) + ch.toDb * p;
                gains[ch.id] = g;
                // One script line per channel: Strip[n].Gain=db;
                parts.push('Strip[' + ch.id + '].Gain=' + (+g).toFixed(3) + ';');
            }
            try {
                this._vm.setRawParameters(parts.join(''));
            } catch (e) {
                lastErr = e;   // keep going — a blip shouldn't abort the ramp
            }
            if (onProgress) { try { onProgress(gains); } catch (_) { /* caller's problem */ } }
            const nextAt = fadeStart + Math.round((i + 1) * stepMs);
            while (Date.now() < nextAt) {
                await new Promise(r => setImmediate(r));
            }
        }
        // Safety net: guarantee the final target is committed and our
        // commanded-gain cache reflects it, even if a step errored.
        for (const ch of channels) {
            this._commandedGain[ch.id] = ch.toDb;
            try { this._vm.setStripGain(ch.id, ch.toDb); } catch (e) { /* best effort */ }
        }
        if (lastErr) {
            this._log('applyPreset: non-fatal error during fade: ' + (lastErr && lastErr.message ? lastErr.message : lastErr));
        }
    }

    syncInitialState() {
        const mute = {}, fader = {};
        if (!this._connected) return { mute, fader };
        for (const ch of [3, 4]) {
            try {
                this._muteState[ch] = this._vm.getStripMute(ch) !== 0;
                mute[ch] = this._muteState[ch];
                const g = this._vm.getStripGain(ch);
                fader[ch] = g;
                this._commandedGain[ch] = g;   // seed the cache from reality
            } catch (e) { /* skip */ }
        }
        return { mute, fader };
    }

    // ── Connection management ────────────────────────────────────

    async _connect() {
        this._reconnectAttempt++;
        const attempt = this._reconnectAttempt;
        this._log(`Voicemeeter: connecting (attempt ${attempt})…`);

        try {
            await this._vm.init();
            await this._vm.login();
            await this._vm.updateDeviceList();
            this._connected = true;
            this._reconnectAttempt = 0;
            this._log('Connected to Voicemeeter');
            this._startHealthCheck();
            this._emitStatus(true, 'Connected to Voicemeeter');
        } catch (err) {
            this._connected = false;
            this._stopHealthCheck();
            const msg = err && err.message ? err.message : err;
            this._log(`Voicemeeter not available (attempt ${attempt}) — audio controls disabled: ${msg}`);
            this._emitStatus(false, 'Voicemeeter not available');
            this._scheduleReconnect();
        }
    }

    _scheduleReconnect() {
        if (this._shuttingDown || this._reconnectTimer) return;
        const delay = Math.min(RECONNECT_INITIAL_MS * Math.pow(2, this._reconnectAttempt), RECONNECT_MAX_MS);
        this._log(`Voicemeeter: retrying in ${(delay / 1000).toFixed(1)}s (after attempt ${this._reconnectAttempt})…`);
        this._reconnectTimer = setTimeout(async () => {
            this._reconnectTimer = null;
            await this._connect();
        }, delay);
    }

    /** Force a fresh reconnect (e.g. from health dashboard). */
    async reconnect() {
        this._connected = false;
        this._stopHealthCheck();
        this._reconnectAttempt = 0;
        await this._connect();
    }

    // ── Health probe ─────────────────────────────────────────────

    _startHealthCheck() {
        if (this._healthTimer) return;
        this._log(`VM health check: probing strip ${this._healthProbeStrip} every ${HEALTH_CHECK_MS / 1000}s`);
        this._healthTimer = setInterval(() => {
            if (!this._connected) return;
            try {
                this._vm.getStripGain(this._healthProbeStrip);
            } catch (err) {
                this._log('VM health check failed: ' + (err && err.message ? err.message : err));
                this._connected = false;
                this._stopHealthCheck();
                this._emitStatus(false, 'Voicemeeter connection lost');
                this._scheduleReconnect();
            }
        }, HEALTH_CHECK_MS);
    }

    _stopHealthCheck() {
        if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    }
}

module.exports = VoicemeeterBackend;
