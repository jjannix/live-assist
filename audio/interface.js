/**
 * AudioBackend — abstract base class / contract.
 *
 * Each concrete backend (voicemeeter, native, …) overrides what it needs.
 * The base class provides:
 *   - a default smooth-fade implementation
 *   - a status-change callback slot
 *
 * Channel IDs are the same numbers the UI / Voicemeeter contract already
 * use: 3 → TV Broadcast, 4 → Spotify. Backends map them to whatever
 * physical resources they actually have (VM strips, app session groups, …).
 */

class AudioBackend {
    constructor() {
        this._statusCallback = null;
        this.name = 'base';
    }

    /** Inject a logger: (message: string) => void */
    setLogger(fn) { this._log = fn || (() => {}); }
    _log(msg) { /* default no-op; replaced by setLogger */ }

    // ── Lifecycle ─────────────────────────────────────────────────

    async init()            { throw new Error('init() not implemented'); }
    async shutdown()        { /* no-op by default */ }
    isConnected()           { return false; }

    // ── Capabilities (used by server to gate UI features) ────────

    getCapabilities() {
        return Object.freeze({
            perChannelVolume: false,
            mute: false,
            profiles: false,
            sceneAutoProfile: false,
            fade: false,
            units: 'db',
        });
    }

    // ── Channel operations (the contract) ────────────────────────

    /**
     * Read state for a logical channel.
     * @returns {Promise<{ gainDb: number, muted: boolean }>}
     */
    async getChannelState(/* channelId */) { return { gainDb: -60, muted: true }; }

    /** Set gain in dB for a single channel. */
    async setChannelGain(/* channelId, gainDb */) { /* no-op */ }

    /**
     * Toggle mute for a channel.
     * @returns {Promise<{ muted: boolean }>}
     */
    async toggleMute(/* channelId */) { return { muted: false }; }

    /**
     * Set gains for multiple channels at once. Override only if your
     * backend benefits from batching.
     */
    async setMultiChannelGain(gains) {
        for (const [id, db] of Object.entries(gains)) {
            await this.setChannelGain(Number(id), db);
        }
    }

    /**
     * Smoothly fade multiple channels from current to target.
     *
     * @param {{ channels: Array<{id:number, fromDb:number, toDb:number}>, durationMs:number }} opts
     */
    async applyPreset({ channels, durationMs }) {
        const fadeSteps = 60;
        const stepMs = Math.max(1, Math.round(durationMs / fadeSteps));
        for (let i = 0; i <= fadeSteps; i++) {
            const p = i / fadeSteps;
            const gains = {};
            for (const ch of channels) {
                gains[ch.id] = ch.fromDb * (1 - p) + ch.toDb * p;
            }
            await this.setMultiChannelGain(gains);
            await new Promise(r => setTimeout(r, stepMs));
        }
    }

    /**
     * Read initial state for newly-connected clients. Implementations
     * should return objects shaped like { mute: { 3, 4 }, fader: { 3, 4 } }
     * containing only the channels the backend knows about.
     */
    syncInitialState() { return { mute: {}, fader: {} }; }

    // ── Status callback plumbing ─────────────────────────────────

    onStatusChange(cb) { this._statusCallback = cb; }
    _emitStatus(connected, detail) {
        if (this._statusCallback) this._statusCallback(connected, detail);
        if (detail) this._log(detail);
    }
}

module.exports = AudioBackend;
