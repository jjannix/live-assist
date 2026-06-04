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
 *   Windows API uses scalar 0.0 – 1.0
 *   UI / server contract uses dB (-60 .. +12)
 *   Conversion functions in this module handle mapping.
 */

const AudioBackend = require('./interface');
const { spawn } = require('child_process');
const path = require('path');

// ── dB ↔ scalar conversion ───────────────────────────────────────

const DB_MIN = -60;
const DB_MAX = 12;

// Pre-compute the scalar value that represents 0 dB on the UI.
// We want 0 dB to map to ~0.5 scalar (perceptual midpoint) and
// the full -60..+12 range to span 0..1.
const DB_RANGE = DB_MAX - DB_MIN; // 72
const ZERO_DB_FRACTION = (0 - DB_MIN) / DB_RANGE; // 60/72 ≈ 0.833

/**
 * Convert dB to 0–1 scalar.
 * Linear mapping:  -60 dB → 0,  0 dB → 0.833,  +12 dB → 1
 */
function dbToScalar(db) {
    if (db <= DB_MIN) return 0;
    if (db >= DB_MAX) return 1;
    return (db - DB_MIN) / DB_RANGE;
}

/**
 * Convert 0–1 scalar back to dB.
 */
function scalarToDb(s) {
    if (s <= 0) return DB_MIN;
    if (s >= 1) return DB_MAX;
    return DB_MIN + s * DB_RANGE;
}

// ── Sidecar helper ───────────────────────────────────────────────

/**
 * Persistent PowerShell process that reads JSON lines from stdin
 * and writes JSON lines to stdout.
 *
 * Protocol: each request is { id, cmd, ...params }
 *           each response is { id, ok, data?, error? }
 */
class Sidecar {
    constructor() {
        this._proc = null;
        this._id = 0;
        this._pending = new Map(); // id → { resolve, reject }
        this._buffer = '';
        this._dead = false;
        this._log = () => {};
    }

