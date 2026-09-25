using System.Buffers.Binary;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using System.Globalization;

namespace RemoteControl.Windows;

internal sealed record QualityPreset(string Codec, string Name, int MaxWidth, int Fps)
{
    public bool IsHevc => Codec == "hevc";

    public static QualityPreset Parse(string[] args)
    {
        // The gateway passes codec then quality, as it does for the macOS agent.
        string codec = "h264";
        string name;
        if (args.Length > 1)
        {
            codec = ParseCodec(args[0]);
            name = args[1].Trim().ToLowerInvariant();
        }
        else if (args.Length == 1 && IsCodec(args[0]))
        {
            codec = ParseCodec(args[0]);
            name = "balanced";
        }
        else name = args.Length == 0 ? "balanced" : args[0].Trim().ToLowerInvariant();

        return name switch
        {
            "minimal" or "low" or "hotel" or "data" => new(codec, "data", 1280, 24),
            "balanced24" => new(codec, name, 1920, 24),
            "balanced" => new(codec, name, 1920, 30),
            "high15" => new(codec, name, 2560, 15),
            "high" => new(codec, name, 2560, 60),
            _ => throw new ArgumentException("Quality preset must be data, balanced24, balanced, high15, or high.")
        };
    }

    private static bool IsCodec(string value) => value.Trim().Equals("h264", StringComparison.OrdinalIgnoreCase) ||
                                                  value.Trim().Equals("hevc", StringComparison.OrdinalIgnoreCase);

    private static string ParseCodec(string value) => value.Trim().ToLowerInvariant() switch
    {
        "h264" => "h264",
        "hevc" => "hevc",
        _ => throw new ArgumentException("Codec must be h264 or hevc.")
    };
}

internal static class Program
{
    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        try
        {
            var preset = QualityPreset.Parse(args);
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            var screen = SystemInformation.VirtualScreen;
            if (screen.Width < 2 || screen.Height < 2)
                throw new InvalidOperationException("Windows did not report a usable virtual screen.");

            int width = Math.Min(screen.Width, preset.MaxWidth) & ~1;
            int height = Math.Max(2, (int)Math.Floor((double)screen.Height * width / screen.Width)) & ~1;
            width = Math.Max(2, width);
            height = Math.Max(2, height);
            var writer = new PacketWriter();
            return await Agent.RunAsync(writer, preset, screen, width, height);
        }
        catch (Exception ex)
        {
            try { PacketWriter.WriteError(ex.Message); }
            catch { /* stdout may already be closed */ }
            return 1;
        }
    }
}

internal sealed class PacketWriter
{
    private const int MaxPacketBytes = 16 * 1024 * 1024;
    private static readonly Stream Output = Console.OpenStandardOutput();
    private static readonly object Gate = new();

    public static void WriteError(string message) => new PacketWriter().WriteJson(3, new { type = "error", message });

    public void WriteJson<T>(byte type, T value)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(value);
        Write(type, payload);
    }

    public static void Write(byte type, ReadOnlySpan<byte> payload)
    {
        if (payload.Length > MaxPacketBytes)
            throw new InvalidDataException("Packet exceeds the 16 MiB protocol limit.");
        Span<byte> header = stackalloc byte[5];
        header[0] = type;
        BinaryPrimitives.WriteUInt32BigEndian(header[1..], checked((uint)payload.Length));
        lock (Gate)
        {
            Output.Write(header);
            Output.Write(payload);
            Output.Flush();
        }
    }
}

internal static class Agent
{
    private const int MaxInputLineChars = 16 * 1024;

    public static async Task<int> RunAsync(PacketWriter writer, QualityPreset preset, Rectangle screen, int width, int height)
    {
        string ffmpeg = Environment.GetEnvironmentVariable("REMOTECONTROL_FFMPEG_PATH") ?? "ffmpeg.exe";
        if (string.IsNullOrWhiteSpace(ffmpeg))
            throw new InvalidOperationException("REMOTECONTROL_FFMPEG_PATH is empty.");
        if ((ffmpeg.Contains(Path.DirectorySeparatorChar) || ffmpeg.Contains(Path.AltDirectorySeparatorChar)) && !File.Exists(ffmpeg))
            throw new FileNotFoundException("The configured FFmpeg executable was not found.", ffmpeg);

        using var process = new Process { StartInfo = BuildStartInfo(ffmpeg, preset, screen, width, height), EnableRaisingEvents = true };
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
        var parser = new AnnexBAccessUnitParser(preset.Codec);
        var input = new InputController(screen);
        var inputGate = new object();
        using var inputCancellation = new CancellationTokenSource();
        Task? captureTask = null;
        Task? inputTask = null;
        bool inputReachedEof = false;
        try
        {
            writer.WriteJson(1, new
            {
                type = "stream",
                codec = preset.Codec,
                codecString = preset.IsHevc ? "hvc1.1.6.L150.90" : "avc1.42E032",
                width,
                height,
                fps = preset.Fps
            });
            captureTask = PumpCaptureAsync(process.StandardOutput.BaseStream, parser);
            // Windows redirected console reads may block synchronously and ignore cancellation.
            // Keep them off the coordinator thread; never await an idle read during shutdown.
            CancellationToken inputToken = inputCancellation.Token;
            inputTask = Task.Run(() => ReadInput(inputToken, input, inputGate));
            Task first = await Task.WhenAny(captureTask, inputTask);
            if (first == inputTask)
            {
                await inputTask;
                inputReachedEof = true;
                inputCancellation.Cancel();
                lock (inputGate) input.ReleaseHeldInputs();
                StopProcess(process);
                try { await captureTask; }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
            }
            else
            {
                await captureTask;
                StopProcess(process);
            }
            await process.WaitForExitAsync();
            await stderrTask;
            if (!inputReachedEof)
            {
                string detail = stderr.GetText();
                string message = $"FFmpeg stopped with code {process.ExitCode}" + (detail.Length == 0 ? "." : $": {detail}");
                if (preset.IsHevc && IsMissingLibx265(detail))
                    message = $"This FFmpeg build does not include the libx265 HEVC encoder. Install an FFmpeg build with libx265 enabled or select h264. {message}";
                PacketWriter.WriteError(message);
                return 1;
            }
            return 0;
        }
        finally
        {
            inputCancellation.Cancel();
            StopProcess(process);
            // Release immediately even if the Windows stdin pipe is still blocked.
            lock (inputGate) input.ReleaseHeldInputs();
        }
    }

