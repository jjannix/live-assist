/**
 * Audio backend factory.
 *
 * Reads AUDIO_BACKEND from env (default: "auto") and returns the
 * appropriate backend instance.
 *
 * Modes:
 *   "auto"           → Voicemeeter if it loads, else native, else none
 *   "voicemeeter"    → VoicemeeterBackend (throws if unavailable)
 *   "native"         → NativeBackend (native-sound-mixer, no extra SW)
 *   "none"           → NullBackend (audio disabled, OBS still works)
 *
 * Channel map (for native backend) is built from env:
 *   AUDIO_CHANNEL_3_NAME / AUDIO_CHANNEL_3_APPS
 *   AUDIO_CHANNEL_4_NAME / AUDIO_CHANNEL_4_APPS
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

// ── Channel map helper ────────────────────────────────────────────

function buildChannelMapFromEnv() {
    const map = {};
    for (const id of [3, 4]) {
        const name = process.env[`AUDIO_CHANNEL_${id}_NAME`] || (id === 3 ? 'TV' : 'Spotify');
        const appsStr = process.env[`AUDIO_CHANNEL_${id}_APPS`]
            || process.env[`AUDIO_CHANNEL_${id}_APP`]
            || (id === 3 ? 'obs64,chrome,firefox,msedge,edge,opera,zen,vivaldi,brave,arc,helium,thorium,discord' : 'spotify');
        const apps = appsStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        map[id] = { name, apps };
    }
    return map;
}

// ── Factory ───────────────────────────────────────────────────────

/**
 * @param {Object}  [opts]
 * @param {string}  [opts.mode]              'auto'|'voicemeeter'|'native'|'none'
 * @param {number}  [opts.healthProbeStrip]  Strip index for VM health probe (default 3)
 * @param {Object}  [opts.channelMap]        For native backend
 * @param {(msg:string)=>void} [opts.logger] Logger forwarded to backend
 * @returns {AudioBackend}
 */
function createBackend(opts = {}) {
    const mode = (opts.mode || process.env.AUDIO_BACKEND || 'auto').toLowerCase().trim();

    const make = (Backend, extraOpts = {}) => {
        const b = new Backend(extraOpts);
        if (opts.logger) b.setLogger(opts.logger);
        return b;
    };

    if (mode === 'none') return make(NullBackend);

    if (mode === 'voicemeeter') {
        const VM = require('./voicemeeter-backend');
        return make(VM, { healthProbeStrip: opts.healthProbeStrip });
    }

    if (mode === 'native') {
        const Native = require('./native-backend');
        return make(Native, { channelMap: opts.channelMap || buildChannelMapFromEnv() });
    }

    if (mode === 'auto') {
        // Try Voicemeeter first (power users get the rich feature set)
        try {
            require.resolve('voicemeeter-remote');
            const VM = require('./voicemeeter-backend');
            return make(VM, { healthProbeStrip: opts.healthProbeStrip });
        } catch (e) { /* not installed — fall through */ }

        // Then native (no extra software required)
        try {
            require.resolve('native-sound-mixer');
            const Native = require('./native-backend');
            return make(Native, { channelMap: opts.channelMap || buildChannelMapFromEnv() });
        } catch (e) { /* not installed — fall through */ }

        // Nothing available — silent no-op
        return make(NullBackend);
    }

    throw new Error(`Unknown AUDIO_BACKEND value: "${mode}". Use auto, voicemeeter, native, or none.`);
}

module.exports = { createBackend, NullBackend };