    setLogger(fn) { this._log = fn; }

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
                p.reject(new Error('Sidecar process exited'));
            }
            this._pending.clear();
        });

        // Bootstrap the script environment inside PowerShell
        await this._sendBootstrap();
    }

    async _sendBootstrap() {
        // We load the AudioSession API functions into the runspace once.
        const bootstrap = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class AudioUtils {
    [DllImport("user32.dll")]
    public static extern IntPtr GetDesktopWindow();
}
"@

$script:AsvType = $null

function Ensure-AsvType {
    if ($script:AsvType) { return }
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class AudioSession {
    public int ProcessId;
    public string ProcessName;
    public float Volume;
    public bool Muted;
}

public class AudioSessionHelper {
    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(ref Guid clsid, IntPtr unk, int ctx, ref Guid iid, out object ppv);

    [DllImport("ole32.dll")]
    static extern int CoInitialize(IntPtr pvReserved);

    public static void EnsureCom() { CoInitialize(IntPtr.Zero); }

    public static List<AudioSession> GetAllSessions() {
        EnsureCom();
        var IID_IUnknown = new Guid("00000000-0000-0000-C000-000000000046");
        // We'll use a simpler approach via Get-Process + volume API
        return null; // placeholder
    }
}
"@
    $script:AsvType = [AudioSessionHelper]
}

# Use the built-in AudioSession cmdlets approach via C# interop
# Actually, let's use the simpler approach: nircmd or built-in .NET Audio
# For maximum compatibility, we use a C# inline approach with Core Audio APIs

function Init-AudioHelper {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
using System.Threading;

public enum DeviceState : uint { Active = 1 }

public class CoreAudio {
    [DllImport("ole32.dll", CallingConvention = CallingConvention.StdCall)]
    static extern int CoInitialize(IntPtr pvReserved);

    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(
        [In] ref Guid rclsid,
        [In] IntPtr pUnkOuter,
        [In] uint dwClsCtx,
        [In] ref Guid riid,
        [Out] out IntPtr ppv);

    static Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static Guid IID_IMMDeviceEnumerator = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
    static Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    static Guid IID_IMMDevice = new Guid("D666063F-1587-4E43-81F1-B948E807363F");

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

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2 {
        int GetAudioSessionControl(ref Guid sessionId, int streamFlags, out IntPtr session);
        int GetSimpleAudioVolume(ref Guid sessionId, int streamFlags, out IntPtr volume);
        int GetSessionEnumerator(out IntPtr enumerator);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA012BDE228"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator {
        int GetCount(out int count);
        int GetSession(int index, out IntPtr session);
    }

    [ComImport, Guid("24918ACC-840C-4C7F-86A1-3E0B28C960B8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2 {
        // v-table order — we only need the later methods
        // We skip the base IAudioSessionControl methods (6)
        [PreserveSig] int GetProcessId(out uint pid);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume {
        int SetMasterVolume(float level, ref Guid eventContext);
        int GetMasterVolume(out float level);
        int SetMute(int mute, ref Guid eventContext);
        int GetMute(out int mute);
    }

    public class SessionInfo {
        public uint ProcessId;
        public string ProcessName;
        public float Volume;
        public bool Muted;
    }

    static bool comInitialized = false;
    public static void Init() {
        if (!comInitialized) { CoInitialize(IntPtr.Zero); comInitialized = true; }
    }

    static IntPtr GetDeviceEnumerator() {
        Init();
        IntPtr ptr;
        Guid clsid = CLSID_MMDeviceEnumerator;
        Guid iid = IID_IMMDeviceEnumerator;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 0x17, ref iid, out ptr);
        if (hr != 0) throw new Exception("CoCreateInstance failed: 0x" + hr.ToString("X"));
        return ptr;
    }

    static IntPtr GetDefaultDevice() {
        var enumerator = (IMMDeviceEnumerator)Marshal.GetObjectForIUnknown(GetDeviceEnumerator());
        IntPtr devPtr;
        int hr = enumerator.GetDefaultAudioEndpoint(0 /* eRender */, 0 /* eConsole */, out devPtr);
        if (hr != 0) throw new Exception("GetDefaultAudioEndpoint failed: 0x" + hr.ToString("X"));
        return devPtr;
    }

    static IAudioSessionManager2 GetSessionManager() {
        IntPtr devPtr = GetDefaultDevice();
        var device = (IMMDevice)Marshal.GetObjectForIUnknown(devPtr);
        IntPtr mgrPtr;
        Guid iid = IID_IAudioSessionManager2;
        int hr = device.Activate(ref iid, 0, IntPtr.Zero, out mgrPtr);
        if (hr != 0) throw new Exception("Activate SessionManager failed: 0x" + hr.ToString("X"));
        return (IAudioSessionManager2)Marshal.GetObjectForIUnknown(mgrPtr);
    }

    public static List<SessionInfo> GetSessions() {
        var result = new List<SessionInfo>();
        try {
            var mgr = GetSessionManager();
            IntPtr enumPtr;
            int hr = mgr.GetSessionEnumerator(out enumPtr);
            if (hr != 0) return result;
            var enumerator = (IAudioSessionEnumerator)Marshal.GetObjectForIUnknown(enumPtr);
            int count;
            enumerator.GetCount(out count);
            for (int i = 0; i < count; i++) {
                IntPtr sessPtr;
                if (enumerator.GetSession(i, out sessPtr) != 0) continue;
                try {
                    // QueryInterface for ISimpleAudioVolume
                    Guid iidVol = typeof(ISimpleAudioVolume).GUID;
                    IntPtr volPtr;
                    if (Marshal.QueryInterface(sessPtr, ref iidVol, out volPtr) == 0) {
                        var vol = (ISimpleAudioVolume)Marshal.GetObjectForIUnknown(volPtr);
                        float level;
                        vol.GetMasterVolume(out level);
                        int muted;
                        vol.GetMute(out muted);
                        Marshal.ReleaseComObject(vol);

                        // Get process ID
                        uint pid = 0;
                        try {
                            IntPtr ctrl2Ptr;
                            Guid iidCtrl2 = new Guid("24918ACC-840C-4C7F-86A1-3E0B28C960B8");
                            if (Marshal.QueryInterface(sessPtr, ref iidCtrl2, out ctrl2Ptr) == 0) {
                                var ctrl2 = (IAudioSessionControl2)Marshal.GetObjectForIUnknown(ctrl2Ptr);
                                ctrl2.GetProcessId(out pid);
                                Marshal.ReleaseComObject(ctrl2);
                            }
                        } catch {}

                        string procName = "";
                        if (pid > 0) {
                            try { procName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch {}
                        }

                        result.Add(new SessionInfo {
                            ProcessId = pid,
                            ProcessName = procName,
                            Volume = level,
                            Muted = muted != 0
                        });
                    }
                } catch {} finally {
                    Marshal.Release(sessPtr);
                }
            }
        } catch (Exception ex) {
            // Return what we have
        }
        return result;
    }

    public static bool SetVolumeForProcess(string processNameLower, float level) {
        bool found = false;
        try {
            var mgr = GetSessionManager();
            IntPtr enumPtr;
            if (mgr.GetSessionEnumerator(out enumPtr) != 0) return false;
            var enumerator = (IAudioSessionEnumerator)Marshal.GetObjectForIUnknown(enumPtr);
            int count;
            enumerator.GetCount(out count);
            Guid ctx = Guid.Empty;
            for (int i = 0; i < count; i++) {
                IntPtr sessPtr;
                if (enumerator.GetSession(i, out sessPtr) != 0) continue;
                try {
                    uint pid = 0;
                    try {
                        Guid iidCtrl2 = new Guid("24918ACC-840C-4C7F-86A1-3E0B28C960B8");
                        IntPtr ctrl2Ptr;
                        if (Marshal.QueryInterface(sessPtr, ref iidCtrl2, out ctrl2Ptr) == 0) {
                            var ctrl2 = (IAudioSessionControl2)Marshal.GetObjectForIUnknown(ctrl2Ptr);
                            ctrl2.GetProcessId(out pid);
                            Marshal.ReleaseComObject(ctrl2);
                        }
                    } catch {}

                    string name = "";
                    if (pid > 0) {
                        try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch {}
                    }
                    if (name == processNameLower) {
                        Guid iidVol = typeof(ISimpleAudioVolume).GUID;
                        IntPtr volPtr;
                        if (Marshal.QueryInterface(sessPtr, ref iidVol, out volPtr) == 0) {
                            var vol = (ISimpleAudioVolume)Marshal.GetObjectForIUnknown(volPtr);
                            vol.SetMasterVolume(level, ref ctx);
                            Marshal.ReleaseComObject(vol);
                            found = true;
                        }
                    }
                } catch {} finally {
                    Marshal.Release(sessPtr);
                }
            }
        } catch {}
        return found;
    }

    public static bool SetMuteForProcess(string processNameLower, bool mute) {
        bool found = false;
        try {
            var mgr = GetSessionManager();
            IntPtr enumPtr;
            if (mgr.GetSessionEnumerator(out enumPtr) != 0) return false;
            var enumerator = (IAudioSessionEnumerator)Marshal.GetObjectForIUnknown(enumPtr);
            int count;
            enumerator.GetCount(out count);
            Guid ctx = Guid.Empty;
            for (int i = 0; i < count; i++) {
                IntPtr sessPtr;
                if (enumerator.GetSession(i, out sessPtr) != 0) continue;
                try {
                    uint pid = 0;
                    try {
                        Guid iidCtrl2 = new Guid("24918ACC-840C-4C7F-86A1-3E0B28C960B8");
                        IntPtr ctrl2Ptr;
                        if (Marshal.QueryInterface(sessPtr, ref iidCtrl2, out ctrl2Ptr) == 0) {
                            var ctrl2 = (IAudioSessionControl2)Marshal.GetObjectForIUnknown(ctrl2Ptr);
                            ctrl2.GetProcessId(out pid);
                            Marshal.ReleaseComObject(ctrl2);
                        }
                    } catch {}

                    string name = "";
                    if (pid > 0) {
                        try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch {}
                    }
                    if (name == processNameLower) {
                        Guid iidVol = typeof(ISimpleAudioVolume).GUID;
                        IntPtr volPtr;
                        if (Marshal.QueryInterface(sessPtr, ref iidVol, out volPtr) == 0) {
                            var vol = (ISimpleAudioVolume)Marshal.GetObjectForIUnknown(volPtr);
                            vol.SetMute(mute ? 1 : 0, ref ctx);
                            Marshal.ReleaseComObject(vol);
                            found = true;
                        }
                    }
                } catch {} finally {
                    Marshal.Release(sessPtr);
                }
            }
        } catch {}
        return found;
    }

    public static float? GetVolumeForProcess(string processNameLower) {
        try {
            var sessions = GetSessions();
            foreach (var s in sessions) {
                if (s.ProcessName == processNameLower) return s.Volume;
            }
        } catch {}
        return null;
    }

    public static bool? GetMuteForProcess(string processNameLower) {
        try {
            var sessions = GetSessions();
            foreach (var s in sessions) {
                if (s.ProcessName == processNameLower) return s.Muted;
            }
        } catch {}
        return null;
    }
}
"@
}

Init-AudioHelper

# Enable JSON input/output
$InputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line.Trim() -eq '') { continue }
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        $result = @{ id = $id; ok = $true }

        switch ($req.cmd) {
            'ping' {
                $result.data = @{ pong = $true }
            }
            'getSessions' {
                $sessions = [CoreAudio]::GetSessions()
                $list = @()
                foreach ($s in $sessions) {
                    $list += @{ processId = $s.ProcessId; processName = $s.ProcessName; volume = $s.Volume; muted = $s.Muted }
                }
                $result.data = @{ sessions = $list }
            }
            'getVolume' {
                $name = $req.processName.ToLower()
                $vol = [CoreAudio]::GetVolumeForProcess($name)
                if ($null -eq $vol) {
                    $result.ok = $false
                    $result.error = "Process '$name' not found in audio sessions"
                } else {
                    $result.data = @{ volume = $vol }
                }
            }
            'setVolume' {
                $name = $req.processName.ToLower()
                $level = [float]$req.volume
                $found = [CoreAudio]::SetVolumeForProcess($name, $level)
                if (-not $found) {
                    $result.ok = $false
                    $result.error = "Process '$name' not found in audio sessions"
                }
            }
            'setMute' {
                $name = $req.processName.ToLower()
                $mute = [bool]$req.mute
                $found = [CoreAudio]::SetMuteForProcess($name, $mute)
                if (-not $found) {
                    $result.ok = $false
                    $result.error = "Process '$name' not found in audio sessions"
                }
            }
            'getMute' {
                $name = $req.processName.ToLower()
                $m = [CoreAudio]::GetMuteForProcess($name)
                if ($null -eq $m) {
                    $result.ok = $false
                    $result.error = "Process '$name' not found in audio sessions"
                } else {
                    $result.data = @{ muted = $m }
                }
            }
            default {
                $result.ok = $false
                $result.error = "Unknown command: $($req.cmd)"
            }
        }
    } catch {
        $result = @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
    $result | ConvertTo-Json -Compress | Write-Output
    [Console]::Out.Flush()
}
`;
        this._proc.stdin.write(bootstrap + '\n');
        // Wait for the sidecar to be ready (ping/pong)
        try {
            await this.request('ping');
            this._log('Sidecar process started and ready');
        } catch (e) {
            this._log('Sidecar bootstrap failed: ' + e.message);
            throw e;
        }
    }

    /** Send a JSON request and wait for the response. */
    request(cmd, params = {}) {
        return new Promise((resolve, reject) => {
            if (this._dead || !this._proc) {
                reject(new Error('Sidecar is not running'));
                return;
            }
            const id = ++this._id;
            const payload = JSON.stringify({ id, cmd, ...params });
            this._pending.set(id, { resolve, reject });
            this._proc.stdin.write(payload + '\n');

            // Timeout after 10s
            setTimeout(() => {
                if (this._pending.has(id)) {
                    this._pending.delete(id);
                    reject(new Error(`Sidecar request timed out: ${cmd}`));
                }
            }, 10000);
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
                    const { resolve, reject } = this._pending.get(id);
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

        // Cached per-app volume (scalar) — updated on reads/writes
        this._volumeCache = {}; // channelId → scalar

        this._log = () => {};
    }

    /** Inject a logging function. */
    setLogger(fn) { this._log = fn; this._sidecar.setLogger(fn); }

    // ── AudioBackend interface ────────────────────────────────────

    async init() {
        this._log('Windows-simple: starting sidecar process…');
        try {
            await this._sidecar.start();
            this._connected = true;
            this._log('Windows-simple: sidecar ready');
            // Read initial state for all channels
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
            profiles: false,          // no persistence in simple mode
            sceneAutoProfile: false,  // no per-scene auto-profiles
            fade: true,
            units: 'db',
        });
    }

    async getChannelState(channelId) {
        const apps = this._getApps(channelId);
        if (!apps.length) return { gainDb: DB_MIN, muted: true };

        try {
            // Read from first mapped app
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

    /**
     * Override setMultiChannelGain to batch via sidecar more efficiently.
     */
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
