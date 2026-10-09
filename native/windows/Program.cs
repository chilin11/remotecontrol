using System.Buffers.Binary;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using System.Globalization;

namespace RemoteControl.Windows;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 3 && args[0] == "--install-ffmpeg")
        {
            try
            {
                string executable = FfmpegInstaller.EnsureAsync(Path.GetFullPath(args[1]), null, CancellationToken.None).GetAwaiter().GetResult();
                File.WriteAllText(args[2], JsonSerializer.Serialize(new { executable }));
                return 0;
            }
            catch (Exception ex)
            {
                File.WriteAllText(args[2], JsonSerializer.Serialize(new { error = ex.Message }));
                return 1;
            }
        }
        if (args.Length == 0 || (args.Length == 1 && args[0] is "--desktop" or "--background"))
            return DesktopHost.Run(args.Length == 1 && args[0] == "--background");
        try
        {
            var preset = QualityPreset.Parse(args);
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            var screen = SystemInformation.VirtualScreen;
            if (screen.Width < 2 || screen.Height < 2)
                throw new InvalidOperationException("Windows did not report a usable virtual screen.");

            var (width, height) = preset.Fit(screen.Width, screen.Height);
            if (preset.IsHevc)
            {
                // Peak (2× target) also drives the level: Main-tier MaxBR is 25/40/60 Mbps for 5.0/5.1/5.2.
                preset = preset with { Level = VideoLimits.HevcLevel(width, height, preset.Fps, preset.Bitrate * 2L) };
            }
            else
            {
                // H.264 uses Level 5.0–5.2; only unusually large desktops are scaled or slowed further.
                var limits = VideoLimits.H264(width, height, preset.Fps);
                width = limits.Width;
                height = limits.Height;
                preset = preset with { Fps = limits.Fps, Level = limits.Level };
            }
            bool localCursor = args.Skip(2).Contains("local-cursor");
            return Agent.RunAsync(preset, screen, width, height, localCursor).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            try { PacketWriter.WriteError(ex.Message); }
            catch { /* stdout may already be closed */ }
            return 1;
        }
    }
}

internal static class Agent
{
    private const int MaxInputLineChars = 16 * 1024;

    public static async Task<int> RunAsync(QualityPreset preset, Rectangle screen, int width, int height, bool localCursor = false)
    {
        string ffmpeg = Environment.GetEnvironmentVariable("REMOTECONTROL_FFMPEG_PATH") ?? "ffmpeg.exe";
        if (string.IsNullOrWhiteSpace(ffmpeg))
            throw new InvalidOperationException("REMOTECONTROL_FFMPEG_PATH is empty.");
        if ((ffmpeg.Contains(Path.DirectorySeparatorChar) || ffmpeg.Contains(Path.AltDirectorySeparatorChar)) && !File.Exists(ffmpeg))
            throw new FileNotFoundException("The configured FFmpeg executable was not found.", ffmpeg);

        var input = new InputController(screen);
        var inputGate = new object();
        using var inputCancellation = new CancellationTokenSource();
        CancellationToken inputToken = inputCancellation.Token;
        // Windows redirected console reads may block synchronously and ignore cancellation.
        // Keep them off the coordinator thread; never await an idle read during shutdown.
        // Start before encoder probing so a disconnect during probing is noticed and probes are killed.
        Task inputTask = Task.Run(() => ReadInput(inputToken, input, inputGate));
        // Local cursor: the browser draws the pointer; FFmpeg leaves it out and only its shape is sent.
        if (localCursor) _ = CursorMonitor.RunAsync(inputToken);
        try
        {
            // GPU first (NVIDIA → AMD → Intel), then the same GPU encoder with GDI capture, then CPU encoding.
            // A failed attempt is only retried if it never produced a frame, so the browser sees one clean stream.
            EncoderBackend selected;
            using (var probeCancellation = CancellationTokenSource.CreateLinkedTokenSource(inputToken))
            {
                Task<EncoderBackend> selection = Task.Run(() => EncoderSelector.Select(ffmpeg, preset.Codec, probeCancellation.Token));
                if (await Task.WhenAny(selection, inputTask) == inputTask)
                {
                    probeCancellation.Cancel();
                    try { await selection; } catch (OperationCanceledException) { }
                    return 0;
                }
                selected = await selection;
            }
            // Desktop Duplication returns rotated displays unrotated; GDI capture follows the desktop orientation.
            bool singleDisplay = Screen.AllScreens.Length == 1 && !DisplayInfo.PrimaryIsRotated();
            var attempts = new List<(EncoderBackend Backend, bool SingleDisplay)>();
            if (selected != EncoderBackend.Software)
            {
                if (singleDisplay) attempts.Add((selected, true));
                attempts.Add((selected, false));
            }
            attempts.Add((EncoderBackend.Software, false));

            for (int index = 0; index < attempts.Count; index++)
            {
                var (backend, useDda) = attempts[index];
                bool last = index == attempts.Count - 1;
                var result = await RunPipelineAsync(ffmpeg, backend, preset, screen, width, height, useDda, !localCursor, inputTask);
                if (result.InputEnded) return 0;
                if (result.Error is null) return 0;
                if (!result.ProducedFrames && !last)
                {
                    Console.Error.WriteLine($"Video pipeline {FfmpegPipeline.Name(backend)}{(useDda ? "/ddagrab" : "/gdigrab")} failed, trying the next option: {result.Error}");
                    if (backend != EncoderBackend.Software && attempts[index + 1].Backend == EncoderBackend.Software)
                        EncoderSelector.Forget(ffmpeg, preset.Codec);
                    continue;
                }
                PacketWriter.WriteError(result.Error);
                return 1;
            }
            return 1;
        }
        finally
        {
            inputCancellation.Cancel();
            // Release immediately even if the Windows stdin pipe is still blocked.
            lock (inputGate) input.ReleaseHeldInputs();
        }
    }

