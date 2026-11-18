param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$BackendPid,
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ParentPid,
    [Parameter(Mandatory = $true)][string]$ExpectedPath
)

# Only this process's verified native parent is eligible. Never inspect command lines,
# credentials or user configuration, and never match another process by title or name.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$backend = $null
$parent = $null
try {
    if ($BackendPid -eq $ParentPid -or -not [IO.Path]::IsPathRooted($ExpectedPath)) { exit 1 }
    $expected = [IO.Path]::GetFullPath($ExpectedPath)
    $self = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -Property ProcessId, ParentProcessId
    if ($null -eq $self -or [int]$self.ParentProcessId -ne $BackendPid) { exit 1 }
    $helperStarted = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks
    $identity = Get-CimInstance Win32_Process -Filter "ProcessId = $BackendPid" -Property ProcessId, ParentProcessId
    if ($null -eq $identity -or [int]$identity.ParentProcessId -ne $ParentPid) { exit 1 }
    $backend = [Diagnostics.Process]::GetProcessById($BackendPid)
    $parent = [Diagnostics.Process]::GetProcessById($ParentPid)
    # Hold live process handles throughout; never reacquire a PID after either process exits.
    $backendHandle = $backend.Handle
    $parentHandle = $parent.Handle
    $backendStarted = $backend.StartTime.ToUniversalTime().Ticks
    $parentStarted = $parent.StartTime.ToUniversalTime().Ticks
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($backend.HasExited -or $parent.HasExited -or $parentStarted -ge $backendStarted -or $backendStarted -ge $helperStarted -or
        $backend.SessionId -ne $session -or $parent.SessionId -ne $session -or $session -eq 0 -or
        -not [string]::Equals([IO.Path]::GetFullPath($parent.MainModule.FileName), $expected, [StringComparison]::OrdinalIgnoreCase)) { exit 1 }

    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;

public static class EasyAgWindowLayout {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
    delegate bool EnumProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLong64(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong32(IntPtr window, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT bounds);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SetWindowText(IntPtr window, string text);

    static bool Owned(IntPtr window, int owner) {
        uint actual;
        return IsWindow(window) && GetWindowThreadProcessId(window, out actual) != 0 && actual == (uint)owner;
    }
    // Tauri also creates visible, unowned tray/event helper HWNDs. Exclude them by
    // native styles before ambiguity checks; never select by title or process name.
    public static bool IsPrimaryWindowStyle(long style, long extendedStyle, string windowClass) {
        const long WS_EX_TOOLWINDOW = 0x00000080, WS_EX_NOACTIVATE = 0x08000000;
        const long WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000;
        if ((extendedStyle & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) != 0) return false;
        return (style & WS_CAPTION) == WS_CAPTION || (style & WS_THICKFRAME) != 0 ||
            String.Equals(windowClass, "Tauri Window", StringComparison.Ordinal);
    }
    static bool Primary(IntPtr window) {
        long style = IntPtr.Size == 8 ? GetWindowLong64(window, -16).ToInt64() : GetWindowLong32(window, -16);
        long extendedStyle = IntPtr.Size == 8 ? GetWindowLong64(window, -20).ToInt64() : GetWindowLong32(window, -20);
        var name = new StringBuilder(256);
        GetClassName(window, name, name.Capacity);
        return IsPrimaryWindowStyle(style, extendedStyle, name.ToString());
    }
    public static IntPtr Find(int owner) {
        var windows = new List<IntPtr>();
        if (!EnumWindows(delegate(IntPtr window, IntPtr unused) {
            if (Owned(window, owner) && IsWindowVisible(window) && GetWindow(window, 4) == IntPtr.Zero && Primary(window)) windows.Add(window);
            return true;
        }, IntPtr.Zero)) return new IntPtr(-1);
        return windows.Count == 1 ? windows[0] : windows.Count == 0 ? IntPtr.Zero : new IntPtr(-1);
    }
    public static bool Resize(IntPtr window, int owner) {
        if (Owned(window, owner)) SetWindowText(window, "星桥工作台 · Starbridge");
        if (!Owned(window, owner) || !IsWindowVisible(window) || IsIconic(window) || IsZoomed(window)) return false;
        // All following coordinates are physical pixels. Restore the helper thread's context.
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) return false;
        try {
            uint dpi = GetDpiForWindow(window);
            if (dpi == 0) return false;
            var info = new MONITORINFO(); info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (!GetMonitorInfo(MonitorFromWindow(window, 2), ref info)) return false;
            int workWidth = info.rcWork.Right - info.rcWork.Left, workHeight = info.rcWork.Bottom - info.rcWork.Top;
            int margin = (int)Math.Round(16.0 * dpi / 96.0);
            if (workWidth <= margin * 2 || workHeight <= margin * 2) return false;
            int width = Math.Min((int)Math.Round(1180.0 * dpi / 96.0), workWidth - margin * 2);
            int height = Math.Min((int)Math.Round(780.0 * dpi / 96.0), workHeight - margin * 2);
            int x = info.rcWork.Left + (workWidth - width) / 2, y = info.rcWork.Top + (workHeight - height) / 2;
            if (!Owned(window, owner) || !IsWindowVisible(window) || IsIconic(window) || IsZoomed(window)) return false;
            // SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS.
            // IntPtr.Zero is ignored by NOZORDER; never use TOPMOST, SHOWWINDOW or focus APIs.
            if (!SetWindowPos(window, IntPtr.Zero, x, y, width, height, 0x4214)) return false;
            // Verify once the owning UI thread processes the request. Never resize repeatedly.
            for (int i = 0; i < 7; i++) {
                RECT actual;
                if (!Owned(window, owner) || IsIconic(window) || IsZoomed(window)) return false;
                if (GetWindowRect(window, out actual) && Math.Abs(actual.Left - x) <= 2 && Math.Abs(actual.Top - y) <= 2 &&
                    Math.Abs(actual.Right - actual.Left - width) <= 2 && Math.Abs(actual.Bottom - actual.Top - height) <= 2) return true;
                Thread.Sleep(50);
            }
            return false;
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
}
'@

    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($deadline.ElapsedMilliseconds -lt 5000) {
        $backend.Refresh()
        $parent.Refresh()
        if ($backend.HasExited -or $parent.HasExited -or
            $backend.StartTime.ToUniversalTime().Ticks -ne $backendStarted -or $parent.StartTime.ToUniversalTime().Ticks -ne $parentStarted -or
            $backend.SessionId -ne $session -or $parent.SessionId -ne $session -or
            -not [string]::Equals([IO.Path]::GetFullPath($parent.MainModule.FileName), $expected, [StringComparison]::OrdinalIgnoreCase)) { exit 1 }
        $window = [EasyAgWindowLayout]::Find($ParentPid)
        if ($window -eq [IntPtr]::new(-1)) { exit 1 }
        if ($window -ne [IntPtr]::Zero) {
            # Recheck process liveness immediately before the one permitted mutation.
            if ($backend.HasExited -or $parent.HasExited) { exit 1 }
            if ([EasyAgWindowLayout]::Resize($window, $ParentPid)) { exit 0 }
            exit 1
        }
        Start-Sleep -Milliseconds 100
    }
    exit 1
} catch {
    # Do not return paths, command lines or raw exception text through the host bridge.
    exit 1
} finally {
    if ($null -ne $backend) { $backend.Dispose() }
    if ($null -ne $parent) { $parent.Dispose() }
}
