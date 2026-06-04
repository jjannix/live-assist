/**
 * VoicemeeterBackend — wraps voicemeeter-remote behind the AudioBackend interface.
 *
 * This preserves 100 % of the existing power-user behaviour while presenting
 * a clean contract to server.js.
 *
 * Channel mapping (same as legacy hard-coded strips):
 *   3 → TV Broadcast strip
 *   4 → Spotify strip
 */

const AudioBackend = require('./interface');

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEALTH_CHECK_MS = 30000;

class VoicemeeterBackend extends AudioBackend {
    constructor({ healthProbeStrip = 3 } = {}) {
        super();
        this.name = 'voicemeeter';
        this._vm = null;          // voicemeeter-remote module
        this._connected = false;
        this._shuttingDown = false;
        this._reconnectAttempt = 0;
        this._reconnectTimer = null;
        this._healthTimer = null;
        this._healthProbeStrip = healthProbeStrip;

        // Mute state tracked server-side (mirrors VM but avoids stale reads)
        this._muteState = { 3: false, 4: false };

        this._log = () => {}; // replaced by server with real logger
    }

    /** Inject a logging function: (message) => void */
    setLogger(fn) { this._log = fn; }

    // ── AudioBackend interface ────────────────────────────────────

    async init() {
        // Lazy-load so the require doesn't throw if module is absent
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

    async getChannelState(channelId) {
        if (!this._connected) return { gainDb: -60, muted: true };
        try {
            const gainDb = this._vm.getStripGain(channelId);
            const muted = this._muteState[channelId] ?? false;
            return { gainDb, muted };
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

    /**
     * Voicemeeter supports synchronous writes — override for
     * lower-latency batch sets during fades.
     */
    async setMultiChannelGain(gains) {
        if (!this._connected) return;
        for (const [id, db] of Object.entries(gains)) {
            this._vm.setStripGain(Number(id), db);
        }
    }

    // ── Connection management ─────────────────────────────────────

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

    /** Force a reconnect (e.g. from health dashboard). */
    async reconnect() {
        this._connected = false;
        this._stopHealthCheck();
        this._reconnectAttempt = 0;
        await this._connect();
    }

    // ── Health check ──────────────────────────────────────────────

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

    /**
     * Synchronise internal mute state from Voicemeeter (called after connect).
     * Returns the state so server can forward to clients.
     */
    syncInitialMuteState() {
        const result = {};
        if (!this._connected) return result;
        for (const ch of [3, 4]) {
            try {
                const muted = this._vm.getStripMute(ch) !== 0;
                this._muteState[ch] = muted;
                result[ch] = muted;
            } catch (e) { /* skip */ }
        }
        return result;
    }

    /**
     * Read initial fader levels from Voicemeeter.
     * Returns { channelId: gainDb } map.
     */
    syncInitialFaderState() {
        const result = {};
        if (!this._connected) return result;
        for (const ch of [3, 4]) {
            try {
                result[ch] = this._vm.getStripGain(ch);
            } catch (e) { /* skip */ }
        }
        return result;
    }
}

module.exports = VoicemeeterBackend;
