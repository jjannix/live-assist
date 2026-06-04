const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { default: OBSWebSocket } = require('obs-websocket-js');
let voicemeeter;
try { voicemeeter = require('voicemeeter-remote'); } catch (e) { console.log('Voicemeeter module not available'); }
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const obs = new OBSWebSocket();

// ── Auto-reconnect state & helpers
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const VM_HEALTH_CHECK_MS = 30000;

let shuttingDown = false;
let obsReconnectAttempt = 0;
let obsReconnectTimer = null;
let vmReconnectAttempt = 0;
let vmReconnectTimer = null;
let vmHealthCheckTimer = null;

function reconnectDelay(attempt) {
    return Math.min(RECONNECT_INITIAL_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
}

function setObsStatus(connected, detail = '') {
    io.emit('obsStatus', { connected });
    if (detail) io.emit('terminalOutput', detail);
}

function setVmStatus(connected, detail = '') {
    io.emit('vmStatus', { connected });
    if (detail) io.emit('terminalOutput', detail);
}

function scheduleOBSReconnect() {
    if (shuttingDown || obsReconnectTimer) return;
    const delay = reconnectDelay(obsReconnectAttempt);
    obsReconnectAttempt++;
    io.emit('terminalOutput', `OBS: reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${obsReconnectAttempt})…`);
    obsReconnectTimer = setTimeout(() => {
        obsReconnectTimer = null;
        connectOBSWebSocket();
    }, delay);
}

function scheduleVMReconnect() {
    if (shuttingDown || vmReconnectTimer || !voicemeeter) return;
    const delay = reconnectDelay(vmReconnectAttempt);
    vmReconnectAttempt++;
    io.emit('terminalOutput', `Voicemeeter: reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${vmReconnectAttempt})…`);
    vmReconnectTimer = setTimeout(async () => {
        vmReconnectTimer = null;
        await connectVoicemeeter();
    }, delay);
}

function startVMHealthCheck() {
    if (vmHealthCheckTimer || !voicemeeter) return;
    vmHealthCheckTimer = setInterval(() => {
        if (!vmConnected) return;
        try {
            voicemeeter.getStripGain(3);
        } catch (err) {
            console.error('VM health check failed:', err && err.message ? err.message : err);
            vmConnected = false;
            stopVMHealthCheck();
            setVmStatus(false, 'Voicemeeter connection lost');
            scheduleVMReconnect();
        }
    }, VM_HEALTH_CHECK_MS);
}

function stopVMHealthCheck() {
    if (vmHealthCheckTimer) {
        clearInterval(vmHealthCheckTimer);
        vmHealthCheckTimer = null;
    }
}

async function connectOBSWebSocket() {
    try {
        await obs.connect(process.env.OBS_WEBSOCKET_URL, process.env.OBS_WEBSOCKET_PASSWORD);
        obsReconnectAttempt = 0;
        console.log('Connected to OBS WebSocket');
        setObsStatus(true, 'Connected to OBS WebSocket');

        const { scenes } = await obs.call('GetSceneList');
        console.log('Available scenes:');
        scenes.forEach(scene => {
            console.log(scene.name);
        });

        const sources = await obs.call('GetInputList');
        console.log('Available audio sources:');
        sources.inputs.forEach(source => {
            console.log(source.inputName);
        });

        // Emit the current scene to clients
        const currentScene = await obs.call('GetCurrentProgramScene');
        io.emit('currentScene', { sceneName: currentScene.currentProgramSceneName });
    } catch (err) {
        console.error('Failed to connect to OBS WebSocket:', err);
        setObsStatus(false, 'Failed to connect to OBS WebSocket: ' + (err && err.message ? err.message : err));
        scheduleOBSReconnect();
    }
}

// Listen for OBS scene changes (e.g. someone switches directly in OBS)
obs.on('CurrentProgramSceneChanged', data => {
    console.log('OBS scene changed:', data.sceneName);
    io.emit('currentScene', { sceneName: data.sceneName });
    io.emit('terminalOutput', 'OBS scene changed to: ' + data.sceneName);

    // Auto-load scene profile if one is saved
    if (vmConnected) {
        const p = profiles['__scene_' + data.sceneName];
        if (p) {
            try {
                voicemeeter.setStripGain(3, p[3]);
                voicemeeter.setStripGain(4, p[4]);
                io.emit('profileLoaded', { name: data.sceneName, gains: p });
                io.emit('terminalOutput', 'Auto-loaded profile for: ' + data.sceneName);
            } catch(e) {}
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

let vmConnected = false;
const muteState = { 3: false, 4: false };

async function connectVoicemeeter() {
    if (!voicemeeter) {
        console.log('Voicemeeter module not loaded — skipping');
        io.emit('vmStatus', { connected: false });
        io.emit('terminalOutput', 'Voicemeeter not available — audio controls disabled');
        return;
    }
    try {
        await voicemeeter.init();
        await voicemeeter.login();
        await voicemeeter.updateDeviceList();
        vmConnected = true;
        vmReconnectAttempt = 0;
        console.log('Connected to Voicemeeter');
        setVmStatus(true, 'Connected to Voicemeeter');
        startVMHealthCheck();

        // Read initial mute state from Voicemeeter
        try {
            const tvMuted = voicemeeter.getStripMute(3) !== 0;
            const spMuted = voicemeeter.getStripMute(4) !== 0;
            muteState[3] = tvMuted;
            muteState[4] = spMuted;
            io.emit('muteState', { stripIndex: 3, muted: tvMuted });
            io.emit('muteState', { stripIndex: 4, muted: spMuted });
        } catch(e) {
            console.error('Failed to read initial mute state:', e.message || e);
        }

        // Read initial fader levels from Voicemeeter
        try {
            const tvGain = voicemeeter.getStripGain(3);
            const spGain = voicemeeter.getStripGain(4);
            io.emit('faderState', { stripIndex: 3, gain: tvGain });
            io.emit('faderState', { stripIndex: 4, gain: spGain });
        } catch(e) {
            console.error('Failed to read initial fader levels:', e.message || e);
        }
    } catch (err) {
        vmConnected = false;
        stopVMHealthCheck();
        console.error('Failed to connect to Voicemeeter:', err && err.message ? err.message : err);
        setVmStatus(false, 'Voicemeeter not available — audio controls disabled');
        scheduleVMReconnect();
    }
}

process.on('uncaughtException', err => {
    console.error('Uncaught exception:', err && err.message ? err.message : err);
});
process.on('unhandledRejection', err => {
    console.error('Unhandled rejection:', err && err.message ? err.message : err);
});

connectOBSWebSocket();
connectVoicemeeter();

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

    // Send current mute state to newly connected client
    if (vmConnected) {
        socket.emit('muteState', { stripIndex: 3, muted: muteState[3] });
        socket.emit('muteState', { stripIndex: 4, muted: muteState[4] });
        try {
            socket.emit('faderState', { stripIndex: 3, gain: voicemeeter.getStripGain(3) });
            socket.emit('faderState', { stripIndex: 4, gain: voicemeeter.getStripGain(4) });
        } catch(e) {}
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
        if (!vmConnected) {
            socket.emit('terminalOutput', 'Voicemeeter not connected — cannot set volume');
            return;
        }
        try {
            const volume = parseFloat(data.volume);
            voicemeeter.setStripGain(data.stripIndex, volume);
            io.emit('terminalOutput', 'Set volume for virtual input: ' + data.stripIndex + ' to ' + volume + ' dB');
        } catch (err) {
            console.error('Failed to set volume for virtual input:', err);
            io.emit('terminalOutput', 'Failed to set volume for virtual input: ' + err.message);
        }
    });

    // ── Mute toggle via Voicemeeter
    socket.on('toggleMute', data => {
        if (!vmConnected) return;
        try {
            const strip = data.stripIndex;
            const nowMuted = !muteState[strip];
            muteState[strip] = nowMuted;
            voicemeeter.setStripMute(strip, nowMuted);
            const label = strip === 3 ? 'TV' : 'Spotify';
            io.emit('muteState', { stripIndex: strip, muted: nowMuted });
            io.emit('terminalOutput', (nowMuted ? 'Muted' : 'Unmuted') + ' ' + label);
        } catch (err) {
            console.error('Failed to toggle mute:', err);
        }
    });

    // ── Save / Load audio profiles
    const profiles = {};  // { profileName: { 3: -1.2, 4: -6.5 } }

    socket.on('saveProfile', data => {
        if (!vmConnected) return;
        try {
            const name = data.name;
            const strip3 = voicemeeter.getStripGain(3);
            const strip4 = voicemeeter.getStripGain(4);
            profiles[name] = { 3: strip3, 4: strip4 };
            socket.emit('profileSaved', { name, gains: profiles[name] });
            io.emit('terminalOutput', 'Saved profile: ' + name);
        } catch (err) {
            console.error('Failed to save profile:', err);
        }
    });

    socket.on('loadProfile', data => {
        if (!vmConnected) return;
        const p = profiles[data.name];
        if (!p) return;
        try {
            voicemeeter.setStripGain(3, p[3]);
            voicemeeter.setStripGain(4, p[4]);
            io.emit('profileLoaded', { name: data.name, gains: p });
            io.emit('terminalOutput', 'Loaded profile: ' + data.name);
        } catch (err) {
            console.error('Failed to load profile:', err);
        }
    });

    socket.on('getProfiles', () => {
        socket.emit('profileList', profiles);
    });

    // ── Per-scene auto-profiles
    socket.on('saveSceneProfile', data => {
        if (!vmConnected) return;
        try {
            const name = data.sceneName;
            const strip3 = voicemeeter.getStripGain(3);
            const strip4 = voicemeeter.getStripGain(4);
            profiles['__scene_' + name] = { 3: strip3, 4: strip4 };
            io.emit('terminalOutput', 'Saved scene profile: ' + name);
        } catch (err) {
            console.error('Failed to save scene profile:', err);
        }
    });

    socket.on('GameAction', async data => {
        try {
            const tvTarget = data && data.tvTarget !== undefined ? data.tvTarget : 0;
            const spTarget = data && data.spTarget !== undefined ? data.spTarget : -60;

            // Switch OBS scene first for instant visual feedback
            await obs.call('SetCurrentProgramScene', { sceneName: 'Live Übertragung' });
            io.emit('terminalOutput', 'Switched to scene: Live Übertragung');

            if (vmConnected) {
                const fadeSteps = 60;
                const stepDuration = 15; // ms

                io.emit('terminalOutput', 'Fading audio.');
                for (let i = 0; i <= fadeSteps; i++) {
                    const progress = i / fadeSteps;
                    const tvGain = Math.round(-60 * (1 - progress) + tvTarget * progress);
                    const spGain = Math.round(-60 * progress + spTarget * (1 - progress));
                    try {
                        voicemeeter.setStripGain(3, tvGain);
                        voicemeeter.setStripGain(4, spGain);
                    } catch(e) {}
                    await new Promise(resolve => setTimeout(resolve, stepDuration));
                }
            } else {
                io.emit('terminalOutput', 'Voicemeeter not connected — skipping audio fades.');
            }

            io.emit('terminalOutput', 'Automated action completed successfully.');
            io.emit('actionDone', 'game');
        } catch (err) {
            console.error('Automated action (GameAction) failed:', err);
            io.emit('terminalOutput', 'Automated action failed: ' + err.message);
            io.emit('actionFailed');
        }
    });

    socket.on('PauseAction', async data => {
        try {
            // Break: TV goes silent (-60), Spotify fades to user's level
            const spTarget = data && data.spTarget !== undefined ? data.spTarget : 0;

            // Switch OBS scene first for instant visual feedback
            await obs.call('SetCurrentProgramScene', { sceneName: 'Spotify' });
            io.emit('terminalOutput', 'Switched to scene: Spotify');

            if (vmConnected) {
                const fadeSteps = 60;
                const stepDuration = 15; // ms

                for (let i = 0; i <= fadeSteps; i++) {
                    const progress = i / fadeSteps;
                    const mainInputGain = Math.round(-60 * progress);
                    const spotifyInputGain = Math.round(spTarget * progress + (-60) * (1 - progress));

                    try {
                        voicemeeter.setStripGain(3, mainInputGain);
                        voicemeeter.setStripGain(4, spotifyInputGain);
                    } catch(e) {}

                    await new Promise(resolve => setTimeout(resolve, stepDuration));
                }

                io.emit('terminalOutput', 'Faded out Main Input and faded in Spotify Input.');
            } else {
                io.emit('terminalOutput', 'Voicemeeter not connected — skipping audio fades.');
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
    stopVMHealthCheck();
    if (obsReconnectTimer) { clearTimeout(obsReconnectTimer); obsReconnectTimer = null; }
    if (vmReconnectTimer) { clearTimeout(vmReconnectTimer); vmReconnectTimer = null; }
    try { obs.disconnect(); } catch(e) {}
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
});
