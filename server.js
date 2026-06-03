const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { default: OBSWebSocket } = require('obs-websocket-js');
const voicemeeter = require('voicemeeter-remote');
const dotenv = require('dotenv');

dotenv.config();
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const obs = new OBSWebSocket();


async function connectOBSWebSocket() {
    try {
        await obs.connect(process.env.OBS_WEBSOCKET_URL, process.env.OBS_WEBSOCKET_PASSWORD);
        console.log('Connected to OBS WebSocket');

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
    }
}

async function connectVoicemeeter() {
    try {
        await voicemeeter.init();
        await voicemeeter.login();
        await voicemeeter.updateDeviceList();
        console.log('Connected to Voicemeeter');
    } catch (err) {
        console.error('Failed to connect to Voicemeeter:', err);
    }
}

connectOBSWebSocket();
connectVoicemeeter();

app.use(express.static('public'));

io.on('connection', socket => {
    console.log('Client connected');
    io.emit('terminalOutput', 'Client connected');

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
        try {
            const volume = parseFloat(data.volume);
            await voicemeeter.setStripGain(data.stripIndex, volume);
            console.log('Set volume for virtual input:', data.stripIndex, 'to', volume, 'dB');
            io.emit('terminalOutput', 'Set volume for virtual input: ' + data.stripIndex + ' to ' + volume + ' dB');
        } catch (err) {
            console.error('Failed to set volume for virtual input:', err);
            io.emit('terminalOutput', 'Failed to set volume for virtual input: ' + err.message);
        }
    });

    socket.on('GameAction', async () => {
        try {
            const fadeSteps = 100; // Number of steps for fading (adjust for smoothness)
            const stepDuration = 1 / fadeSteps;
    
            // Step 1: Fade out Spotify Input (Strip 4)
            io.emit('terminalOutput', 'Starting to fade out Spotify Input.');
            for (let i = 0; i <= fadeSteps; i++) {
                const progress = i / fadeSteps;
                const spotifyInputGain = Math.round(-60 * progress);
                await voicemeeter.setStripGain(4, spotifyInputGain);
                await new Promise(resolve => setTimeout(resolve, stepDuration));
            }
            io.emit('terminalOutput', 'Spotify Input faded out.');
    
            // Step 2: Fade in Main Input for OBS transition sound (Strip 3)
            io.emit('terminalOutput', 'Fading in Main Input for OBS transition.');
            for (let i = 0; i <= fadeSteps; i++) {
                const progress = i / fadeSteps;
                const mainInputGain = Math.round(-60 * (1 - progress));
                await voicemeeter.setStripGain(3, mainInputGain);
                await new Promise(resolve => setTimeout(resolve, stepDuration));
            }
    
            // Step 3: Switch to OBS Scene "Szene 2"
            await obs.call('SetCurrentProgramScene', { sceneName: 'Szene 2' });
            io.emit('terminalOutput', 'Switched to scene: Szene 2');
    
            // Step 4: Wait for OBS transition to complete
            await new Promise(resolve => setTimeout(resolve, 5000));
    
            io.emit('terminalOutput', 'Automated action completed successfully.');
        } catch (err) {
            console.error('Automated action failed:', err);
            io.emit('terminalOutput', 'Automated action failed: ' + err.message);
        }
    });

    socket.on('PauseAction', async () => {
        try {
            // Switch to OBS Scene "Szene 2"
            await obs.call('SetCurrentProgramScene', { sceneName: 'Szene 2' });
            io.emit('terminalOutput', 'Switched to scene: Szene 2');
    
            // Emit terminal output indicating OBS scene switch initiation
            io.emit('terminalOutput', 'Initiating OBS scene switch.');
    
            // Wait for 5 seconds to ensure the OBS transition completes
            await new Promise(resolve => setTimeout(resolve, 5500));
    
            // Start fading out Main Input and fading in Spotify Input simultaneously
            const fadeSteps = 100; // Number of steps for fading (adjust for smoothness)
            const stepDuration = 1 / fadeSteps; // Total duration divided by steps
    
            for (let i = 0; i <= fadeSteps; i++) {
                const progress = i / fadeSteps;
                const mainInputGain = Math.round(-60 * progress);
                const spotifyInputGain = Math.round(-60 * (1 - progress));
    
                await Promise.all([
                    voicemeeter.setStripGain(3, mainInputGain),
                    voicemeeter.setStripGain(4, spotifyInputGain)
                ]);
    
                await new Promise(resolve => setTimeout(resolve, stepDuration));
            }
    
            io.emit('terminalOutput', 'Faded out Main Input and faded in Spotify Input.');
            io.emit('terminalOutput', 'Automated action completed successfully.');
        } catch (err) {
            console.error('Automated action failed:', err);
            io.emit('terminalOutput', 'Automated action failed: ' + err.message);
        }
    });
    
    
    
    

    socket.on('disconnect', () => {
        console.log('Client disconnected');
        io.emit('terminalOutput', 'Client disconnected');
    });
});

server.listen(3000, () => {
    console.log('Server is running on port 3000');
    io.emit('terminalOutput', 'Server is running on port 3000');
});