    private sealed record PipelineResult(bool InputEnded, bool ProducedFrames, string? Error);

    private static async Task<PipelineResult> RunPipelineAsync(string ffmpeg, EncoderBackend backend, QualityPreset preset,
        Rectangle screen, int width, int height, bool useDda, bool drawMouse, Task inputTask)
    {
        using var process = new Process { StartInfo = BuildStartInfo(ffmpeg, backend, preset, screen, width, height, useDda, drawMouse), EnableRaisingEvents = true };
        try
        {
            if (!process.Start()) throw new InvalidOperationException("FFmpeg could not be started.");
        }
        catch (Exception ex) when (ex is not InvalidOperationException || ex.Message != "FFmpeg could not be started.")
        {
            throw new InvalidOperationException($"Could not start FFmpeg ({ffmpeg}): {ex.Message}", ex);
        }

        var stderr = new StderrTail();
        Task stderrTask = stderr.CollectAsync(process.StandardError);
        // Stream metadata goes out just before the first frame, so a failed GPU attempt sends nothing.
        var parser = new AnnexBAccessUnitParser(preset.Codec, () => new PacketWriter().WriteJson(1, new
        {
            type = "stream",
            codec = preset.Codec,
            codecString = preset.CodecString,
            width,
            height,
            fps = preset.Fps,
            encoder = FfmpegPipeline.Name(backend)
        }));
        Task captureTask = PumpCaptureAsync(process.StandardOutput.BaseStream, parser);
        try
        {
            Task first = await Task.WhenAny(captureTask, inputTask);
            if (first == inputTask)
            {
                await inputTask;
                StopProcess(process);
                try { await captureTask; }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                return new PipelineResult(true, parser.EmittedFrames, null);
            }
            try { await captureTask; }
            catch (InvalidDataException ex) when (!parser.EmittedFrames)
            {
                StopProcess(process);
                return new PipelineResult(false, false, ex.Message);
            }
            StopProcess(process);
            await process.WaitForExitAsync();
            await stderrTask;
            string detail = stderr.GetText();
            string message = $"FFmpeg stopped with code {process.ExitCode}" + (detail.Length == 0 ? "." : $": {detail}");
            if (backend == EncoderBackend.Software && preset.IsHevc && IsMissingLibx265(detail))
                message = $"This FFmpeg build does not include the libx265 HEVC encoder. Install an FFmpeg build with libx265 enabled or select h264. {message}";
            return new PipelineResult(false, parser.EmittedFrames, message);
        }
        finally
        {
            StopProcess(process);
        }
    }

    private static ProcessStartInfo BuildStartInfo(string ffmpeg, EncoderBackend backend, QualityPreset preset, Rectangle screen, int width, int height, bool useDda, bool drawMouse)
    {
        var info = new ProcessStartInfo
        {
            FileName = ffmpeg,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false
        };
        foreach (string argument in FfmpegPipeline.Arguments(backend, preset, screen, width, height, useDda, drawMouse)) info.ArgumentList.Add(argument);
        return info;
    }

