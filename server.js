const express = require('express');
const http = require('http');
const os = require('os');
const socketIo = require('socket.io');
const { default: OBSWebSocket } = require('obs-websocket-js');
const dotenv = require('dotenv');

dotenv.config();

// ── Audio backend factory ────────────────────────────────────────
const { createBackend } = require('./audio/factory');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const obs = new OBSWebSocket();

const serverStartTime = Date.now();

// ── Logging helper ───────────────────────────────────────────────
const AUDIO_DEBUG = (process.env.AUDIO_DEBUG || '0') === '1';
function log(msg) {
    console.log(msg);
    io.emit('terminalOutput', msg);
}

// ── Create audio backend ─────────────────────────────────────────
const vmHealthProbeRaw = parseInt(process.env.VM_HEALTH_PROBE_STRIP, 10);
const VM_HEALTH_PROBE_STRIP = Number.isInteger(vmHealthProbeRaw) && vmHealthProbeRaw >= 0 ? vmHealthProbeRaw : 3;
const AUDIO_FADE_DURATION_MS = parseInt(process.env.AUDIO_FADE_DURATION_MS, 10) || 900;

let audioBackend;
try {
    audioBackend = createBackend({ healthProbeStrip: VM_HEALTH_PROBE_STRIP });
} catch (e) {
    log('Audio backend creation failed: ' + e.message);
    const { NullBackend } = require('./audio/factory');
    audioBackend = new NullBackend();
}

