const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { default: OBSWebSocket } = require('obs-websocket-js');
const log = require('./logger');
let voicemeeter;
try { voicemeeter = require('voicemeeter-remote'); } catch (e) { log.warn('Voicemeeter module not available:', e.message); }
const dotenv = require('dotenv');

dotenv.config();
log.info('Starting Euro Studio server...');
log.info('Environment loaded, OBS_WEBSOCKET_URL =', process.env.OBS_WEBSOCKET_URL || '(not set)');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const obs = new OBSWebSocket();

// Set up crash logging (writes stack traces to log file before exit)
log.setupCrashHandlers();

// Heartbeat — if the log stops, we know exactly when the process died
setInterval(() => {
    log.debug('Heartbeat: process alive, vmConnected =', vmConnected);
}, 30000);

// Prevent process from exiting if stdin closes (can happen in some bun scenarios)
process.stdin.resume();
process.stdin.on('error', () => {});


async function connectOBSWebSocket() {
    try {
        await obs.connect(process.env.OBS_WEBSOCKET_URL, process.env.OBS_WEBSOCKET_PASSWORD);
        log.info('Connected to OBS WebSocket');
        io.emit('obsStatus', { connected: true });
        io.emit('terminalOutput', 'Connected to OBS WebSocket');

        const { scenes } = await obs.call('GetSceneList');
        log.info('Available scenes:', scenes.map(s => s.name).join(', '));

        const sources = await obs.call('GetInputList');
        log.info('Available audio sources:', sources.inputs.map(s => s.inputName).join(', '));

        // Emit the current scene to clients
        const currentScene = await obs.call('GetCurrentProgramScene');
        io.emit('currentScene', { sceneName: currentScene.currentProgramSceneName });
        log.info('Initial OBS scene:', currentScene.currentProgramSceneName);
    } catch (err) {
        log.error('Failed to connect to OBS WebSocket:', err);
        io.emit('obsStatus', { connected: false });
        io.emit('terminalOutput', 'Failed to connect to OBS WebSocket: ' + err.message);
    }
}

// Listen for OBS scene changes (e.g. someone switches directly in OBS)
obs.on('CurrentProgramSceneChanged', data => {
    log.info('OBS scene changed:', data.sceneName);
    io.emit('currentScene', { sceneName: data.sceneName });
    io.emit('terminalOutput', 'OBS scene changed to: ' + data.sceneName);
});

obs.on('ConnectionClosed', () => {
    log.error('OBS WebSocket disconnected');
    io.emit('obsStatus', { connected: false });
    io.emit('terminalOutput', 'OBS WebSocket disconnected');
});

obs.on('ConnectionError', err => {
    log.error('OBS WebSocket error:', err);
    io.emit('obsStatus', { connected: false });
});

let vmConnected = false;

async function connectVoicemeeter() {
    if (!voicemeeter) {
        log.warn('Voicemeeter module not loaded — skipping');
        io.emit('vmStatus', { connected: false });
        io.emit('terminalOutput', 'Voicemeeter not available — audio controls disabled');
        return;
    }
    try {
        await voicemeeter.init();
        await voicemeeter.login();
        await voicemeeter.updateDeviceList();
        vmConnected = true;
        log.info('Connected to Voicemeeter');
        io.emit('vmStatus', { connected: true });
        io.emit('terminalOutput', 'Connected to Voicemeeter');
    } catch (err) {
        vmConnected = false;
        log.error('Failed to connect to Voicemeeter:', err && err.message ? err.message : err);
        io.emit('vmStatus', { connected: false });
        io.emit('terminalOutput', 'Voicemeeter not available — audio controls disabled');
    }
}

// Crash handlers are now managed by logger.setupCrashHandlers() above

connectOBSWebSocket();
connectVoicemeeter();

app.use(express.static('public'));

