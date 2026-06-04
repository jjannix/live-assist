/**
 * Audio backend factory.
 *
 * Reads AUDIO_BACKEND from env (default: "auto") and returns the
 * appropriate backend instance.
 *
 * Modes:
 *   "auto"           → Voicemeeter if module loads & connects, else windows-simple
 *   "voicemeeter"    → VoicemeeterBackend (throws if unavailable)
 *   "windows-simple" → WindowsSimpleBackend
 *   "none"           → NullBackend (no audio, OBS-only mode)
 */

const AudioBackend = require('./interface');

// ── Null backend (no-op) ──────────────────────────────────────────

class NullBackend extends AudioBackend {
    constructor() { super(); this.name = 'none'; }
    async init() {}
    isConnected() { return false; }
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
}

// ── Factory ───────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {string} [opts.mode]          'auto'|'voicemeeter'|'windows-simple'|'none'
 * @param {number} [opts.healthProbeStrip] Strip index for VM health probe (default 3)
 * @param {Object} [opts.channelMap]     For windows-simple: { channelId: { name, apps } }
 * @returns {AudioBackend}
 */
function createBackend(opts = {}) {
    const mode = (opts.mode || process.env.AUDIO_BACKEND || 'auto').toLowerCase().trim();

    if (mode === 'none') {
        return new NullBackend();
    }

    if (mode === 'voicemeeter') {
        const VoicemeeterBackend = require('./voicemeeter-backend');
        return new VoicemeeterBackend({ healthProbeStrip: opts.healthProbeStrip });
    }

    if (mode === 'windows-simple') {
        const { WindowsSimpleBackend } = require('./windows-simple-backend');
        const channelMap = opts.channelMap || buildChannelMapFromEnv();
        return new WindowsSimpleBackend(channelMap);
    }

    // "auto" — try Voicemeeter first, then fall back
    if (mode === 'auto') {
        try {
            require.resolve('voicemeeter-remote');
            const VoicemeeterBackend = require('./voicemeeter-backend');
            return new VoicemeeterBackend({ healthProbeStrip: opts.healthProbeStrip });
        } catch (e) {
            // Module not installed — fall through to windows-simple
        }

        const { WindowsSimpleBackend } = require('./windows-simple-backend');
        const channelMap = opts.channelMap || buildChannelMapFromEnv();
        return new WindowsSimpleBackend(channelMap);
    }

    throw new Error(`Unknown AUDIO_BACKEND value: "${mode}". Use auto, voicemeeter, windows-simple, or none.`);
}

/**
 * Build channel map from environment variables:
 *   AUDIO_CHANNEL_3_NAME / AUDIO_CHANNEL_3_APPS
 *   AUDIO_CHANNEL_4_NAME / AUDIO_CHANNEL_4_APPS
 */
function buildChannelMapFromEnv() {
    const map = {};
    for (const id of [3, 4]) {
        const name = process.env[`AUDIO_CHANNEL_${id}_NAME`] || (id === 3 ? 'TV' : 'Spotify');
        const appsRaw = process.env[`AUDIO_CHANNEL_${id}_APP`] || process.env[`AUDIO_CHANNEL_${id}_APP`] ||
            (id === 3 ? 'obs64' : 'spotify');
        // Also try plural form
        const appsStr = process.env[`AUDIO_CHANNEL_${id}_APPS`] || appsRaw;
        const apps = appsStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        map[id] = { name, apps };
    }
    return map;
}

module.exports = { createBackend, NullBackend };