    private static bool IsMissingLibx265(string stderr) =>
        stderr.Contains("Unknown encoder 'libx265'", StringComparison.OrdinalIgnoreCase) ||
        stderr.Contains("Unknown encoder \"libx265\"", StringComparison.OrdinalIgnoreCase);

    private static async Task PumpCaptureAsync(Stream stream, AnnexBAccessUnitParser parser)
    {
        byte[] chunk = new byte[64 * 1024];
        while (true)
        {
            int count = await stream.ReadAsync(chunk);
            if (count == 0) break;
            parser.Push(chunk.AsSpan(0, count));
        }
        parser.Finish();
    }

    private static void ReadInput(CancellationToken cancellationToken, InputController input, object inputGate)
    {
        using var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), detectEncodingFromByteOrderMarks: false, bufferSize: 4096, leaveOpen: true);
        while (!cancellationToken.IsCancellationRequested)
        {
            string? line = reader.ReadLine();
            if (line is null || cancellationToken.IsCancellationRequested) return;
            if (line.Length > MaxInputLineChars) continue;
            try
            {
                using JsonDocument document = JsonDocument.Parse(line);
                lock (inputGate)
                {
                    if (cancellationToken.IsCancellationRequested) return;
                    input.Handle(document.RootElement);
                }
            }
            catch (JsonException) { /* Ignore malformed client events. */ }
            catch (ArgumentException) { /* Ignore incomplete or unsupported events. */ }
        }
    }

    private static void StopProcess(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }

    private sealed class StderrTail
    {
        private readonly object gate = new();
        private readonly Queue<string> lines = new();
        private int chars;

        public async Task CollectAsync(StreamReader reader)
        {
            while (await reader.ReadLineAsync() is { } line)
            {
                lock (gate)
                {
                    lines.Enqueue(line);
                    chars += line.Length;
                    while (chars > 8192 && lines.Count > 0) chars -= lines.Dequeue().Length;
                }
            }
        }

        public string GetText()
        {
            lock (gate) return string.Join(" | ", lines);
        }
    }
}

/// <summary>Display orientation via EnumDisplaySettings; Desktop Duplication does not rotate captured frames.</summary>
internal static class DisplayInfo
{
    private const int CurrentSettings = -1;

    public static bool PrimaryIsRotated()
    {
        try
        {
            var mode = new DEVMODE { dmSize = (short)Marshal.SizeOf<DEVMODE>() };
            // DMDO_DEFAULT = 0; 90/180/270 are 1/2/3. Unknown → treat as rotated so GDI capture is used.
            return !EnumDisplaySettings(null, CurrentSettings, ref mode) || mode.dmDisplayOrientation != 0;
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException) { return true; }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public int dmFields;
        public int dmPositionX, dmPositionY;
        public int dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplaySettings(string? deviceName, int modeNum, ref DEVMODE devMode);
}

internal sealed class InputController
{
    private const uint InputMouse = 0;
    private const uint InputKeyboard = 1;
    private const uint MouseMove = 0x0001;
    private const uint MouseLeftDown = 0x0002;
    private const uint MouseLeftUp = 0x0004;
    private const uint MouseRightDown = 0x0008;
    private const uint MouseRightUp = 0x0010;
    private const uint MouseWheel = 0x0800;
    private const uint MouseAbsolute = 0x8000;
    private const uint MouseVirtualDesk = 0x4000;
    private const uint KeyUp = 0x0002;
    private const uint KeyUnicode = 0x0004;

    private readonly Rectangle screen;
    private readonly HashSet<string> heldButtons = new(StringComparer.Ordinal);
    private readonly HashSet<string> heldKeys = new(StringComparer.Ordinal);
    private int mouseX;
    private int mouseY;

    public InputController(Rectangle screen)
    {
        this.screen = screen;
        mouseX = screen.Left;
        mouseY = screen.Top;
    }

