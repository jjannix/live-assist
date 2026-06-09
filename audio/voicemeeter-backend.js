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
            this._vm.setStripGain(Number(id), db);
        }
    }

    syncInitialState() {
        const mute = {}, fader = {};
        if (!this._connected) return { mute, fader };
        for (const ch of [3, 4]) {
            try {
                this._muteState[ch] = this._vm.getStripMute(ch) !== 0;
                mute[ch] = this._muteState[ch];
                fader[ch] = this._vm.getStripGain(ch);
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
