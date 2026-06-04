/**
 * AudioBackend — abstract base class / contract.
 *
 * Every concrete backend must override the methods marked "abstract".
 * The base class provides a default fade implementation (applyPreset)
 * and status-change plumbing.
 *
 * Channel IDs are opaque strings/numbers agreed between server and UI.
 * Currently the UI uses stripIndex 3 (TV) and 4 (Spotify); backends
 * map those to their own physical resources internally.
 */
class AudioBackend {
    constructor() {
        this._statusCallback = null;
        this.name = 'base';
    }

    // ── Abstract: override in every concrete backend ──────────────

    /** Initialise the backend (connect, spawn helpers, etc.). */
    async init() { throw new Error('init() not implemented'); }

    /** Gracefully release resources. */
    async shutdown() { /* no-op by default */ }

    /** @returns {boolean} */
    isConnected() { return false; }

    /**
     * @returns {{ perChannelVolume, mute, profiles, sceneAutoProfile, fade, units }}
     */
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

    /**
     * Read current state for a logical channel.
     * @param {number|string} channelId
     * @returns {Promise<{ gainDb: number, muted: boolean }>}
     */
    async getChannelState(channelId) { return { gainDb: -60, muted: true }; }

    /**
     * Set gain in dB for a single channel.
     * @param {number|string} channelId
     * @param {number} gainDb
     */
    async setChannelGain(channelId, gainDb) { /* no-op */ }

    /**
     * Toggle mute for a channel.
     * @param {number|string} channelId
     * @returns {Promise<{ muted: boolean }>}
     */
    async toggleMute(channelId) { return { muted: false }; }

    // ── Concrete helpers (override only if backend needs custom fade) ──

    /**
     * Set gains for multiple channels at once.
     * Default implementation calls setChannelGain sequentially.
     * Backends that benefit from batching should override.
     *
     * @param {Object<number,number>} gains  channelId → gainDb
     */
    async setMultiChannelGain(gains) {
        for (const [id, db] of Object.entries(gains)) {
            await this.setChannelGain(Number(id), db);
        }
    }

    /**
     * Smoothly fade channels from one set of gains to another.
     *
     * @param {{ channels: Array<{id:number, fromDb:number, toDb:number}>, durationMs:number }} opts
     */
    async applyPreset({ channels, durationMs }) {
        const fadeSteps = 60;
        const stepDuration = durationMs / fadeSteps;

        for (let i = 0; i <= fadeSteps; i++) {
            const progress = i / fadeSteps;
            const gains = {};
            for (const ch of channels) {
                gains[ch.id] = Math.round(ch.fromDb * (1 - progress) + ch.toDb * progress);
            }
            await this.setMultiChannelGain(gains);
            await new Promise(r => setTimeout(r, stepDuration));
        }
    }

    // ── Status callback plumbing ─────────────────────────────────

    /**
     * Register a callback invoked on connection state changes.
     * @param {(connected:boolean, detail?:string) => void} cb
     */
    onStatusChange(cb) { this._statusCallback = cb; }

    /** @protected */
    _emitStatus(connected, detail) {
        if (this._statusCallback) this._statusCallback(connected, detail);
    }
}

module.exports = AudioBackend;
