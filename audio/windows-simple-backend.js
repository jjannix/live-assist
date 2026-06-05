/**
 * WindowsSimpleBackend — per-app volume via Windows audio sessions.
 *
 * Uses a persistent PowerShell sidecar process to keep round-trip
 * latency low enough for smooth fades.
 *
 * The C# CoreAudio helper is loaded from sidecar-coreaudio.cs
 * (kept as a separate file to avoid JS template-literal escaping issues).
 *
 * Channel mapping is env-driven:
 *   AUDIO_CHANNEL_3_APPS=obs64.exe,chrome.exe   → logical channel 3 (TV)
 *   AUDIO_CHANNEL_4_APPS=spotify.exe             → logical channel 4 (Spotify)
 */

const AudioBackend = require('./interface');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── dB ↔ scalar conversion (perceptual / logarithmic) ────────────

const DB_MIN = -60;
const DB_MAX = 12;

/** dB → scalar:  s = 10^(dB/20).  −6 dB → ~0.5,  0 dB → 1.0 */
function dbToScalar(db) {
    if (db <= DB_MIN) return 0;
    if (db >= DB_MAX) return 1;
    const s = Math.pow(10, db / 20);
    return Math.max(0, Math.min(1, s));
}

/** Scalar → dB:  dB = 20·log₁₀(s).  1.0 → 0 dB,  0.5 → −6 dB */
function scalarToDb(s) {
    if (s <= 0) return DB_MIN;
    const db = 20 * Math.log10(s);
    return Math.max(DB_MIN, Math.min(DB_MAX, db));
}

// ── Sidecar helper ───────────────────────────────────────────────

class Sidecar {
    constructor() {
        this._proc = null;
        this._id = 0;
        this._pending = new Map();
        this._buffer = '';
        this._dead = false;
        this._log = () => {};
        this._healthInterval = null;
        this._restarting = false;
        this._onRestarted = null;
    }

    setLogger(fn) { this._log = fn; }
    onRestarted(cb) { this._onRestarted = cb; }

    async start() {
        if (this._proc && !this._dead) return;
        this._dead = false;
        // Process is spawned inside _sendBootstrap via -File
        await this._sendBootstrap();
        this._startHealthCheck();
    }

    _scheduleRestart() {
        if (this._restarting) return;
        this._restarting = true;
        this._log('Sidecar died — restarting in 2s…');
        setTimeout(async () => {
            this._restarting = false;
            try {
                await this.start();
                this._log('Sidecar restarted successfully');
                if (this._onRestarted) this._onRestarted();
            } catch (e) { this._log('Sidecar restart failed: ' + e.message); }
        }, 2000);
    }

    _startHealthCheck() {
        if (this._healthInterval) return;
        this._healthInterval = setInterval(async () => {
            if (this._dead) return;
            try { await this.request('ping', {}, 3000); } catch (e) {
                this._log('Sidecar health ping failed: ' + e.message);
                if (!this._dead && this._proc) { try { this._proc.kill(); } catch (_) {} }
            }
        }, 15000);
    }

    _stopHealthCheck() {
        if (this._healthInterval) { clearInterval(this._healthInterval); this._healthInterval = null; }
    }