    public void Handle(JsonElement eventJson)
    {
        if (eventJson.ValueKind != JsonValueKind.Object || !TryString(eventJson, "type", out string type)) return;
        switch (type)
        {
            case "move":
                if (TryFiniteNumber(eventJson, "x", out double x) && TryFiniteNumber(eventJson, "y", out double y))
                {
                    mouseX = screen.Left + (int)Math.Round(Math.Clamp(x, 0, 1) * Math.Max(0, screen.Width - 1));
                    mouseY = screen.Top + (int)Math.Round(Math.Clamp(y, 0, 1) * Math.Max(0, screen.Height - 1));
                    SendMouse(MouseMove, 0);
                }
                break;
            case "button":
                if (TryString(eventJson, "button", out string button) &&
                    (button == "left" || button == "right") && TryBool(eventJson, "down", out bool down))
                {
                    SendMouse(MouseMove, 0);
                    uint flag = button == "left"
                        ? (down ? MouseLeftDown : MouseLeftUp)
                        : (down ? MouseRightDown : MouseRightUp);
                    SendMouse(flag, 0);
                    if (down) heldButtons.Add(button); else heldButtons.Remove(button);
                }
                break;
            case "wheel":
                if (TryFiniteNumber(eventJson, "dy", out double dy))
                    SendMouse(MouseWheel, unchecked((uint)(int)Math.Clamp(Math.Truncate(-dy), -12000, 12000)));
                break;
            case "key":
                if (TryString(eventJson, "code", out string code) && TryBool(eventJson, "down", out bool keyDown) && KeyCodes.TryGetValue(code, out ushort virtualKey))
                {
                    SendKey(virtualKey, keyDown, IsExtendedKey(code));
                    if (keyDown) heldKeys.Add(code); else heldKeys.Remove(code);
                }
                break;
            case "text":
                if (TryString(eventJson, "text", out string text) && IsAtMost32CodePoints(text))
                    SendText(text);
                break;
        }
    }

    public void ReleaseHeldInputs()
    {
        foreach (string code in heldKeys.ToArray())
        {
            try { SendKey(KeyCodes[code], false, IsExtendedKey(code)); }
            catch { /* Best effort cleanup if the desktop session is already unavailable. */ }
        }
        heldKeys.Clear();
        foreach (string button in heldButtons.ToArray())
        {
            try { SendMouse(button == "left" ? MouseLeftUp : MouseRightUp, 0); }
            catch { /* Best effort cleanup if the desktop session is already unavailable. */ }
        }
        heldButtons.Clear();
    }

    private void SendMouse(uint flags, uint data)
    {
        int width = Math.Max(1, screen.Width - 1);
        int height = Math.Max(1, screen.Height - 1);
        int absoluteX = (int)Math.Round((double)(mouseX - screen.Left) * 65535 / width);
        int absoluteY = (int)Math.Round((double)(mouseY - screen.Top) * 65535 / height);
        var input = new INPUT
        {
            type = InputMouse,
            U = new InputUnion
            {
                mi = new MOUSEINPUT
                {
                    dx = absoluteX,
                    dy = absoluteY,
                    mouseData = data,
                    dwFlags = flags | MouseAbsolute | MouseVirtualDesk,
                    time = 0,
                    dwExtraInfo = UIntPtr.Zero
                }
            }
        };
        Send([input]);
    }

    private const uint KeyExtended = 0x0001;
    private static bool IsExtendedKey(string code) => code is "ControlRight" or "AltRight" or "MetaLeft" or "MetaRight" or "NumpadEnter" or "NumpadDivide" or "Insert" or "Delete" or "Home" or "End" or "PageUp" or "PageDown" or "ArrowLeft" or "ArrowRight" or "ArrowUp" or "ArrowDown" or "PrintScreen";

    private static void SendKey(ushort virtualKey, bool down, bool extended)
    {
        var input = new INPUT
        {
            type = InputKeyboard,
            U = new InputUnion
            {
                ki = new KEYBDINPUT
                {
                    wVk = virtualKey,
                    wScan = 0,
                    dwFlags = (down ? 0u : KeyUp) | (extended ? KeyExtended : 0u),
                    time = 0,
                    dwExtraInfo = UIntPtr.Zero
                }
            }
        };
        Send([input]);
    }

    private static void SendText(string text)
    {
        var inputs = new List<INPUT>();
        foreach (Rune rune in text.EnumerateRunes())
        {
            foreach (char unit in rune.ToString())
            {
                inputs.Add(UnicodeInput(unit, false));
                inputs.Add(UnicodeInput(unit, true));
            }
        }
        if (inputs.Count > 0) Send(inputs.ToArray());
    }

    private static INPUT UnicodeInput(char unit, bool up) => new()
    {
        type = InputKeyboard,
        U = new InputUnion
        {
            ki = new KEYBDINPUT
            {
                wVk = 0,
                wScan = unit,
                dwFlags = KeyUnicode | (up ? KeyUp : 0),
                time = 0,
                dwExtraInfo = UIntPtr.Zero
            }
        }
    };

