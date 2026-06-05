using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class CoreAudio {
    [DllImport("ole32.dll", CallingConvention = CallingConvention.StdCall)]
    static extern int CoInitialize(IntPtr pvReserved);
    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(ref Guid rclsid, IntPtr pUnkOuter, uint dwClsCtx, ref Guid riid, out IntPtr ppv);

    static Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static Guid IID_IMMDeviceEnumerator  = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
    static Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    static Guid IID_ISimpleAudioVolume = new Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8");

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, uint stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr device);
        int GetDevice(string id, out IntPtr device);
        int RegisterEndpointNotificationCallback(IntPtr client);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr activationParams, out IntPtr iface);
        int OpenPropertyStore(int stgmAccess, out IntPtr props);
        int GetId(out string id);
        int GetState(out uint state);
    }
    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionManager2 {
        int GetAudioSessionControl(ref Guid sessionId, int streamFlags, out IntPtr session);
        int GetSimpleAudioVolume(ref Guid sessionId, int streamFlags, out IntPtr volume);
        int GetSessionEnumerator(out IntPtr enumerator);
        int RegisterSessionNotification(IntPtr notification);
        int UnregisterSessionNotification(IntPtr notification);
        int RegisterDuckNotification(string sessionId, IntPtr notification);
        int UnregisterDuckNotification(IntPtr notification);
    }

    public class SessionInfo {
        public uint ProcessId;
        public string ProcessName;
        public float Volume;
        public bool Muted;
    }

    static bool comInit;
    static IntPtr cachedManagerIUnknown;
    static IAudioSessionManager2 cachedManager;

    static void EnsureCom() {
        if (!comInit) { CoInitialize(IntPtr.Zero); comInit = true; }
    }

    static IntPtr CreateEnumerator() {
        EnsureCom();
        IntPtr ptr;
        Guid clsid = CLSID_MMDeviceEnumerator, iid = IID_IMMDeviceEnumerator;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 0x17, ref iid, out ptr);
        if (hr != 0) throw new Exception("CoCreateInstance failed: 0x" + hr.ToString("X"));
        return ptr;
    }

    static IAudioSessionManager2 GetManager() {
        if (cachedManager != null) return cachedManager;
        EnsureCom();
        IntPtr ep = CreateEnumerator();
        try {
            var en = (IMMDeviceEnumerator)Marshal.GetObjectForIUnknown(ep);
            IntPtr dp;
            int hr = en.GetDefaultAudioEndpoint(0, 0, out dp);
            Marshal.ReleaseComObject(en);
            if (hr != 0) throw new Exception("GetDefaultAudioEndpoint failed: 0x" + hr.ToString("X"));
            try {
                var dev = (IMMDevice)Marshal.GetObjectForIUnknown(dp);
                IntPtr mp; Guid iid = IID_IAudioSessionManager2;
                hr = dev.Activate(ref iid, 0, IntPtr.Zero, out mp);
                Marshal.ReleaseComObject(dev);
                if (hr != 0) throw new Exception("Activate failed: 0x" + hr.ToString("X"));
                cachedManagerIUnknown = mp;
                cachedManager = (IAudioSessionManager2)Marshal.GetObjectForIUnknown(mp);
                return cachedManager;
            } finally { Marshal.Release(dp); }
        } finally { Marshal.Release(ep); }
    }

    public static void InvalidateCache() {
        if (cachedManager != null) { Marshal.ReleaseComObject(cachedManager); cachedManager = null; }
        if (cachedManagerIUnknown != IntPtr.Zero) { Marshal.Release(cachedManagerIUnknown); cachedManagerIUnknown = IntPtr.Zero; }
        detectedPidSlot = -1;  // re-probe on next use
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int DGetCount(IntPtr self, out int count);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int DGetSession(IntPtr self, int index, out IntPtr session);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int DGetPid(IntPtr self, out uint pid);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int DGetVol(IntPtr self, out float level);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int DSetVol(IntPtr self, float level, ref Guid ctx);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int DGetMute(IntPtr self, out int mute);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int DSetMute(IntPtr self, int mute, ref Guid ctx);

    static IntPtr Vtbl(IntPtr obj, int slot) {
        return Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj, 0), slot * IntPtr.Size);
    }

    static T D<T>(IntPtr obj, int slot) where T : class {
        return (T)(object)Marshal.GetDelegateForFunctionPointer(Vtbl(obj, slot), typeof(T));
    }

    // ── GetProcessId vtable slot detection ─────────────────────────
    // Standard IAudioSessionControl2 has GetProcessId at vtable slot 11
    // (IUnknown:3 + IAudioSessionControl:8). Some Windows builds (e.g.
    // Win10 24H2) have inserted 1-3 extra methods into the session
    // control vtable (IAudioSessionControl3 / private extensions),
    // shifting GetProcessId to a higher slot. We probe a range and pick
    // the slot whose return value looks like a real PID.
    //
    // CSE (AccessViolationException) is allowed via attribute so a bad
    // slot doesn't crash the entire sidecar.
    static int detectedPidSlot = -1;

    [System.Runtime.ExceptionServices.HandleProcessCorruptedStateExceptions]
    static int DetectPidSlot(IntPtr sp) {
        if (detectedPidSlot >= 0) return detectedPidSlot;
        int probeStart = 3, probeEnd = 16;
        for (int slot = probeStart; slot <= probeEnd; slot++) {
            try {
                uint pid;
                int hr = D<DGetPid>(sp, slot)(sp, out pid);
                if (hr == 0 && pid > 0 && pid < 1000000) {
                    detectedPidSlot = slot;
                    return slot;
                }
            } catch {}
        }
        return -1;
    }

    [System.Runtime.ExceptionServices.HandleProcessCorruptedStateExceptions]
    static uint SafeGetPid(IntPtr sp) {
        if (detectedPidSlot < 0) DetectPidSlot(sp);
        if (detectedPidSlot < 0) return 0;
        try {
            uint pid;
            int hr = D<DGetPid>(sp, detectedPidSlot)(sp, out pid);
            return (hr == 0) ? pid : 0;
        } catch { return 0; }
    }

    public static int GetDetectedPidSlot() { return detectedPidSlot; }

    public static List<SessionInfo> GetSessions() {
        var result = new List<SessionInfo>();
        var mgr = GetManager();
        IntPtr se;
        if (mgr.GetSessionEnumerator(out se) != 0) return result;
        try {
            int cnt; D<DGetCount>(se, 3)(se, out cnt);
            for (int i = 0; i < cnt; i++) {
                IntPtr sp;
                if (D<DGetSession>(se, 4)(se, i, out sp) != 0) continue;
                try {
                    uint pid = SafeGetPid(sp);
                    string nm = "";
                    if (pid > 0) { try { nm = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch {} }
                    IntPtr vp;
                    Guid iidVol = IID_ISimpleAudioVolume;
                    if (Marshal.QueryInterface(sp, ref iidVol, out vp) == 0) {
                        try {
                            float vol; D<DGetVol>(vp, 4)(vp, out vol);
                            int mt; D<DGetMute>(vp, 6)(vp, out mt);
                            result.Add(new SessionInfo { ProcessId = pid, ProcessName = nm, Volume = vol, Muted = mt != 0 });
                        } finally { Marshal.Release(vp); }
                    }
                } finally { Marshal.Release(sp); }
            }
        } finally { Marshal.Release(se); }
        return result;
    }

    static bool ForEachSession(string processNameLower, Action<IntPtr> action) {
        bool found = false;
        var mgr = GetManager();
        IntPtr se;
        if (mgr.GetSessionEnumerator(out se) != 0) return false;
        try {
            int cnt; D<DGetCount>(se, 3)(se, out cnt);
            Guid iidVol = IID_ISimpleAudioVolume;
            for (int i = 0; i < cnt; i++) {
                IntPtr sp;
                if (D<DGetSession>(se, 4)(se, i, out sp) != 0) continue;
                try {
                    uint pid = SafeGetPid(sp);
                    string nm = "";
                    if (pid > 0) { try { nm = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch {} }
                    if (nm == processNameLower) {
                        IntPtr vp;
                        if (Marshal.QueryInterface(sp, ref iidVol, out vp) == 0) {
                            try { action(vp); found = true; } finally { Marshal.Release(vp); }
                        }
                    }
                } finally { Marshal.Release(sp); }
            }
        } finally { Marshal.Release(se); }
        return found;
    }

    public static bool SetVolumeForProcess(string processNameLower, float level) {
        Guid ctx = Guid.Empty;
        return ForEachSession(processNameLower, vp => D<DSetVol>(vp, 3)(vp, level, ref ctx));
    }

    public static bool SetMuteForProcess(string processNameLower, bool mute) {
        Guid ctx = Guid.Empty;
        return ForEachSession(processNameLower, vp => D<DSetMute>(vp, 5)(vp, mute ? 1 : 0, ref ctx));
    }

    public static float? GetVolumeForProcess(string processNameLower) {
        foreach (var s in GetSessions()) if (s.ProcessName == processNameLower) return s.Volume;
        return null;
    }

    public static bool? GetMuteForProcess(string processNameLower) {
        foreach (var s in GetSessions()) if (s.ProcessName == processNameLower) return s.Muted;
        return null;
    }
}