    private static ProcessStartInfo BuildStartInfo(string ffmpeg, QualityPreset preset, Rectangle screen, int width, int height)
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
        string[] commonArguments =
        [
            "-hide_banner", "-loglevel", "warning", "-nostats", "-nostdin",
            "-f", "gdigrab", "-framerate", preset.Fps.ToString(CultureInfo.InvariantCulture), "-draw_mouse", "1",
            "-video_size", $"{screen.Width}x{screen.Height}",
            "-offset_x", screen.Left.ToString(CultureInfo.InvariantCulture), "-offset_y", screen.Top.ToString(CultureInfo.InvariantCulture), "-i", "desktop",
            "-an", "-vf", $"scale={width}:{height}:flags=fast_bilinear"
        ];
        // CRF controls visual quality/bitrate; slower presets trade CPU and latency for compression.
        string hevcPreset = preset.Name switch { "data" => "ultrafast", "high" or "high15" => "veryfast", _ => "superfast" };
        string hevcCrf = preset.Name switch { "data" => "27", "high" or "high15" => "22", _ => "25" };
        string[] encoderArguments = preset.IsHevc
            ?
            [
                "-c:v", "libx265", "-preset", hevcPreset, "-tune", "zerolatency", "-crf", hevcCrf,
                "-profile:v", "main", "-level:v", "5.0", "-pix_fmt", "yuv420p",
                "-x265-params", $"aud=1:repeat-headers=1:keyint={preset.Fps}:min-keyint={preset.Fps}:scenecut=0:bframes=0:open-gop=0:level-idc=5.0:high-tier=0",
                "-flush_packets", "1", "-f", "hevc", "pipe:1"
            ]
            :
            [
                "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                "-profile:v", "baseline", "-level:v", "5.0", "-pix_fmt", "yuv420p",
                "-x264-params", $"aud=1:repeat-headers=1:keyint={preset.Fps}:min-keyint={preset.Fps}:scenecut=0",
                "-flush_packets", "1", "-f", "h264", "pipe:1"
            ];
        foreach (string argument in commonArguments) info.ArgumentList.Add(argument);
        foreach (string argument in encoderArguments) info.ArgumentList.Add(argument);
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

/// <summary>Splits continuous Annex-B H.264/HEVC output at AUD NALs.</summary>
internal sealed class AnnexBAccessUnitParser
{
    private const int MaxNalOrAccessUnitBytes = 16 * 1024 * 1024;
    private readonly string codec;
    private readonly bool isHevc;
    private readonly List<byte> pending = new();
    private readonly MemoryStream accessUnit = new();
    private bool accessUnitHasKeyframe;
    private bool accessUnitHasVcl;
    private byte[]? hevcVps;
    private byte[]? hevcSps;
    private byte[]? hevcPps;

    public AnnexBAccessUnitParser(string codec)
    {
        this.codec = codec;
        isHevc = codec == "hevc";
    }

    public void Push(ReadOnlySpan<byte> chunk)
    {
        foreach (byte value in chunk) pending.Add(value);
        ParseCompleteNals();
        if (pending.Count > MaxNalOrAccessUnitBytes)
            throw new InvalidDataException($"FFmpeg emitted an oversized or unframed {codec} NAL unit.");
    }

    public void Finish()
    {
        ParseCompleteNals();
        int start = FindStartCode(pending, 0, out _);
        if (start >= 0)
        {
            if (start > 0) pending.RemoveRange(0, start);
            ProcessNal(pending.ToArray());
        }
        pending.Clear();
        EmitAccessUnit();
    }

