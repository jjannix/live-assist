const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { default: OBSWebSocket } = require('obs-websocket-js');

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
    } catch (err) {
        console.error('Failed to connect to OBS WebSocket:', err);
    }
}

connectOBSWebSocket();

app.use(express.static('public'));

io.on('connection', socket => {
    console.log('Client connected');

    socket.on('transition', async data => {
        try {
            await obs.call('SetCurrentProgramScene', { 'sceneName': data.sceneName });
            console.log('Transitioned to scene:', data.sceneName);
        } catch (err) {
            console.error('Failed to transition:', err);
        }
    });

    socket.on('mute', async data => {
        try {
            await obs.call('SetInputMute', { inputName: data.inputName, inputMuted: true });
            console.log('Muted source:', data.inputName);
        } catch (err) {
            console.error('Failed to mute source:', err);
        }
    });

    socket.on('unmute', async data => {
        try {
            await obs.call('SetInputMute', { inputName: data.inputName, inputMuted: false });
            console.log('Unmuted source:', data.inputName);
        } catch (err) {
            console.error('Failed to unmute source:', err);
        }
    });

    socket.on('setVolume', async data => {
        try {
            const volume = parseFloat(data.volume);
            const dbVolume = 20 * Math.log10(volume); // Convert linear volume to dB
            await obs.call('SetInputVolume', { inputName: data.inputName, inputVolumeDb: dbVolume });
            console.log('Set volume for source:', data.inputName, 'to', dbVolume, 'dB');
        } catch (err) {
            console.error('Failed to set volume for source:', err);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

server.listen(3000, () => {
    console.log('Server is running on port 3000');
});
