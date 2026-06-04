/**
 * WindowsSimpleBackend — per-app volume via Windows audio sessions.
 *
 * Uses a persistent PowerShell sidecar process to keep round-trip
 * latency low enough for smooth fades.
 *
 * Channel mapping is env-driven:
 *   AUDIO_CHANNEL_3_APPS=obs64.exe,chrome.exe   → logical channel 3 (TV)
 *   AUDIO_CHANNEL_4_APPS=spotify.exe             → logical channel 4 (Spotify)
 *
 * Volume normalisation:
 *   Windows ISimpleAudioVolume uses logarithmic scalar 0.0–1.0
 *   where 0.5 ≈ −6 dB.  We use 20·log₁₀(s) / 10^(dB/20) for
 *   perceptually correct mapping.
 */

const AudioBackend = require('./interface');
const { spawn } = require('child_process');

// ── dB ↔ scalar conversion (perceptual / logarithmic) ────────────

const DB_MIN = -60;
const DB_MAX = 12;

/**
 * Convert dB to 0–1 scalar using the audio-engineering standard:
 *   scalar = 10^(dB / 20)
 * This matches the Windows ISimpleAudioVolume logarithmic curve
 * where 0 dB → 1.0 and −6 dB → ~0.5.
 */
function dbToScalar(db) {
    if (db <= DB_MIN) return 0;
    if (db >= DB_MAX) return 1;
    const s = Math.pow(10, db / 20);
    return Math.max(0, Math.min(1, s));
}

/** Convert 0–1 scalar back to dB:  dB = 20·log₁₀(s) */
function scalarToDb(s) {
    if (s <= 0) return DB_MIN;
    const db = 20 * Math.log10(s);
    return Math.max(DB_MIN, Math.min(DB_MAX, db));
}

// ── Sidecar helper ───────────────────────────────────────────────

/**
 * Persistent PowerShell process that reads JSON lines from stdin
 * and writes JSON lines to stdout.
 *
 * Protocol: each request  is { id, cmd, ...params }
 *           each response is { id, ok, data?, error? }
 *
 * The sidecar caches the COM session manager as a singleton so
 * it is not re-created on every call (avoids reference leaks
 * and reduces latency).
 */
class Sidecar {
    constructor() {
        this._proc = null;
        this._id = 0;
        this._pending = new Map(); // id → { resolve, reject, timer }
        this._buffer = '';
        this._dead = false;
        this._log = () => {};
        this._healthInterval = null;
        this._restarting = false;
        this._onRestarted = null;
    }

    setLogger(fn) { this._log = fn; }

    /** Callback invoked when sidecar auto-restarts after a crash. */
    onRestarted(cb) { this._onRestarted = cb; }

    async start() {
        if (this._proc && !this._dead) return;

        this._dead = false;
        this._proc = spawn('powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        this._proc.stdout.on('data', chunk => this._onStdout(chunk));
        this._proc.stderr.on('data', chunk => {
            const text = chunk.toString().trim();
            if (text) this._log('[sidecar stderr] ' + text);
        });
        this._proc.on('close', code => {
            this._log(`Sidecar exited with code ${code}`);
            this._dead = true;
            this._proc = null;
            // Reject all pending requests
            for (const [id, p] of this._pending) {
                clearTimeout(p.timer);
                p.reject(new Error('Sidecar process exited'));
            }
            this._pending.clear();
            // Schedule auto-restart
            this._scheduleRestart();
        });

        await this._sendBootstrap();
        this._startHealthCheck();
    }

    // ── Auto-restart on crash ────────────────────────────────────

    _scheduleRestart() {
        if (this._restarting) return;
        this._restarting = true;
        const delay = 2000;
        this._log(`Sidecar died — restarting in ${delay}ms…`);
        setTimeout(async () => {
            this._restarting = false;
            try {
                await this.start();
                this._log('Sidecar restarted successfully');
                if (this._onRestarted) this._onRestarted();
            } catch (e) {
                this._log('Sidecar restart failed: ' + e.message);
            }
        }, delay);
    }

    // ── Health ping ──────────────────────────────────────────────

    _startHealthCheck() {
        if (this._healthInterval) return;
        this._healthInterval = setInterval(async () => {
            if (this._dead) return;
            try {
                await this.request('ping', {}, 3000);
            } catch (e) {
                this._log('Sidecar health ping failed: ' + e.message);
                // If the process is still alive but unresponsive, kill it
                // so the 'close' handler fires and triggers restart
                if (!this._dead && this._proc) {
                    try { this._proc.kill(); } catch (_) {}
                }
            }
        }, 15000);
    }

    _stopHealthCheck() {
        if (this._healthInterval) {
            clearInterval(this._healthInterval);
            this._healthInterval = null;
        }
    }

    // ── Bootstrap (clean, no dead code) ──────────────────────────

    async _sendBootstrap() {
        const bootstrap = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public enum DeviceState : uint { Active = 1 }

public class CoreAudio {
    [DllImport("ole32.dll", CallingConvention = CallingConvention.StdCall)]
    static extern int CoInitialize(IntPtr pvReserved);

    static Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static Guid IID_IMMDeviceEnumerator  = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
    static Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, DeviceState stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr device);
        int GetDevice(string id, out IntPtr device);
        int RegisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr activationParams, out IntPtr iface);
        int OpenPropertyStore(int stgmAccess, out IntPtr props);
        int GetId(out string id);
        int GetState(out DeviceState state);
    }