    private void ParseCompleteNals()
    {
        while (true)
        {
            int start = FindStartCode(pending, 0, out _);
            if (start < 0)
            {
                int keep = Math.Min(3, pending.Count);
                if (pending.Count > keep) pending.RemoveRange(0, pending.Count - keep);
                return;
            }
            if (start > 0) pending.RemoveRange(0, start);
            int firstLength;
            _ = FindStartCode(pending, 0, out firstLength);
            int next = FindStartCode(pending, firstLength, out _);
            if (next < 0) return;
            ProcessNal(pending.GetRange(0, next).ToArray());
            pending.RemoveRange(0, next);
        }
    }

    private void ProcessNal(byte[] nal)
    {
        _ = FindStartCode(nal, 0, out int prefixLength);
        if (prefixLength == 0 || nal.Length <= prefixLength) return;
        byte nalType = isHevc
            ? (byte)((nal[prefixLength] >> 1) & 0x3f)
            : (byte)(nal[prefixLength] & 0x1f);
        if (isHevc && nalType is >= 32 and <= 34)
        {
            // Keep parameter sets out of a preceding frame if x265 emits them before AUD.
            if (nalType == 32) hevcVps = nal;
            else if (nalType == 33) hevcSps = nal;
            else hevcPps = nal;
            return;
        }
        bool isAud = isHevc ? nalType == 35 : nalType == 9;
        bool isVcl = isHevc ? nalType <= 31 : nalType == 1 || nalType == 5;
        bool isKeyframe = isHevc ? nalType is >= 16 and <= 23 : nalType == 5;
        if (isAud && accessUnitHasVcl) EmitAccessUnit();
        accessUnit.Write(nal);
        if (isVcl) accessUnitHasVcl = true;
        if (isKeyframe) accessUnitHasKeyframe = true;
        if (accessUnit.Length > MaxNalOrAccessUnitBytes)
            throw new InvalidDataException($"FFmpeg emitted an oversized {codec} access unit.");
    }

    private void EmitAccessUnit()
    {
        if (accessUnit.Length == 0) return;
        if (accessUnitHasKeyframe && isHevc && (hevcVps is null || hevcSps is null || hevcPps is null))
            throw new InvalidDataException("HEVC encoder key access unit is missing VPS/SPS/PPS parameter sets.");
        long totalNalBytes = accessUnit.Length + (accessUnitHasKeyframe && isHevc
            ? hevcVps!.Length + hevcSps!.Length + hevcPps!.Length
            : 0);
        if (totalNalBytes + 1 > MaxNalOrAccessUnitBytes)
            throw new InvalidDataException($"{codec} access unit exceeds the packet size limit.");
        byte[] payload = new byte[checked((int)totalNalBytes + 1)];
        payload[0] = accessUnitHasKeyframe ? (byte)1 : (byte)0;
        byte[] accessUnitBytes = accessUnit.ToArray();
        int parameterSetInsertOffset = 0;
        if (accessUnitHasKeyframe && isHevc)
        {
            int firstNalStart = FindStartCode(accessUnitBytes, 0, out int firstPrefixLength);
            if (firstNalStart == 0 && accessUnitBytes.Length > firstPrefixLength &&
                ((accessUnitBytes[firstPrefixLength] >> 1) & 0x3f) == 35)
            {
                int afterAud = FindStartCode(accessUnitBytes, firstPrefixLength, out _);
                parameterSetInsertOffset = afterAud < 0 ? accessUnitBytes.Length : afterAud;
            }
        }
        int destinationOffset = 1;
        Buffer.BlockCopy(accessUnitBytes, 0, payload, destinationOffset, parameterSetInsertOffset);
        destinationOffset += parameterSetInsertOffset;
        if (accessUnitHasKeyframe && isHevc)
        {
            Buffer.BlockCopy(hevcVps!, 0, payload, destinationOffset, hevcVps!.Length);
            destinationOffset += hevcVps!.Length;
            Buffer.BlockCopy(hevcSps!, 0, payload, destinationOffset, hevcSps!.Length);
            destinationOffset += hevcSps!.Length;
            Buffer.BlockCopy(hevcPps!, 0, payload, destinationOffset, hevcPps!.Length);
            destinationOffset += hevcPps!.Length;
        }
        Buffer.BlockCopy(accessUnitBytes, parameterSetInsertOffset, payload, destinationOffset,
            accessUnitBytes.Length - parameterSetInsertOffset);
        PacketWriter.Write(2, payload);
        accessUnit.SetLength(0);
        accessUnitHasKeyframe = false;
        accessUnitHasVcl = false;
    }

    private static int FindStartCode(IReadOnlyList<byte> bytes, int from, out int length)
    {
        for (int i = Math.Max(0, from); i + 2 < bytes.Count; i++)
        {
            if (bytes[i] != 0 || bytes[i + 1] != 0) continue;
            if (i + 3 < bytes.Count && bytes[i + 2] == 0 && bytes[i + 3] == 1)
            {
                length = 4;
                return i;
            }
            if (bytes[i + 2] == 1)
            {
                length = 3;
                return i;
            }
        }
        length = 0;
        return -1;
    }
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