io.on('connection', async socket => {
    log.info('Client connected:', socket.id);

    // Send current OBS status and scene to newly connected client
    try {
        const currentScene = await obs.call('GetCurrentProgramScene');
        socket.emit('currentScene', { sceneName: currentScene.currentProgramSceneName });
        socket.emit('obsStatus', { connected: true });
    } catch (err) {
        log.warn('Could not get initial scene for client:', err.message);
        socket.emit('obsStatus', { connected: false });
    }

    socket.on('transition', async data => {
        try {
            await obs.call('SetCurrentProgramScene', { 'sceneName': data.sceneName });
            log.info('Transitioned to scene:', data.sceneName);
            io.emit('terminalOutput', 'Transitioned to scene: ' + data.sceneName);

            io.emit('currentScene', { sceneName: data.sceneName });
        } catch (err) {
            log.error('Failed to transition:', err);
            io.emit('terminalOutput', 'Failed to transition: ' + err.message);
        }
    });

    socket.on('mute', async data => {
        try {
            await obs.call('SetInputMute', { inputName: data.inputName, inputMuted: true });
            log.info('Muted source:', data.inputName);
            io.emit('terminalOutput', 'Muted source: ' + data.inputName);
        } catch (err) {
            log.error('Failed to mute source:', err);
            io.emit('terminalOutput', 'Failed to mute source: ' + err.message);
        }
    });

    socket.on('unmute', async data => {
        try {
            await obs.call('SetInputMute', { inputName: data.inputName, inputMuted: false });
            log.info('Unmuted source:', data.inputName);
            io.emit('terminalOutput', 'Unmuted source: ' + data.inputName);
        } catch (err) {
            log.error('Failed to unmute source:', err);
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
            await voicemeeter.setStripGain(data.stripIndex, volume);
            log.debug('Set volume for virtual input:', data.stripIndex, 'to', volume, 'dB');
            io.emit('terminalOutput', 'Set volume for virtual input: ' + data.stripIndex + ' to ' + volume + ' dB');
        } catch (err) {
            log.error('Failed to set volume for virtual input:', err);
            io.emit('terminalOutput', 'Failed to set volume for virtual input: ' + err.message);
        }
    });

    socket.on('GameAction', async () => {
        try {
            // Switch OBS scene immediately for instant visual feedback
            await obs.call('SetCurrentProgramScene', { sceneName: 'Live Übertragung' });
            io.emit('terminalOutput', 'Switched to scene: Live Übertragung');
            log.info('GameAction: switched OBS scene to Live Übertragung');

            if (vmConnected) {
                const fadeSteps = 60;
                const stepDuration = 15; // ms — longer steps, fewer iterations
        
                // Step 1: Fade out Spotify Input (Strip 4)
                io.emit('terminalOutput', 'Starting to fade out Spotify Input.');
                for (let i = 0; i <= fadeSteps; i++) {
                    const progress = i / fadeSteps;
                    const spotifyInputGain = Math.round(-60 * progress);
                    try { voicemeeter.setStripGain(4, spotifyInputGain); } catch(e) { log.debug('VM fade error:', e); }
                    await new Promise(resolve => setTimeout(resolve, stepDuration));
                }
                io.emit('terminalOutput', 'Spotify Input faded out.');
        
                // Step 2: Fade in Main Input for OBS transition sound (Strip 3)
                io.emit('terminalOutput', 'Fading in Main Input for OBS transition.');
                for (let i = 0; i <= fadeSteps; i++) {
                    const progress = i / fadeSteps;
                    const mainInputGain = Math.round(-60 * (1 - progress));
                    try { voicemeeter.setStripGain(3, mainInputGain); } catch(e) { log.debug('VM fade error:', e); }
                    await new Promise(resolve => setTimeout(resolve, stepDuration));
                }
            } else {
                io.emit('terminalOutput', 'Voicemeeter not connected — skipping audio fades.');
            }

            io.emit('terminalOutput', 'Automated action completed successfully.');
        } catch (err) {
            log.error('Automated action (GameAction) failed:', err);
            io.emit('terminalOutput', 'Automated action failed: ' + err.message);
        }
    });

    socket.on('PauseAction', async () => {
        try {
            // Switch OBS scene immediately for instant visual feedback
            await obs.call('SetCurrentProgramScene', { sceneName: 'Spotify' });
            io.emit('terminalOutput', 'Switched to scene: Spotify');
            log.info('PauseAction: switched OBS scene to Spotify');
    
            if (vmConnected) {
                // Fade audio after scene switch — no 5.5s dead wait
                const fadeSteps = 60;
                const stepDuration = 15; // ms
        
                for (let i = 0; i <= fadeSteps; i++) {
                    const progress = i / fadeSteps;
                    const mainInputGain = Math.round(-60 * progress);
                    const spotifyInputGain = Math.round(-60 * (1 - progress));
        
                    try {
                        voicemeeter.setStripGain(3, mainInputGain);
                        voicemeeter.setStripGain(4, spotifyInputGain);
                    } catch(e) { log.debug('VM fade error:', e); }
        
                    await new Promise(resolve => setTimeout(resolve, stepDuration));
                }
        
                io.emit('terminalOutput', 'Faded out Main Input and faded in Spotify Input.');
            } else {
                io.emit('terminalOutput', 'Voicemeeter not connected — skipping audio fades.');
            }

            io.emit('terminalOutput', 'Automated action completed successfully.');
        } catch (err) {
            log.error('Automated action (PauseAction) failed:', err);
            io.emit('terminalOutput', 'Automated action failed: ' + err.message);
        }
    });

    socket.on('disconnect', reason => {
        log.info('Client disconnected:', socket.id, 'reason:', reason);
        io.emit('terminalOutput', 'Client disconnected');
    });
});

server.listen(3000, () => {
    log.info('Server is running on port 3000');
    log.info('Log file:', log.LOG_FILE);
});
