using System.Runtime.InteropServices;

namespace RemoteControl.Windows;

/// <summary>
/// Remote sessions run without anyone at the host. Windows stops composing the desktop once the display sleeps,
/// and Desktop Duplication (ddagrab) then delivers no frames at all, so the stream stalls until someone turns
/// a monitor on. This keeps the display powered for the lifetime of the capture agent and wakes it at start.
/// </summary>
internal static class DisplayPower
{
    private const uint EsContinuous = 0x80000000;
    private const uint EsSystemRequired = 0x00000001;
    private const uint EsDisplayRequired = 0x00000002;
    private const uint MouseMove = 0x0001;

    public static void KeepAwakeForSession()
    {
        try
        {
            // Applies to the calling thread until the process exits; the agent's main thread lives for the session.
            SetThreadExecutionState(EsContinuous | EsSystemRequired | EsDisplayRequired);
            // Injected input counts as user activity and wakes a display that already went to sleep. Some builds ignore
            // a zero-length move, so nudge one pixel and back: the pointer ends where it was.
            var inputs = new[]
            {
                new INPUT { type = 0, mi = new MOUSEINPUT { dx = 1, dwFlags = MouseMove } },
                new INPUT { type = 0, mi = new MOUSEINPUT { dx = -1, dwFlags = MouseMove } },
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException) { }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public MOUSEINPUT mi;
        // INPUT is a union sized by its largest member (MOUSEINPUT on x64); no padding needed for the mouse case.
    }

    [DllImport("kernel32.dll")]
    private static extern uint SetThreadExecutionState(uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, [In] INPUT[] inputs, int size);
}
