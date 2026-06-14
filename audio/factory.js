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
        // 'auto' must be resolved at init time via resolveAutoBackend():
        // the correct pick depends on whether the Voicemeeter *application*
        // is running, which can only be learned by actually trying to
        // connect. createBackend() is synchronous and can only check
        // whether an npm package loads — which is always true for
        // voicemeeter-remote (it's a dependency), so a sync 'auto' would
        // always pick Voicemeeter and never fall back to native even when
        // the app is absent. We throw rather than silently return a
        // backend that is probably the wrong one.
        throw new Error(
            "AUDIO_BACKEND='auto' must be resolved via resolveAutoBackend() — " +
            'createBackend() is synchronous and cannot detect whether the ' +
            'Voicemeeter application is running'
        );
    }

    throw new Error(`Unknown AUDIO_BACKEND value: "${mode}". Use auto, voicemeeter, native, or none.`);
}

/**
 * Resolve 'auto' at init time: try each backend's init() and keep the
 * first that actually connects. Unlike createBackend(), this can tell
 * the difference between "the voicemeeter-remote npm package is
 * installed" and "the Voicemeeter application is running".
 *
 * Order: Voicemeeter (power-user features) → native (per-app volume) → none.
 *
 * @param {Object}  [opts]
 * @param {Object}  [opts.channelMap]        forwarded to the native backend
 * @param {number}  [opts.healthProbeStrip]  forwarded to the VM backend
 * @param {(msg:string)=>void} [opts.logger] Logger forwarded to each backend
 * @returns {Promise<AudioBackend>}
 */
async function resolveAutoBackend(opts = {}) {
    const logger = opts.logger || (() => {});

    // 1. Voicemeeter — one real connection attempt. If login fails, the
    //    app isn't running; shut it down (which cancels its pending
    //    reconnect timer) and fall through to native.
    try {
        require.resolve('voicemeeter-remote');
        const VM = require('./voicemeeter-backend');
        const vm = new VM({ healthProbeStrip: opts.healthProbeStrip });
        vm.setLogger(logger);
        await vm.init();
        if (vm.isConnected()) return vm;
        logger('Auto: Voicemeeter is not running — falling back to native');
        await vm.shutdown().catch(() => {});
    } catch (e) {
        logger('Auto: Voicemeeter unavailable (' + (e && e.message ? e.message : e) + ')');
    }

    // 2. Native (per-app volume via native-sound-mixer, no extra software)
    try {
        require.resolve('native-sound-mixer');
        const Native = require('./native-backend');
        const native = new Native({ channelMap: opts.channelMap || buildChannelMapFromEnv() });
        native.setLogger(logger);
        await native.init();
        if (native.isConnected()) return native;
        await native.shutdown().catch(() => {});
    } catch (e) {
        logger('Auto: native backend unavailable (' + (e && e.message ? e.message : e) + ')');
    }

    // 3. Nothing available — audio disabled, OBS scene switching still works
    logger('Auto: no audio backend available — audio disabled');
    const none = new NullBackend();
    none.setLogger(logger);
    return none;
}

module.exports = { createBackend, resolveAutoBackend, NullBackend };