    // IAudioSessionControl2 inherits IAudioSessionControl (8 methods).
    // The full vtable must be declared so GetProcessId lands in the correct slot.
    [ComImport, Guid("24918ACC-840C-4C7F-86A1-3E0B28C960B8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2 {
        // ── IAudioSessionControl base (slots 0–7) ──
        int GetState(out int state);
        int GetDisplayName(out string name);
        int SetDisplayName(string name, ref Guid ctx);
        int GetIconPath(out string path);
        int SetIconPath(string path, ref Guid ctx);
        int SetGroupingParam(ref Guid groupingId, ref Guid ctx);
        int RegisterAudioSessionNotification(IntPtr notification);
        int UnregisterAudioSessionNotification(IntPtr notification);
        // ── IAudioSessionControl2 (slot 8) ──
        [PreserveSig] int GetProcessId(out uint pid);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA012BDE228"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator {
        int GetCount(out int count);
        int GetSession(int index, out IntPtr session);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume {
        int SetMasterVolume(float level, ref Guid eventContext);
        int GetMasterVolume(out float level);
        int SetMute(int mute, ref Guid eventContext);
        int GetMute(out int mute);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2 {
        int GetAudioSessionControl(ref Guid sessionId, int streamFlags, out IntPtr session);
        int GetSimpleAudioVolume(ref Guid sessionId, int streamFlags, out IntPtr volume);
        int GetSessionEnumerator(out IntPtr enumerator);
    }

    public class SessionInfo {
        public uint ProcessId;
        public string ProcessName;
        public float Volume;
        public bool Muted;
    }

    static bool comInit;
    static IntPtr cachedEnumeratorPtr;
    static IntPtr cachedManagerPtr;
    static IAudioSessionManager2 cachedManager;

    static void EnsureCom() {
        if (!comInit) { CoInitialize(IntPtr.Zero); comInit = true; }
    }

    static IntPtr CreateEnumerator() {
        EnsureCom();
        IntPtr ptr;
        Guid clsid = CLSID_MMDeviceEnumerator;
        Guid iid = IID_IMMDeviceEnumerator;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 0x17, ref iid, out ptr);
        if (hr != 0) throw new Exception("CoCreateInstance MMDeviceEnumerator failed: 0x" + hr.ToString("X"));
        return ptr;
    }

    static IAudioSessionManager2 GetCachedManager() {
        if (cachedManager != null) return cachedManager;

        EnsureCom();
        IntPtr enumPtr = CreateEnumerator();
        try {
            var enumerator = (IMMDeviceEnumerator)Marshal.GetObjectForIUnknown(enumPtr);
            IntPtr devPtr;
            int hr = enumerator.GetDefaultAudioEndpoint(0, 0, out devPtr);
            Marshal.ReleaseComObject(enumerator);
            if (hr != 0) throw new Exception("GetDefaultAudioEndpoint failed: 0x" + hr.ToString("X"));
            try {
                var device = (IMMDevice)Marshal.GetObjectForIUnknown(devPtr);
                IntPtr mgrPtr;
                Guid iid = IID_IAudioSessionManager2;
                hr = device.Activate(ref iid, 0, IntPtr.Zero, out mgrPtr);
                Marshal.ReleaseComObject(device);
                if (hr != 0) throw new Exception("Activate SessionManager failed: 0x" + hr.ToString("X"));
                cachedManagerPtr = mgrPtr;
                cachedManager = (IAudioSessionManager2)Marshal.GetObjectForIUnknown(mgrPtr);
                return cachedManager;
            } finally { Marshal.Release(devPtr); }
        } finally { Marshal.Release(enumPtr); }
    }

    /// Invalidate the cached session manager (e.g. after default device change).
    public static void InvalidateCache() {
        if (cachedManager != null) { Marshal.ReleaseComObject(cachedManager); cachedManager = null; }
        if (cachedManagerPtr != IntPtr.Zero) { Marshal.Release(cachedManagerPtr); cachedManagerPtr = IntPtr.Zero; }
        if (cachedEnumeratorPtr != IntPtr.Zero) { Marshal.Release(cachedEnumeratorPtr); cachedEnumeratorPtr = IntPtr.Zero; }
    }

    public static List<SessionInfo> GetSessions() {
        var result = new List<SessionInfo>();
        var mgr = GetCachedManager();
        IntPtr enumPtr;
        int hr = mgr.GetSessionEnumerator(out enumPtr);
        if (hr != 0) return result;
        try {
            var enumerator = (IAudioSessionEnumerator)Marshal.GetObjectForIUnknown(enumPtr);
            try {
                int count;
                enumerator.GetCount(out count);
                for (int i = 0; i < count; i++) {
                    IntPtr sessPtr;
                    if (enumerator.GetSession(i, out sessPtr) != 0) continue;
                    try {
                        Guid iidVol = typeof(ISimpleAudioVolume).GUID;
                        IntPtr volPtr;
                        if (Marshal.QueryInterface(sessPtr, ref iidVol, out volPtr) != 0) continue;
                        try {
                            var vol = (ISimpleAudioVolume)Marshal.GetObjectForIUnknown(volPtr);
                            try {
                                float level; vol.GetMasterVolume(out level);
                                int muted;   vol.GetMute(out muted);
                                uint pid = 0;
                                try {
                                    var ctrl2 = (IAudioSessionControl2)Marshal.GetObjectForIUnknown(sessPtr);
                                    try { ctrl2.GetProcessId(out pid); } finally { Marshal.ReleaseComObject(ctrl2); }
                                } catch {}
                                string procName = "";
                                if (pid > 0) {
                                    try { procName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch {}
                                }
                                result.Add(new SessionInfo { ProcessId = pid, ProcessName = procName, Volume = level, Muted = muted != 0 });
                            } finally { Marshal.ReleaseComObject(vol); }
                        } finally { Marshal.Release(volPtr); }
                    } finally { Marshal.Release(sessPtr); }
                }
            } finally { Marshal.ReleaseComObject(enumerator); }
        } finally { Marshal.Release(enumPtr); }
        return result;
    }

    static bool ForEachSession(string processNameLower, Action<ISimpleAudioVolume> action) {
        bool found = false;
        var mgr = GetCachedManager();
        IntPtr enumPtr;
        if (mgr.GetSessionEnumerator(out enumPtr) != 0) return false;
        try {
            var enumerator = (IAudioSessionEnumerator)Marshal.GetObjectForIUnknown(enumPtr);
            try {
                int count; enumerator.GetCount(out count);
                Guid ctx = Guid.Empty;
                for (int i = 0; i < count; i++) {
                    IntPtr sessPtr;
                    if (enumerator.GetSession(i, out sessPtr) != 0) continue;
                    try {
                        uint pid = 0;
                        try {
                            var ctrl2 = (IAudioSessionControl2)Marshal.GetObjectForIUnknown(sessPtr);
                            try { ctrl2.GetProcessId(out pid); } finally { Marshal.ReleaseComObject(ctrl2); }
                        } catch {}
                        string name = "";
                        if (pid > 0) {
                            try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch {}
                        }
                        if (name == processNameLower) {
                            Guid iidVol = typeof(ISimpleAudioVolume).GUID;
                            IntPtr volPtr;
                            if (Marshal.QueryInterface(sessPtr, ref iidVol, out volPtr) == 0) {
                                try {
                                    var vol = (ISimpleAudioVolume)Marshal.GetObjectForIUnknown(volPtr);
                                    try { action(vol); found = true; } finally { Marshal.ReleaseComObject(vol); }
                                } finally { Marshal.Release(volPtr); }
                            }
                        }
                    } finally { Marshal.Release(sessPtr); }
                }
            } finally { Marshal.ReleaseComObject(enumerator); }
        } finally { Marshal.Release(enumPtr); }
        return found;
    }

    public static bool SetVolumeForProcess(string processNameLower, float level) {
        return ForEachSession(processNameLower, vol => {
            Guid ctx = Guid.Empty;
            vol.SetMasterVolume(level, ref ctx);
        });
    }

    public static bool SetMuteForProcess(string processNameLower, bool mute) {
        return ForEachSession(processNameLower, vol => {
            Guid ctx = Guid.Empty;
            vol.SetMute(mute ? 1 : 0, ref ctx);
        });
    }

    public static float? GetVolumeForProcess(string processNameLower) {
        foreach (var s in GetSessions()) {
            if (s.ProcessName == processNameLower) return s.Volume;
        }
        return null;
    }

    public static bool? GetMuteForProcess(string processNameLower) {
        foreach (var s in GetSessions()) {
            if (s.ProcessName == processNameLower) return s.Muted;
        }
        return null;
    }
}
"@
$InputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line.Trim() -eq '') { continue }
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        $result = @{ id = $id; ok = $true }
        switch ($req.cmd) {
            'ping'   { $result.data = @{ pong = $true } }
            'invalidateCache' { [CoreAudio]::InvalidateCache(); $result.data = @{} }
            'getSessions' {
                $sessions = [CoreAudio]::GetSessions()
                $list = @()
                foreach ($s in $sessions) {
                    $list += @{ processId = $s.ProcessId; processName = $s.ProcessName; volume = $s.Volume; muted = $s.Muted }
                }
                $result.data = @{ sessions = $list }
            }
            'getVolume' {
                $vol = [CoreAudio]::GetVolumeForProcess($req.processName.ToLower())
                if ($null -eq $vol) { $result.ok = $false; $result.error = "Process '$($req.processName)' not found" }
                else { $result.data = @{ volume = $vol } }
            }
            'setVolume' {
                $found = [CoreAudio]::SetVolumeForProcess($req.processName.ToLower(), [float]$req.volume)
                if (-not $found) { $result.ok = $false; $result.error = "Process '$($req.processName)' not found" }
            }
            'setMute' {
                $found = [CoreAudio]::SetMuteForProcess($req.processName.ToLower(), [bool]$req.mute)
                if (-not $found) { $result.ok = $false; $result.error = "Process '$($req.processName)' not found" }
            }
            'getMute' {
                $m = [CoreAudio]::GetMuteForProcess($req.processName.ToLower())
                if ($null -eq $m) { $result.ok = $false; $result.error = "Process '$($req.processName)' not found" }
                else { $result.data = @{ muted = $m } }
            }
            default { $result.ok = $false; $result.error = "Unknown command: $($req.cmd)" }
        }
    } catch {
        $result = @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
    $result | ConvertTo-Json -Compress | Write-Output
    [Console]::Out.Flush()
}
`;
        this._proc.stdin.write(bootstrap + '\n');
        try {
            await this.request('ping', {}, 5000);
            this._log('Sidecar process started and ready');
        } catch (e) {
            this._log('Sidecar bootstrap failed: ' + e.message);
            throw e;
        }
    }

    // ── Request / response ───────────────────────────────────────

    /**
     * Send a JSON request and wait for the response.
     * @param {string} cmd
     * @param {Object} params
     * @param {number} [timeoutMs=10000]
     */
    request(cmd, params = {}, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            if (this._dead || !this._proc) {
                reject(new Error('Sidecar is not running'));
                return;
            }
            const id = ++this._id;
            const payload = JSON.stringify({ id, cmd, ...params });
            const timer = setTimeout(() => {
                if (this._pending.has(id)) {
                    this._pending.delete(id);
                    reject(new Error(`Sidecar request timed out: ${cmd}`));
                }
            }, timeoutMs);
            this._pending.set(id, { resolve, reject, timer });
            this._proc.stdin.write(payload + '\n');
        });
    }

    _onStdout(chunk) {
        this._buffer += chunk.toString();
        const lines = this._buffer.split('\n');
        this._buffer = lines.pop(); // keep incomplete line in buffer
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const resp = JSON.parse(trimmed);
                const id = resp.id;
                if (this._pending.has(id)) {
                    const { resolve, reject, timer } = this._pending.get(id);
                    clearTimeout(timer);
                    this._pending.delete(id);
                    if (resp.ok) {
                        resolve(resp.data || {});
                    } else {
                        reject(new Error(resp.error || 'Unknown sidecar error'));
                    }
                }
            } catch (e) {
                // Non-JSON line (PowerShell noise) — ignore
            }
        }
    }

    kill() {
        this._stopHealthCheck();
        // Clear any pending timers
        for (const [, p] of this._pending) { clearTimeout(p.timer); }
        this._pending.clear();
        if (this._proc && !this._dead) {
            try { this._proc.kill(); } catch (e) {}
            this._dead = true;
            this._proc = null;
        }
    }
}

// ── Backend implementation ────────────────────────────────────────

class WindowsSimpleBackend extends AudioBackend {
    /**
     * @param {Object} channelMap  { channelId: { name, apps: string[] } }
     * e.g. { 3: { name: 'TV', apps: ['obs64.exe','chrome.exe'] }, 4: { ... } }
     */
    constructor(channelMap = {}) {
        super();
        this.name = 'windows-simple';
        this._channelMap = channelMap;
        this._connected = false;
        this._sidecar = new Sidecar();
        this._muteState = {}; // channelId → bool
        this._volumeCache = {}; // channelId → scalar
        this._log = () => {};
    }

    /** Inject a logging function. */
    setLogger(fn) {
        this._log = fn;
        this._sidecar.setLogger(fn);
        this._sidecar.onRestarted(() => {
            this._log('Sidecar auto-restarted — refreshing channel state');
            this._refreshAllChannels().catch(() => {});
            this._emitStatus(true, 'Audio backend reconnected after sidecar restart');
        });
    }

    // ── AudioBackend interface ────────────────────────────────────

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

    async shutdown() {
        this._connected = false;
        this._sidecar.kill();
    }

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
            const scalar = vol.volume;
            this._volumeCache[channelId] = scalar;

            const mutResp = await this._sidecar.request('getMute', { processName: apps[0] });
            this._muteState[channelId] = mutResp.muted;

            return { gainDb: scalarToDb(scalar), muted: mutResp.muted };
        } catch (e) {
            this._log(`Channel ${channelId}: could not read state — ${e.message}`);
            return { gainDb: DB_MIN, muted: true };
        }
    }

    async setChannelGain(channelId, gainDb) {
        if (!this._connected) return;
        const scalar = dbToScalar(gainDb);
        this._volumeCache[channelId] = scalar;
        const apps = this._getApps(channelId);
        for (const app of apps) {
            try {
                await this._sidecar.request('setVolume', { processName: app, volume: scalar });
            } catch (e) {
                this._log(`Channel ${channelId} (${app}): setVolume failed — ${e.message}`);
            }
        }
    }

    async toggleMute(channelId) {
        if (!this._connected) return { muted: false };
        const nowMuted = !this._muteState[channelId];
        this._muteState[channelId] = nowMuted;
        const apps = this._getApps(channelId);
        for (const app of apps) {
            try {
                await this._sidecar.request('setMute', { processName: app, mute: nowMuted });
            } catch (e) {
                this._log(`Channel ${channelId} (${app}): setMute failed — ${e.message}`);
            }
        }
        return { muted: nowMuted };
    }

    async setMultiChannelGain(gains) {
        if (!this._connected) return;
        for (const [id, db] of Object.entries(gains)) {
            const scalar = dbToScalar(db);
            this._volumeCache[Number(id)] = scalar;
            const apps = this._getApps(Number(id));
            for (const app of apps) {
                try {
                    await this._sidecar.request('setVolume', { processName: app, volume: scalar });
                } catch (e) {
                    // Silently continue — one missing app shouldn't break the fade
                }
            }
        }
    }

    // ── Internal helpers ──────────────────────────────────────────

    _getApps(channelId) {
        const ch = this._channelMap[channelId];
        return ch ? ch.apps.map(a => a.replace(/\.exe$/i, '').toLowerCase()) : [];
    }

    async _refreshAllChannels() {
        for (const id of Object.keys(this._channelMap)) {
            try {
                await this.getChannelState(Number(id));
            } catch (e) {
                this._log(`Channel ${id}: refresh failed — ${e.message}`);
            }
        }
    }

    /** Force a reconnect (e.g. from health dashboard). */
    async reconnect() {
        this._connected = false;
        this._sidecar.kill();
        this._sidecar = new Sidecar();
        this._sidecar.setLogger(this._log);
        await this.init();
    }
}

module.exports = { WindowsSimpleBackend, dbToScalar, scalarToDb, DB_MIN, DB_MAX };
