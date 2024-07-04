const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { default: OBSWebSocket } = require('obs-websocket-js');
const voicemeeter = require('voicemeeter-remote');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const obs = new OBSWebSocket();

async function connectOBSWebSocket() {
    try {
        await obs.connect('ws://192.168.2.93:4444', 'B5CGTGKhOfNaC534');
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

    socket.on('automatedAction', async () => {
        try {
            // Switch to OBS Scene "ARD"
            await obs.call('SetCurrentProgramScene', { sceneName: 'Ard' });
            io.emit('terminalOutput', 'Switched to scene: ARD');

            // Set Spotify Input to -40 dB
            await voicemeeter.setStripGain(4, -40);
            io.emit('terminalOutput', 'Set Spotify Input to -40 dB');

            // Set Main Input to 0 dB
            await voicemeeter.setStripGain(3, 0);
            io.emit('terminalOutput', 'Set Main Input to 0 dB');

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