// ── OBS auto-reconnect ───────────────────────────────────────────
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
        scenes.forEach(scene => console.log(scene.name));

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

    // Auto-load scene profile if supported and one is saved
    const caps = audioBackend.getCapabilities();
    if (caps.sceneAutoProfile && audioBackend.isConnected()) {
        const p = profiles['__scene_' + data.sceneName];
        if (p) {
            (async () => {
                try {
                    await audioBackend.setMultiChannelGain({ 3: p[3], 4: p[4] });
                    io.emit('profileLoaded', { name: data.sceneName, gains: p });
                    io.emit('terminalOutput', 'Auto-loaded profile for: ' + data.sceneName);
                } catch (e) { /* skip */ }
            })();
        }
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

// ── Audio backend initialisation ─────────────────────────────────

audioBackend.onStatusChange((connected, detail) => {
    io.emit('vmStatus', { connected });
    if (detail) io.emit('terminalOutput', detail);
});

// Inject logger if backend supports it
if (audioBackend.setLogger) {
    audioBackend.setLogger(msg => {
        if (AUDIO_DEBUG) console.log('[audio] ' + msg);
    });
}

async function initAudio() {
    const caps = audioBackend.getCapabilities();
    log(`Audio backend: ${audioBackend.name} ` +
        `(perChannelVolume=${caps.perChannelVolume}, mute=${caps.mute}, fade=${caps.fade}, profiles=${caps.profiles})`);

    try {
        await audioBackend.init();
        log(`Audio backend "${audioBackend.name}" connected`);
    } catch (e) {
        log(`Audio backend "${audioBackend.name}" init failed: ${e.message}`);
        log('Audio controls will be limited — scene switching still works');
    }
}

function emitAudioBackendStatus() {
    const caps = audioBackend.getCapabilities();
    io.emit('audioBackendStatus', {
        backend: audioBackend.name,
        connected: audioBackend.isConnected(),
        capabilities: caps,
    });
}

// ── Profiles (in-memory) ─────────────────────────────────────────
const profiles = {}; // { profileName: { 3: gainDb, 4: gainDb } }

// ── Graceful error handling ──────────────────────────────────────
process.on('uncaughtException', err => {
    console.error('Uncaught exception:', err && err.message ? err.message : err);
});
process.on('unhandledRejection', err => {
    console.error('Unhandled rejection:', err && err.message ? err.message : err);
});

// ── Start everything ─────────────────────────────────────────────
connectOBSWebSocket();
initAudio();

app.use(express.static('public'));

io.on('connection', async socket => {
    console.log('Client connected');

    // Send current OBS status and scene
    try {
        const currentScene = await obs.call('GetCurrentProgramScene');
        socket.emit('currentScene', { sceneName: currentScene.currentProgramSceneName });
        socket.emit('obsStatus', { connected: true });
    } catch (err) {
        socket.emit('obsStatus', { connected: false });
    }

    // Send audio backend status
    const caps = audioBackend.getCapabilities();
    socket.emit('vmStatus', { connected: audioBackend.isConnected() });
    emitAudioBackendStatus();

    // Sync current audio state if backend is connected
    if (audioBackend.isConnected()) {
        for (const ch of [3, 4]) {
            try {
                const state = await audioBackend.getChannelState(ch);
                socket.emit('muteState', { stripIndex: ch, muted: state.muted });
                socket.emit('faderState', { stripIndex: ch, gain: state.gainDb });
            } catch (e) { /* skip */ }
        }
    }

    // ── Scene switching ──────────────────────────────────────────

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

    // ── OBS-level mute/unmute (legacy, kept for compatibility) ───

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

    // ── Volume control (via audio backend) ────────────────────────

    socket.on('setVolume', async data => {
        if (!audioBackend.isConnected()) {
            socket.emit('terminalOutput', 'Audio backend not connected — cannot set volume');
            return;
        }
        try {
            const volume = parseFloat(data.volume);
            await audioBackend.setChannelGain(data.stripIndex, volume);
            io.emit('terminalOutput', 'Set volume for channel ' + data.stripIndex + ' to ' + volume + ' dB');
        } catch (err) {
            console.error('Failed to set volume:', err);
            io.emit('terminalOutput', 'Failed to set volume: ' + (err.message || err));
        }
    });

    // ── Mute toggle (via audio backend) ───────────────────────────

    socket.on('toggleMute', async data => {
        if (!audioBackend.isConnected()) return;
        try {
            const result = await audioBackend.toggleMute(data.stripIndex);
            const label = data.stripIndex === 3 ? 'TV' : 'Spotify';
            io.emit('muteState', { stripIndex: data.stripIndex, muted: result.muted });
            io.emit('terminalOutput', (result.muted ? 'Muted' : 'Unmuted') + ' ' + label);
        } catch (err) {
            console.error('Failed to toggle mute:', err);
        }
    });

    // ── Audio profiles ────────────────────────────────────────────

    socket.on('saveProfile', async data => {
        const caps = audioBackend.getCapabilities();
        if (!caps.profiles || !audioBackend.isConnected()) {
            socket.emit('terminalOutput', 'Profiles not supported by current audio backend');
            return;
        }
        try {
            const name = data.name;
            const state3 = await audioBackend.getChannelState(3);
            const state4 = await audioBackend.getChannelState(4);
            profiles[name] = { 3: state3.gainDb, 4: state4.gainDb };
            socket.emit('profileSaved', { name, gains: profiles[name] });
            io.emit('terminalOutput', 'Saved profile: ' + name);
        } catch (err) {
            console.error('Failed to save profile:', err);
        }
    });

    socket.on('loadProfile', async data => {
        const caps = audioBackend.getCapabilities();
        if (!caps.profiles) {
            socket.emit('terminalOutput', 'Profiles not supported by current audio backend');
            return;
        }
        const p = profiles[data.name];
        if (!p) return;
        try {
            await audioBackend.setMultiChannelGain({ 3: p[3], 4: p[4] });
            io.emit('profileLoaded', { name: data.name, gains: p });
            io.emit('terminalOutput', 'Loaded profile: ' + data.name);
        } catch (err) {
            console.error('Failed to load profile:', err);
        }
    });

    socket.on('getProfiles', () => {
        socket.emit('profileList', profiles);
    });

    // ── Per-scene auto-profiles ───────────────────────────────────

    socket.on('saveSceneProfile', async data => {
        const caps = audioBackend.getCapabilities();
        if (!caps.sceneAutoProfile || !audioBackend.isConnected()) {
            socket.emit('terminalOutput', 'Scene auto-profiles not supported by current audio backend');
            return;
        }
        try {
            const name = data.sceneName;
            const state3 = await audioBackend.getChannelState(3);
            const state4 = await audioBackend.getChannelState(4);
            profiles['__scene_' + name] = { 3: state3.gainDb, 4: state4.gainDb };
            io.emit('terminalOutput', 'Saved scene profile: ' + name);
        } catch (err) {
            console.error('Failed to save scene profile:', err);
        }
    });

    // ── Health dashboard: force-reconnect ─────────────────────────

    socket.on('requestReconnect', async data => {
        if (data && data.target === 'obs') {
            io.emit('terminalOutput', 'Manual OBS reconnect requested from dashboard');
            try { obs.disconnect(); } catch (e) {}
            connectOBSWebSocket();
        } else if (data && data.target === 'vm') {
            io.emit('terminalOutput', 'Manual audio backend reconnect requested from dashboard');
            try {
                if (audioBackend.reconnect) {
                    await audioBackend.reconnect();
                } else {
                    await audioBackend.init();
                }
                emitAudioBackendStatus();
            } catch (e) {
                io.emit('terminalOutput', 'Reconnect failed: ' + e.message);
            }
        }
    });

    // ── GameAction (automated) ────────────────────────────────────

    socket.on('GameAction', async data => {
        try {
            const tvTarget = data && data.tvTarget !== undefined ? data.tvTarget : 0;
            const spTarget = data && data.spTarget !== undefined ? data.spTarget : -60;

            // Switch OBS scene first for instant visual feedback
            await obs.call('SetCurrentProgramScene', { sceneName: 'Live Übertragung' });
            io.emit('terminalOutput', 'Switched to scene: Live Übertragung');

            if (audioBackend.isConnected() && audioBackend.getCapabilities().fade) {
                const state3 = await audioBackend.getChannelState(3);
                const state4 = await audioBackend.getChannelState(4);

                await audioBackend.applyPreset({
                    channels: [
                        { id: 3, fromDb: state3.gainDb, toDb: tvTarget },
                        { id: 4, fromDb: state4.gainDb, toDb: spTarget },
                    ],
                    durationMs: AUDIO_FADE_DURATION_MS,
                });

                io.emit('terminalOutput', 'Faded audio to Game levels.');
            } else {
                io.emit('terminalOutput', 'Audio backend not available — skipping audio fades.');
            }

            io.emit('terminalOutput', 'Automated action completed successfully.');
            io.emit('actionDone', 'game');
        } catch (err) {
            console.error('Automated action (GameAction) failed:', err);
            io.emit('terminalOutput', 'Automated action failed: ' + err.message);
            io.emit('actionFailed');
        }
    });

    // ── PauseAction (automated) ───────────────────────────────────

    socket.on('PauseAction', async data => {
        try {
            const spTarget = data && data.spTarget !== undefined ? data.spTarget : 0;

            // Switch OBS scene first for instant visual feedback
            await obs.call('SetCurrentProgramScene', { sceneName: 'Spotify' });
            io.emit('terminalOutput', 'Switched to scene: Spotify');

            if (audioBackend.isConnected() && audioBackend.getCapabilities().fade) {
                const state3 = await audioBackend.getChannelState(3);
                const state4 = await audioBackend.getChannelState(4);

                await audioBackend.applyPreset({
                    channels: [
                        { id: 3, fromDb: state3.gainDb, toDb: -60 },
                        { id: 4, fromDb: state4.gainDb, toDb: spTarget },
                    ],
                    durationMs: AUDIO_FADE_DURATION_MS,
                });

                io.emit('terminalOutput', 'Faded out TV and faded in Spotify.');
            } else {
                io.emit('terminalOutput', 'Audio backend not available — skipping audio fades.');
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
    });
});

// ── Graceful shutdown ─────────────────────────────────────────────
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    audioBackend.shutdown().catch(() => {});
    if (obsReconnectTimer) { clearTimeout(obsReconnectTimer); obsReconnectTimer = null; }
    try { obs.disconnect(); } catch (e) {}
    io.emit('terminalOutput', 'Server shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(3000, () => {
    console.log('Server is running on port 3000');
    io.emit('terminalOutput', 'Server is running on port 3000');

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