    async _sendBootstrap() {
        // Write a PowerShell script to a temp file that loads the C# via
        // Add-Type -Path (avoids here-string issues when piping to stdin).
        // Then spawn the sidecar with -File instead of -Command -.
        const csPath = path.join(__dirname, 'sidecar-coreaudio.cs').replace(/\\/g, '/');
        const csCode = fs.readFileSync(path.join(__dirname, 'sidecar-coreaudio.cs'), 'utf8');

        const psScript = [
            'Add-Type -TypeDefinition @"',
            csCode,
            '"@',
            '$InputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
            'while ($null -ne ($line = [Console]::In.ReadLine())) {',
            '    if ($line.Trim() -eq "") { continue }',
            '    trap { Write-Output ("{\"ok\":false,\"error\":\"fatal: " + $_.Exception.Message + "\"}"); [Console]::Out.Flush(); continue }',
            '    try {',
            '        $req = $line | ConvertFrom-Json',
            '        $id = $req.id',
            '        $result = @{ id = $id; ok = $true }',
            '        switch ($req.cmd) {',
            '            "ping" { $result.data = @{ pong = $true; version = "1.1.0" } }',
            '            "probePidSlot" { $result.data = @{ detectedSlot = [CoreAudio]::GetDetectedPidSlot() } }',
            '            "invalidateCache" { [CoreAudio]::InvalidateCache(); $result.data = @{} }',
            '            "getSessions" {',
            '                $sessions = [CoreAudio]::GetSessions()',
            '                $list = @()',
            '                foreach ($s in $sessions) { $list += @{ processId = $s.ProcessId; processName = $s.ProcessName; volume = $s.Volume; muted = $s.Muted } }',
            '                $result.data = @{ sessions = $list }',
            '            }',
            '            "getVolume" {',
            '                $vol = [CoreAudio]::GetVolumeForProcess($req.processName.ToLower())',
            '                if ($null -eq $vol) { $result.ok = $false; $result.error = "Process not found" }',
            '                else { $result.data = @{ volume = $vol } }',
            '            }',
            '            "setVolume" {',
            '                $found = [CoreAudio]::SetVolumeForProcess($req.processName.ToLower(), [float]$req.volume)',
            '                if (-not $found) { $result.ok = $false; $result.error = "Process not found" }',
            '            }',
            '            "setMute" {',
            '                $found = [CoreAudio]::SetMuteForProcess($req.processName.ToLower(), [bool]$req.mute)',
            '                if (-not $found) { $result.ok = $false; $result.error = "Process not found" }',
            '            }',
            '            "getMute" {',
            '                $m = [CoreAudio]::GetMuteForProcess($req.processName.ToLower())',
            '                if ($null -eq $m) { $result.ok = $false; $result.error = "Process not found" }',
            '                else { $result.data = @{ muted = $m } }',
            '            }',
            '            default { $result.ok = $false; $result.error = "Unknown command" }',
            '        }',
            '    } catch { $result = @{ id = $id; ok = $false; error = $_.Exception.Message } }',
            '    $result | ConvertTo-Json -Compress | Write-Output',
            '    [Console]::Out.Flush()',
            '}',
        ].join('\n');

        // Write to temp file and spawn with -File
        const os = require('os');
        const tmpFile = path.join(os.tmpdir(), 'euro-sidecar-' + process.pid + '.ps1');
        fs.writeFileSync(tmpFile, psScript, 'utf8');
        this._scriptFile = tmpFile;

        // Kill old proc if any, respawn with -File
        this._proc = spawn('powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile
        ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

        this._proc.stdout.on('data', chunk => this._onStdout(chunk));
        this._proc.stderr.on('data', chunk => {
            const text = chunk.toString().trim();
            if (text) this._log('[sidecar stderr] ' + text);
        });
        this._proc.on('close', code => {
            this._log(`Sidecar exited with code ${code}`);
            this._dead = true;
            this._proc = null;
            for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('Sidecar process exited')); }
            this._pending.clear();
            this._scheduleRestart();
        });

        try {
            await this.request('ping', {}, 8000);
            this._log('Sidecar process started and ready');
        } catch (e) {
            this._log('Sidecar bootstrap failed: ' + e.message);
            throw e;
        }
    }

    request(cmd, params = {}, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            if (this._dead || !this._proc) { reject(new Error('Sidecar is not running')); return; }
            const id = ++this._id;
            const payload = JSON.stringify({ id, cmd, ...params });
            const timer = setTimeout(() => {
                if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(`Sidecar request timed out: ${cmd}`)); }
            }, timeoutMs);
            this._pending.set(id, { resolve, reject, timer });
            this._proc.stdin.write(payload + '\n');
        });
    }

    _onStdout(chunk) {
        this._buffer += chunk.toString();
        const lines = this._buffer.split('\n');
        this._buffer = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const resp = JSON.parse(trimmed);
                if (this._pending.has(resp.id)) {
                    const { resolve, reject, timer } = this._pending.get(resp.id);
                    clearTimeout(timer);
                    this._pending.delete(resp.id);
                    resp.ok ? resolve(resp.data || {}) : reject(new Error(resp.error || 'Unknown sidecar error'));
                }
            } catch (e) { /* non-JSON noise */ }
        }
    }

    kill() {
        this._stopHealthCheck();
        for (const [, p] of this._pending) { clearTimeout(p.timer); }
        this._pending.clear();
        if (this._proc && !this._dead) { try { this._proc.kill(); } catch (e) {} this._dead = true; this._proc = null; }
    }
}

