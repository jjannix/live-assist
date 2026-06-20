/**
 * config.js — read/write the LIVE .env from the in-app editor.
 *
 * A browser can't touch the filesystem, so the old config.html was a
 * load-a-file / download-a-file dance. This module backs two HTTP
 * endpoints (GET/POST /api/config in server.js): the editor reads the
 * current values from the server and writes changes straight to the
 * real .env on disk. The server then hot-reloads OBS + audio.
 *
 * The .env file is regenerated from SCHEMA so it stays clean and
 * commented for the rare person who opens it in a text editor.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ENV_PATH = path.join(__dirname, '.env');

// The editable surface. Order = display order; `section` starts a group.
const SCHEMA = [
    { section: 'OBS WebSocket', key: 'OBS_WEBSOCKET_URL', label: 'OBS WebSocket address', type: 'text',
      default: 'ws://localhost:4455',
      help: 'Usually ws://localhost:4455. Only change if OBS WebSocket runs on a different port or machine.' },
    { key: 'OBS_WEBSOCKET_PASSWORD', label: 'OBS WebSocket password', type: 'password', sensitive: true, default: '',
      help: 'In OBS: Tools → WebSocket Server Settings → show password. Leave blank to keep the current one.' },

    { section: 'Audio backend', key: 'AUDIO_BACKEND', label: 'Audio system', type: 'select', default: 'auto',
      help: 'Auto picks the best available backend. None disables volume control but keeps scene switching.',
      options: [
        { value: 'auto',       label: 'Auto (recommended)' },
        { value: 'native',     label: 'Native (per-app volume)' },
        { value: 'voicemeeter', label: 'Voicemeeter' },
        { value: 'none',       label: 'None (OBS scene switching only)' },
      ] },

    { section: 'Channel 3 — broadcast mix', key: 'AUDIO_CHANNEL_3_NAME', label: 'Channel 3 name', type: 'text',
      default: 'TV', help: 'Label shown in the app for the main broadcast mix.' },
    { key: 'AUDIO_CHANNEL_3_APPS', label: 'Channel 3 apps', type: 'list',
      default: 'obs64,chrome,firefox,msedge,edge,opera,zen,vivaldi,brave,arc,helium,thorium',
      help: 'Programs that feed this channel. Comma-separated .exe names WITHOUT the .exe. Not running = silent, no error.' },

    { section: 'Channel 4 — music / halftime', key: 'AUDIO_CHANNEL_4_NAME', label: 'Channel 4 name', type: 'text',
      default: 'Spotify', help: 'Label shown in the app for the music channel.' },
    { key: 'AUDIO_CHANNEL_4_APPS', label: 'Channel 4 apps', type: 'list', default: 'spotify',
      help: 'Programs that feed this channel.' },

    { section: 'Tunables', key: 'AUDIO_FADE_DURATION_MS', label: 'Fade duration (ms)', type: 'number', default: '900',
      help: 'How long crossfades take, in milliseconds. 900 is a good default.' },
    { key: 'AUDIO_DEBUG', label: 'Verbose audio logging', type: 'bool', default: 'false',
      help: 'Stream detailed audio-backend messages to the activity log.' },

    { section: 'OBS preview', key: 'PREVIEW_SOURCE', label: 'Scene to peek at', type: 'text',
      default: 'Live Übertragung',
      help: 'Which OBS scene/source the on-demand "peek" captures. Defaults to the live feed so you can check whether the match has resumed while the beamer shows break images. Must match an OBS source name exactly.' },
    { key: 'PREVIEW_WIDTH', label: 'Preview width (px)', type: 'number', default: '480',
      help: 'Capture width. Smaller is faster to encode and cheaper over WiFi; height keeps the source aspect ratio.' },
    { key: 'PREVIEW_QUALITY', label: 'Preview JPEG quality (1–100)', type: 'number', default: '70',
      help: 'Compression quality of the captured frame. 60–80 is a good range for a confidence check.' },

    { section: 'Weather', key: 'STADIUM_NAME', label: 'Location name', type: 'text', default: '',
      help: 'Label shown on the weather slide (city or ground name). Optional.' },
    { key: 'STADIUM_LAT', label: 'Latitude', type: 'text', default: '52.517',
      help: 'Decimal degrees. Used by the weather slide to fetch local conditions.' },
    { key: 'STADIUM_LON', label: 'Longitude', type: 'text', default: '13.400',
      help: 'Decimal degrees.' },
];

/** Load .env once at boot. override:true makes the file authoritative. */
function load() {
    dotenv.config({ path: ENV_PATH, override: true });
}

/**
 * Client-safe view. Sensitive values are NEVER sent — only whether one
 * is set, so the UI can show "•••••• (currently set)".
 */
function getClientView() {
    return SCHEMA.map(s => {
        const current = process.env[s.key] !== undefined ? process.env[s.key] : (s.default || '');
        const base = { key: s.key, section: s.section, label: s.label, type: s.type, help: s.help, default: s.default };
        if (s.type === 'select') base.options = s.options;
        if (s.sensitive) return { ...base, value: '', passwordSet: !!current };
        return { ...base, value: current };
    });
}

/**
 * Merge a submission into the current config and persist to .env.
 * submission: { KEY: 'value', ... } — only known keys are honoured.
 * A password left blank keeps the existing value.
 * Returns the merged values that were written.
 */
function writeValues(submission) {
    const merged = {};
    for (const s of SCHEMA) {
        let v = (submission && submission[s.key] !== undefined)
            ? submission[s.key]
            : (process.env[s.key] !== undefined ? process.env[s.key] : (s.default || ''));
        if (typeof v === 'string') v = v.trim();

        // Blank password = keep whatever is currently set
        if (s.type === 'password' && v === '') {
            v = process.env[s.key] || '';
        }
        // Coerce numerics to a clean integer string
        if (s.type === 'number') {
            const n = parseInt(v, 10);
            v = Number.isFinite(n) ? String(n) : (s.default || '0');
        }
        // Booleans → canonical true/false
        if (s.type === 'bool') {
            v = ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase()) ? 'true' : 'false';
        }
        merged[s.key] = v;
    }

    fs.writeFileSync(ENV_PATH, renderEnv(merged), 'utf8');

    // Reload into process.env so callers can re-init subsystems immediately.
    dotenv.config({ path: ENV_PATH, override: true });
    return merged;
}

/** Render a clean, commented .env from a values map. */
function renderEnv(values) {
    let out = '# jnk Live Assist configuration\n';
    out += '# Edited via the in-app Settings page. You can also edit this file by\n';
    out += '# hand — changes are picked up on the next server start.\n\n';
    let section = null;
    for (const s of SCHEMA) {
        if (s.section && s.section !== section) {
            section = s.section;
            const bar = '─'.repeat(Math.max(4, 56 - s.section.length));
            out += '# ── ' + s.section + ' ' + bar + '\n';
        }
        if (s.help) out += '# ' + s.help + '\n';
        out += s.key + '=' + (values[s.key] != null ? values[s.key] : '') + '\n\n';
    }
    return out.trimEnd() + '\n';
}

module.exports = { load, getClientView, writeValues, renderEnv, SCHEMA };
