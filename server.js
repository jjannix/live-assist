const express = require('express');
const http = require('http');
const os = require('os');
const socketIo = require('socket.io');
const { default: OBSWebSocket } = require('obs-websocket-js');
const { createBackend, resolveAutoBackend, NullBackend } = require('./audio/factory');
const config = require('./config');

// .env is the single source of truth. Loaded once at boot with
// override:true so a hand-edited (or in-app-edited) file always wins
// over anything already present in process.env.
config.load();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const obs = new OBSWebSocket();

const serverStartTime = Date.now();

// ── OBS auto-reconnect state ──────────────────────────────────────
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let shuttingDown = false;
let obsReconnectAttempt = 0;
let obsReconnectTimer = null;

function reconnectDelay(attempt) {
    return Math.min(RECONNECT_INITIAL_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
}

function setObsStatus(connected, detail = '') {
    io.emit('obsStatus', { connected });
    if (detail) io.emit('terminalOutput', detail);
}

function scheduleOBSReconnect() {
    if (shuttingDown || obsReconnectTimer) return;
    const delay = reconnectDelay(obsReconnectAttempt);
    io.emit('terminalOutput', `OBS: retrying in ${(delay / 1000).toFixed(1)}s (after attempt ${obsReconnectAttempt})…`);
    obsReconnectTimer = setTimeout(() => {
        obsReconnectTimer = null;
        connectOBSWebSocket();
    }, delay);
}

async function connectOBSWebSocket() {
    obsReconnectAttempt++;
    const attempt = obsReconnectAttempt;
    io.emit('terminalOutput', `OBS: connecting (attempt ${attempt})…`);
    try {
        await obs.connect(process.env.OBS_WEBSOCKET_URL, process.env.OBS_WEBSOCKET_PASSWORD);
        obsReconnectAttempt = 0;
        console.log('Connected to OBS WebSocket');
        setObsStatus(true, `Connected to OBS WebSocket (attempt ${attempt})`);

        const { scenes } = await obs.call('GetSceneList');
        console.log('Available scenes:');
        scenes.forEach(scene => console.log(scene.sceneName));

        const sources = await obs.call('GetInputList');
        console.log('Available audio sources:');
        sources.inputs.forEach(source => console.log(source.inputName));

        const currentScene = await obs.call('GetCurrentProgramScene');
        io.emit('currentScene', { sceneName: currentScene.currentProgramSceneName });
    } catch (err) {
        console.error('Failed to connect to OBS WebSocket:', err);
        setObsStatus(false, `Failed to connect to OBS WebSocket (attempt ${attempt}): ` + (err && err.message ? err.message : err));
        scheduleOBSReconnect();
    }
}

// Listen for OBS scene changes
obs.on('CurrentProgramSceneChanged', data => {
    console.log('OBS scene changed:', data.sceneName);
    io.emit('currentScene', { sceneName: data.sceneName });
    io.emit('terminalOutput', 'OBS scene changed to: ' + data.sceneName);

    // Auto-load scene profile if one is saved
    const p = profiles['__scene_' + data.sceneName];
    if (p && audioBackend.isConnected()) {
        audioBackend.setMultiChannelGain({ 3: p[3], 4: p[4] });
        io.emit('profileLoaded', { name: data.sceneName, gains: p });
        io.emit('terminalOutput', 'Auto-loaded profile for: ' + data.sceneName);
    }
});

obs.on('ConnectionClosed', () => {
    console.error('OBS WebSocket disconnected');
    setObsStatus(false, 'OBS WebSocket disconnected');
    scheduleOBSReconnect();
});

obs.on('ConnectionError', err => {
    console.error('OBS WebSocket error:', err);
    setObsStatus(false, 'OBS WebSocket error: ' + (err && err.message ? err.message : err));
    scheduleOBSReconnect();
});

// ── Audio backend setup ───────────────────────────────────────────
let AUDIO_FADE_DURATION_MS = parseInt(process.env.AUDIO_FADE_DURATION_MS, 10) || 900;
let AUDIO_DEBUG = ['true', '1', 'yes'].includes((process.env.AUDIO_DEBUG || '').toLowerCase());
const AUDIO_LOG_PREFIX = '[audio] ';

function audioLog(msg) {
    const line = AUDIO_LOG_PREFIX + msg;
    console.log(line);
    if (AUDIO_DEBUG) io.emit('terminalOutput', line);
}

// Audio backend. 'auto' is resolved at init time (async): we try
// Voicemeeter, and if the app isn't running we fall back to the native
// per-app mixer. Explicit modes (voicemeeter/native/none) skip the
// probe. Placeholder until selectAndInitAudioBackend() runs.
let audioBackend = new NullBackend();

function wireAudioStatus() {
    audioBackend.onStatusChange((connected, detail) => {
        io.emit('vmStatus', { connected, backend: audioBackend.name });
        if (detail) io.emit('terminalOutput', detail);
    });
}

/** Push current state of a channel to all clients. */
function broadcastChannel(channelId) {
    audioBackend.getChannelState(channelId).then(state => {
        io.emit('muteState', { stripIndex: channelId, muted: state.muted });
        io.emit('faderState', { stripIndex: channelId, gain: state.gainDb });
    }).catch(() => { /* ignore — backend is offline */ });
}

async function selectAndInitAudioBackend() {
    const mode = (process.env.AUDIO_BACKEND || 'auto').toLowerCase().trim();
    try {
        if (mode === 'auto') {
            audioBackend = await resolveAutoBackend({ logger: audioLog });
        } else {
            audioBackend = createBackend({ logger: audioLog });
            await audioBackend.init();
        }
    } catch (e) {
        console.error('Audio backend init failed:', e.message);
        try { await audioBackend.shutdown(); } catch (_) { /* ignore */ }
        audioBackend = new NullBackend();
    }
    wireAudioStatus();
    if (audioBackend.isConnected()) {
        const { mute, fader } = audioBackend.syncInitialState();
        for (const [ch, muted] of Object.entries(mute)) {
            io.emit('muteState', { stripIndex: Number(ch), muted });
        }
        for (const [ch, gain] of Object.entries(fader)) {
            io.emit('faderState', { stripIndex: Number(ch), gain });
        }
    } else {
        io.emit('vmStatus', { connected: false, backend: audioBackend.name });
    }
}

// Server-side profile storage (keyed by name; value is { 3: gainDb, 4: gainDb })
const profiles = {};

// Saved audio levels per mode. Updated every time you leave a mode.
// null = never visited, use defaults.
let savedGameLevels = null;   // { 3: gainDb, 4: gainDb }
let savedBreakLevels = null;  // { 3: gainDb, 4: gainDb }

process.on('uncaughtException', err => {
    console.error('Uncaught exception:', err && err.message ? err.message : err);
});
process.on('unhandledRejection', err => {
    console.error('Unhandled rejection:', err && err.message ? err.message : err);
});

connectOBSWebSocket();
selectAndInitAudioBackend();

// ── Live config editor (served at /config.html) ──────────────────
// A browser can't touch the filesystem, so the editor talks to these
// endpoints. POST writes the real .env and hot-reloads OBS + audio.
app.use(express.json());

app.get('/api/config', (req, res) => {
    res.json({ fields: config.getClientView() });
});

app.post('/api/config', (req, res) => {
    try {
        config.writeValues((req.body && req.body.fields) || {});
        reloadRuntime();
        io.emit('terminalOutput', 'Configuration updated via the in-app editor.');
        res.json({ ok: true });
    } catch (e) {
        console.error('Config save failed:', e.message);
        res.status(400).json({ ok: false, error: e.message });
    }
});

app.get('/api/network', (req, res) => {
    res.json({ urls: lanUrls() });
});

// Re-read .env and re-initialise OBS + audio so edits take effect
// without restarting the process. The HTTP server keeps running; the
// status pills flap briefly and recover on their own.
function reloadRuntime() {
    AUDIO_FADE_DURATION_MS = parseInt(process.env.AUDIO_FADE_DURATION_MS, 10) || 900;
    AUDIO_DEBUG = ['true', '1', 'yes'].includes((process.env.AUDIO_DEBUG || '').toLowerCase());

    // OBS — reconnect with (possibly) new URL / password
    try { obs.disconnect(); } catch (e) { /* ignore */ }
    connectOBSWebSocket();

    // Audio — tear down the current backend and build a fresh one for
    // the (possibly) new AUDIO_BACKEND / channel map.
    const previous = audioBackend;
    Promise.resolve()
        .then(() => previous.shutdown()).catch(() => {})
        .then(() => selectAndInitAudioBackend());
}

function lanUrls() {
    const out = [];
    for (const [name, nets] of Object.entries(os.networkInterfaces())) {
        for (const net of nets || []) {
            if (net.family === 'IPv4' && !net.internal) {
                out.push({ name, address: net.address, url: 'http://' + net.address + ':3000' });
            }
        }
    }
    return out;
}

app.use(express.static('public'));

io.on('connection', async socket => {
    console.log('Client connected');

    // Send current OBS status and scene to newly connected client
    try {
        const currentScene = await obs.call('GetCurrentProgramScene');
        socket.emit('currentScene', { sceneName: currentScene.currentProgramSceneName });
        socket.emit('obsStatus', { connected: true });
    } catch (err) {
        socket.emit('obsStatus', { connected: false });
    }

    // Send current audio backend state to the new client
    socket.emit('vmStatus', { connected: audioBackend.isConnected(), backend: audioBackend.name });
    if (audioBackend.isConnected()) {
        for (const id of [3, 4]) {
            try {
                const state = await audioBackend.getChannelState(id);
                socket.emit('muteState', { stripIndex: id, muted: state.muted });
                socket.emit('faderState', { stripIndex: id, gain: state.gainDb });
            } catch (e) { /* skip */ }
        }
    }

    socket.on('transition', async data => {
        try {
            await obs.call('SetCurrentProgramScene', { 'sceneName': data.sceneName });
            console.log('Transitioned to scene:', data.sceneName);
            io.emit('terminalOutput', 'Transitioned to scene: ' + data.sceneName);
            io.emit('currentScene', { sceneName: data.sceneName });
        } catch (err) {
            console.error('Failed to transition:', err);
            io.emit('terminalOutput', 'Failed to transition: ' + err.message);
        }
    });

    socket.on('mute', async data => {
        try {
            await obs.call('SetInputMute', { inputName: data.inputName, inputMuted: true });
            console.log('Muted source:', data.inputName);
            io.emit('terminalOutput', 'Muted source: ' + data.inputName);
        } catch (err) {
            console.error('Failed to mute source:', err);
            io.emit('terminalOutput', 'Failed to mute source: ' + err.message);
        }
    });

    socket.on('unmute', async data => {
        try {
            await obs.call('SetInputMute', { inputName: data.inputName, inputMuted: false });
            console.log('Unmuted source:', data.inputName);
            io.emit('terminalOutput', 'Unmuted source: ' + data.inputName);
        } catch (err) {
            console.error('Failed to unmute source:', err);
            io.emit('terminalOutput', 'Failed to unmute source: ' + err.message);
        }
    });

    socket.on('setVolume', async data => {
        if (!audioBackend.isConnected()) {
            socket.emit('terminalOutput', 'Audio backend not connected — cannot set volume');
            return;
        }
        try {
            const gainDb = parseFloat(data.volume);
            await audioBackend.setChannelGain(data.stripIndex, gainDb);
            io.emit('faderState', { stripIndex: data.stripIndex, gain: gainDb });
            const label = data.stripIndex === 3 ? 'TV' : 'Spotify';
            io.emit('terminalOutput', 'Set volume for ' + label + ': ' + gainDb.toFixed(1) + ' dB');
        } catch (err) {
            console.error('Failed to set volume:', err);
            io.emit('terminalOutput', 'Failed to set volume: ' + err.message);
        }
    });

    socket.on('toggleMute', async data => {
        if (!audioBackend.isConnected()) return;
        try {
            const strip = data.stripIndex;
            const { muted } = await audioBackend.toggleMute(strip);
            const label = strip === 3 ? 'TV' : 'Spotify';
            io.emit('muteState', { stripIndex: strip, muted });
            io.emit('terminalOutput', (muted ? 'Muted' : 'Unmuted') + ' ' + label);
        } catch (err) {
            console.error('Failed to toggle mute:', err);
        }
    });

    // ── Save / Load audio profiles ──────────────────────────────
    socket.on('saveProfile', async data => {
        if (!audioBackend.isConnected()) return;
        try {
            const name = data.name;
            const [s3, s4] = await Promise.all([
                audioBackend.getChannelState(3),
                audioBackend.getChannelState(4),
            ]);
            profiles[name] = { 3: s3.gainDb, 4: s4.gainDb };
            socket.emit('profileSaved', { name, gains: profiles[name] });
            io.emit('terminalOutput', 'Saved profile: ' + name);
        } catch (err) {
            console.error('Failed to save profile:', err);
        }
    });

    socket.on('loadProfile', async data => {
        if (!audioBackend.isConnected()) return;
        const p = profiles[data.name];
        if (!p) return;
        try {
            await audioBackend.setMultiChannelGain({ 3: p[3], 4: p[4] });
            io.emit('profileLoaded', { name: data.name, gains: p });
            io.emit('faderState', { stripIndex: 3, gain: p[3] });
            io.emit('faderState', { stripIndex: 4, gain: p[4] });
            io.emit('terminalOutput', 'Loaded profile: ' + data.name);
        } catch (err) {
            console.error('Failed to load profile:', err);
        }
    });

    socket.on('getProfiles', () => {
        socket.emit('profileList', profiles);
    });

    // ── Health dashboard: force-reconnect a backend ────────────
    socket.on('requestReconnect', data => {
        if (data && data.target === 'obs') {
            io.emit('terminalOutput', 'Manual OBS reconnect requested from dashboard');
            try { obs.disconnect(); } catch (e) {}
            connectOBSWebSocket();
        } else if (data && data.target === 'vm') {
            io.emit('terminalOutput', 'Manual audio backend reconnect requested from dashboard');
            if (typeof audioBackend.reconnect === 'function') {
                audioBackend.reconnect();
            } else {
                // Fall back to teardown + reinit
                audioBackend.shutdown().then(() => selectAndInitAudioBackend());
            }
        }
    });

    // ── Per-scene auto-profiles ────────────────────────────────
    socket.on('saveSceneProfile', async data => {
        if (!audioBackend.isConnected()) return;
        try {
            const name = data.sceneName;
            const [s3, s4] = await Promise.all([
                audioBackend.getChannelState(3),
                audioBackend.getChannelState(4),
            ]);
            profiles['__scene_' + name] = { 3: s3.gainDb, 4: s4.gainDb };
            io.emit('terminalOutput', 'Saved scene profile: ' + name);
        } catch (err) {
            console.error('Failed to save scene profile:', err);
        }
    });

    // Scene-action audio presets.
    // The active channel (TV in Game, Spotify in Break) restores the
    // user's preferred level from the last visit. The inactive channel
    // ALWAYS fades to silent (-60 dB), never a saved level — so Game
    // fully mutes Spotify and Break fully mutes TV, every single time.
    const BREAK_PRESET = { tv: -60, sp: 0 };
    const GAME_DEFAULT = { tv: 0, sp: -60 };

    socket.on('GameAction', async () => {
        try {
            // Save current levels as Break's state before leaving it
            if (audioBackend.isConnected()) {
                const [tvNow, spNow] = await Promise.all([
                    audioBackend.getChannelState(3),
                    audioBackend.getChannelState(4),
                ]);
                savedBreakLevels = { 3: tvNow.gainDb, 4: spNow.gainDb };
            }

            const tvTarget = savedGameLevels ? savedGameLevels[3] : GAME_DEFAULT.tv;
            const spTarget = GAME_DEFAULT.sp;   // Spotify: always fully silent in Game

            // Switch OBS scene first for instant visual feedback
            await obs.call('SetCurrentProgramScene', { sceneName: 'Live Übertragung' });
            io.emit('terminalOutput', 'Switched to scene: Live Übertragung');

            if (audioBackend.isConnected()) {
                io.emit('terminalOutput', 'Fading audio.');
                const [tvStart, spStart] = await Promise.all([
                    audioBackend.getChannelState(3),
                    audioBackend.getChannelState(4),
                ]);
                await audioBackend.applyPreset({
                    channels: [
                        { id: 3, fromDb: tvStart.gainDb, toDb: tvTarget },
                        { id: 4, fromDb: spStart.gainDb, toDb: spTarget },
                    ],
                    durationMs: AUDIO_FADE_DURATION_MS,
                });
                io.emit('faderState', { stripIndex: 3, gain: tvTarget });
                io.emit('faderState', { stripIndex: 4, gain: spTarget });
            } else {
                io.emit('terminalOutput', 'Audio backend not connected — skipping audio fades.');
            }

            io.emit('terminalOutput', 'Automated action completed successfully.');
            io.emit('actionDone', 'game');
        } catch (err) {
            console.error('Automated action (GameAction) failed:', err);
            io.emit('terminalOutput', 'Automated action failed: ' + err.message);
            io.emit('actionFailed');
        }
    });

    socket.on('PauseAction', async () => {
        try {
            // Snapshot current levels BEFORE fading, so GameAction
            // can restore them exactly.
            if (audioBackend.isConnected()) {
                const [tvNow, spNow] = await Promise.all([
                    audioBackend.getChannelState(3),
                    audioBackend.getChannelState(4),
                ]);
                // Save current levels as Game's state before leaving it
                savedGameLevels = { 3: tvNow.gainDb, 4: spNow.gainDb };

                // Switch OBS scene first for instant visual feedback
                await obs.call('SetCurrentProgramScene', { sceneName: 'Spotify' });
                io.emit('terminalOutput', 'Switched to scene: Spotify');

                const tvTarget = BREAK_PRESET.tv;   // TV: always fully silent in Break
                const spTarget = savedBreakLevels ? savedBreakLevels[4] : BREAK_PRESET.sp;

                await audioBackend.applyPreset({
                    channels: [
                        { id: 3, fromDb: tvNow.gainDb, toDb: tvTarget },
                        { id: 4, fromDb: spNow.gainDb, toDb: spTarget },
                    ],
                    durationMs: AUDIO_FADE_DURATION_MS,
                });
                io.emit('faderState', { stripIndex: 3, gain: tvTarget });
                io.emit('faderState', { stripIndex: 4, gain: spTarget });
                io.emit('terminalOutput', 'Faded out Main Input and faded in Spotify Input.');
            } else {
                io.emit('terminalOutput', 'Audio backend not connected — skipping audio fades.');
            }

            io.emit('terminalOutput', 'Automated action completed successfully.');
            io.emit('actionDone', 'break');
        } catch (err) {
            console.error('Automated action (PauseAction) failed:', err);
            io.emit('terminalOutput', 'Automated action failed: ' + err.message);
            io.emit('actionFailed');
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
        io.emit('terminalOutput', 'Client disconnected');
    });
});

// ── Graceful shutdown — prevent reconnection when process is exiting
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (obsReconnectTimer) { clearTimeout(obsReconnectTimer); obsReconnectTimer = null; }
    try { obs.disconnect(); } catch (e) {}
    try { audioBackend.shutdown(); } catch (e) {}
    io.emit('terminalOutput', 'Server shutting down');
    server.close(() => process.exit(0));
    // Hard exit if not closed in 2s
    setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(3000, () => {
    console.log('Server is running on port 3000');
    io.emit('terminalOutput', 'Server is running on port 3000');
    const urls = lanUrls();
    if (urls.length) {
        urls.forEach(n => console.log('  Network: ' + n.url + '  (' + n.name + ')'));
        io.emit('terminalOutput', 'Open on your phone: ' + urls[0].url);
    }

    // ── Health dashboard: periodic stats broadcast
    function buildHealthStats() {
        const mem = process.memoryUsage();
        return {
            uptime: Math.floor((Date.now() - serverStartTime) / 1000),
            clients: io.engine.clientsCount,
            memory: {
                rss: Math.round(mem.rss / 1024 / 1024),
                heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
                heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
            },
            node: {
                version: process.version,
                platform: process.platform,
                arch: process.arch,
            },
            system: {
                hostname: os.hostname(),
                cpus: os.cpus().length,
                loadavg: os.loadavg().map(n => n.toFixed(2)),
                freememMB: Math.round(os.freemem() / 1024 / 1024),
                totalmemMB: Math.round(os.totalmem() / 1024 / 1024),
            },
        };
    }

    setInterval(() => io.emit('healthStats', buildHealthStats()), 3000);
});