// ── Backend implementation ────────────────────────────────────────

class WindowsSimpleBackend extends AudioBackend {
    constructor(channelMap = {}) {
        super();
        this.name = 'windows-simple';
        this._channelMap = channelMap;
        this._connected = false;
        this._sidecar = new Sidecar();
        this._muteState = {};
        this._log = () => {};
    }

    setLogger(fn) {
        this._log = fn;
        this._sidecar.setLogger(fn);
        this._sidecar.onRestarted(() => {
            this._log('Sidecar auto-restarted — refreshing channel state');
            this._refreshAllChannels().catch(() => {});
            this._emitStatus(true, 'Audio backend reconnected after sidecar restart');
        });
    }

    async init() {
        this._log('Windows-simple: starting sidecar process…');
        try {
            await this._sidecar.start();
            this._connected = true;
            this._log('Windows-simple: sidecar ready');
            await this._refreshAllChannels();
            this._emitStatus(true, 'Windows audio sessions connected');
        } catch (e) {
            this._connected = false;
            this._log('Windows-simple: sidecar failed — ' + e.message);
            this._emitStatus(false, 'Windows audio backend unavailable');
            throw e;
        }
    }

    async shutdown() { this._connected = false; this._sidecar.kill(); }
    isConnected() { return this._connected; }

    getCapabilities() {
        return Object.freeze({
            perChannelVolume: true,
            mute: true,
            profiles: false,
            sceneAutoProfile: false,
            fade: true,
            units: 'db',
        });
    }

    async getChannelState(channelId) {
        const apps = this._getApps(channelId);
        if (!apps.length) return { gainDb: DB_MIN, muted: true };
        try {
            const vol = await this._sidecar.request('getVolume', { processName: apps[0] });
            const mutResp = await this._sidecar.request('getMute', { processName: apps[0] });
            this._muteState[channelId] = mutResp.muted;
            return { gainDb: scalarToDb(vol.volume), muted: mutResp.muted };
        } catch (e) {
            this._log(`Channel ${channelId}: could not read state — ${e.message}`);
            return { gainDb: DB_MIN, muted: true };
        }
    }

    async setChannelGain(channelId, gainDb) {
        if (!this._connected) return;
        const scalar = dbToScalar(gainDb);
        const apps = this._getApps(channelId);
        for (const app of apps) {
            try { await this._sidecar.request('setVolume', { processName: app, volume: scalar }); }
            catch (e) { this._log(`Channel ${channelId} (${app}): setVolume failed — ${e.message}`); }
        }
    }

    async toggleMute(channelId) {
        if (!this._connected) return { muted: false };
        const nowMuted = !this._muteState[channelId];
        this._muteState[channelId] = nowMuted;
        const apps = this._getApps(channelId);
        for (const app of apps) {
            try { await this._sidecar.request('setMute', { processName: app, mute: nowMuted }); }
            catch (e) { this._log(`Channel ${channelId} (${app}): setMute failed — ${e.message}`); }
        }
        return { muted: nowMuted };
    }

    async setMultiChannelGain(gains) {
        if (!this._connected) return;
        for (const [id, db] of Object.entries(gains)) {
            const scalar = dbToScalar(db);
            const apps = this._getApps(Number(id));
            for (const app of apps) {
                try { await this._sidecar.request('setVolume', { processName: app, volume: scalar }); }
                catch (e) { /* silently continue */ }
            }
        }
    }

    _getApps(channelId) {
        const ch = this._channelMap[channelId];
        return ch ? ch.apps.map(a => a.replace(/\.exe$/i, '').toLowerCase()) : [];
    }

    async _refreshAllChannels() {
        for (const id of Object.keys(this._channelMap)) {
            try { await this.getChannelState(Number(id)); }
            catch (e) { this._log(`Channel ${id}: refresh failed — ${e.message}`); }
        }
    }

    async reconnect() {
        this._connected = false;
        this._sidecar.kill();
        this._sidecar = new Sidecar();
        this._sidecar.setLogger(this._log);
        await this.init();
    }
}

module.exports = { WindowsSimpleBackend, dbToScalar, scalarToDb, DB_MIN, DB_MAX };
