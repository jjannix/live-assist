const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PairingManager, isLoopback } = require('../pairing');

test('one-time pairing code issues a persistent verifiable token', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-assist-pairing-'));
    const file = path.join(dir, 'operator-pairing.json');
    try {
        const manager = new PairingManager(file);
        const { code } = manager.createCode();
        const result = manager.claim(code.toLowerCase(), 'Match phone');

        assert.ok(result.token.length >= 32);
        assert.equal(result.device.name, 'Match phone');
        assert.equal(manager.verify(result.token), true);
        assert.equal(manager.claim(code, 'Second phone'), null, 'code must only work once');

        const restarted = new PairingManager(file);
        assert.equal(restarted.verify(result.token), true, 'paired device should survive restart');
        assert.equal(restarted.listDevices().length, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('revokeAll invalidates every paired token', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-assist-pairing-'));
    const file = path.join(dir, 'operator-pairing.json');
    try {
        const manager = new PairingManager(file);
        const result = manager.claim(manager.createCode().code, 'Tablet');
        manager.revokeAll();
        assert.equal(manager.verify(result.token), false);
        assert.deepEqual(manager.listDevices(), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('loopback addresses are trusted', () => {
    assert.equal(isLoopback('127.0.0.1'), true);
    assert.equal(isLoopback('::1'), true);
    assert.equal(isLoopback('::ffff:127.0.0.1'), true);
    assert.equal(isLoopback('192.168.1.20'), false);
});