    private static void Send(INPUT[] inputs)
    {
        uint inserted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        if (inserted != inputs.Length)
            throw new InvalidOperationException($"SendInput accepted {inserted} of {inputs.Length} input event(s).");
    }

    private static bool TryString(JsonElement obj, string property, out string value)
    {
        value = string.Empty;
        if (!obj.TryGetProperty(property, out JsonElement element) || element.ValueKind != JsonValueKind.String) return false;
        value = element.GetString() ?? string.Empty;
        return true;
    }

    private static bool TryBool(JsonElement obj, string property, out bool value)
    {
        value = false;
        if (!obj.TryGetProperty(property, out JsonElement element) ||
            (element.ValueKind != JsonValueKind.True && element.ValueKind != JsonValueKind.False)) return false;
        value = element.GetBoolean();
        return true;
    }

    private static bool TryFiniteNumber(JsonElement obj, string property, out double value)
    {
        value = 0;
        return obj.TryGetProperty(property, out JsonElement element) && element.ValueKind == JsonValueKind.Number &&
               element.TryGetDouble(out value) && double.IsFinite(value);
    }

    private static bool IsAtMost32CodePoints(string text)
    {
        int count = 0;
        foreach (Rune _ in text.EnumerateRunes())
            if (++count > 32) return false;
        return true;
    }


    private static readonly Dictionary<string, ushort> KeyCodes = BuildKeyCodes();

    private static Dictionary<string, ushort> BuildKeyCodes()
    {
        var keys = new Dictionary<string, ushort>(StringComparer.Ordinal);
        for (char key = 'A'; key <= 'Z'; key++) keys[$"Key{key}"] = key;
        for (char digit = '0'; digit <= '9'; digit++) keys[$"Digit{digit}"] = digit;
        for (int i = 1; i <= 24; i++) keys[$"F{i}"] = (ushort)(0x70 + i - 1);
        keys["Enter"] = 0x0D; keys["NumpadEnter"] = 0x0D; keys["Escape"] = 0x1B;
        keys["Backspace"] = 0x08; keys["Tab"] = 0x09; keys["Space"] = 0x20;
        keys["CapsLock"] = 0x14; keys["ShiftLeft"] = 0xA0; keys["ShiftRight"] = 0xA1;
        keys["ControlLeft"] = 0xA2; keys["ControlRight"] = 0xA3; keys["AltLeft"] = 0xA4; keys["AltRight"] = 0xA5;
        keys["MetaLeft"] = 0x5B; keys["MetaRight"] = 0x5C; keys["ContextMenu"] = 0x5D;
        keys["ArrowLeft"] = 0x25; keys["ArrowUp"] = 0x26; keys["ArrowRight"] = 0x27; keys["ArrowDown"] = 0x28;
        keys["Home"] = 0x24; keys["End"] = 0x23; keys["PageUp"] = 0x21; keys["PageDown"] = 0x22;
        keys["Insert"] = 0x2D; keys["Delete"] = 0x2E; keys["PrintScreen"] = 0x2C; keys["ScrollLock"] = 0x91; keys["NumLock"] = 0x90; keys["Pause"] = 0x13;
        keys["Numpad0"] = 0x60; keys["Numpad1"] = 0x61; keys["Numpad2"] = 0x62; keys["Numpad3"] = 0x63;
        keys["Numpad4"] = 0x64; keys["Numpad5"] = 0x65; keys["Numpad6"] = 0x66; keys["Numpad7"] = 0x67;
        keys["Numpad8"] = 0x68; keys["Numpad9"] = 0x69; keys["NumpadMultiply"] = 0x6A;
        keys["NumpadAdd"] = 0x6B; keys["NumpadSubtract"] = 0x6D; keys["NumpadDecimal"] = 0x6E; keys["NumpadDivide"] = 0x6F;
        keys["Minus"] = 0xBD; keys["Equal"] = 0xBB; keys["BracketLeft"] = 0xDB; keys["BracketRight"] = 0xDD;
        keys["Backslash"] = 0xDC; keys["Semicolon"] = 0xBA; keys["Quote"] = 0xDE; keys["Backquote"] = 0xC0;
        keys["Comma"] = 0xBC; keys["Period"] = 0xBE; keys["Slash"] = 0xBF; keys["IntlBackslash"] = 0xE2;
        return keys;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk, wScan;
        public uint dwFlags, time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint cInputs, [In] INPUT[] pInputs, int cbSize);
}
