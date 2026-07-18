const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_DEVICES = 20;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeEqualHex(a, b) {
    const valid = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
    if (!valid(a) || !valid(b)) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function randomCode(length = 8) {
    let out = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
}

class PairingManager {
    constructor(filePath) {
        this.filePath = filePath;
        this.codes = new Map();
        this.devices = this._load();
    }

    _load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            return Array.isArray(parsed.devices) ? parsed.devices.filter(d => d && d.id && d.tokenHash) : [];
        } catch (_) {
            return [];
        }
    }

    _persist() {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = this.filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, devices: this.devices }, null, 2), 'utf8');
        fs.renameSync(tmp, this.filePath);
    }

    createCode() {
        const now = Date.now();
        for (const [code, entry] of this.codes) {
            if (entry.expiresAt <= now) this.codes.delete(code);
        }
        const code = randomCode();
        const expiresAt = now + CODE_TTL_MS;
        this.codes.set(code, { expiresAt });
        return { code, expiresAt };
    }

    claim(code, deviceName) {
        const normalized = String(code || '').trim().toUpperCase();
        const entry = this.codes.get(normalized);
        if (!entry || entry.expiresAt <= Date.now()) {
            this.codes.delete(normalized);
            return null;
        }
        this.codes.delete(normalized); // one scan, one device

        const token = crypto.randomBytes(32).toString('base64url');
        const device = {
            id: crypto.randomUUID(),
            name: String(deviceName || 'Operator device').trim().slice(0, 60) || 'Operator device',
            tokenHash: hashToken(token),
            createdAt: Date.now(),
        };
        this.devices.push(device);
        if (this.devices.length > MAX_DEVICES) this.devices.splice(0, this.devices.length - MAX_DEVICES);
        this._persist();
        return { token, device: this.publicDevice(device) };
    }

    findDevice(token) {
        if (typeof token !== 'string' || token.length < 32) return null;
        const candidate = hashToken(token);
        const device = this.devices.find(item => safeEqualHex(candidate, item.tokenHash));
        return device ? this.publicDevice(device) : null;
    }

    verify(token) {
        return !!this.findDevice(token);
    }

    revokeDevice(id) {
        const index = this.devices.findIndex(device => device.id === id);
        if (index < 0) return null;
        const [device] = this.devices.splice(index, 1);
        this._persist();
        return this.publicDevice(device);
    }

    revokeAll() {
        this.devices = [];
        this.codes.clear();
        this._persist();
    }

    publicDevice(device) {
        return { id: device.id, name: device.name, createdAt: device.createdAt };
    }

    listDevices() {
        return this.devices.map(device => this.publicDevice(device));
    }
}

function isLoopback(address) {
    const value = String(address || '').toLowerCase();
    return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

module.exports = { PairingManager, isLoopback, hashToken };
