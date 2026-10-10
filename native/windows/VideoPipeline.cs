using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Text.Json;

namespace RemoteControl.Windows;

internal sealed record QualityPreset(string Codec, string Name, int MaxWidth, int MaxHeight, int Fps, int Bitrate)
{
    public bool IsHevc => Codec == "hevc";

    /// <summary>Codec level (H.264 level_idc 50–52, HEVC general_level_idc 150–156); 0 = level 5.0.</summary>
    public int Level { get; init; }

    public int EffectiveLevel => Level != 0 ? Level : IsHevc ? 150 : 50;

    /// <summary>
    /// VBV peak: 2× the target, but never above the Main-tier MaxBR of the declared HEVC level (H.264 Level 5.x
    /// allows 135–240 Mbps, far above every preset). Keeps rate control and the signalled level consistent.
    /// </summary>
    public long PeakBitrate => IsHevc ? Math.Min(Bitrate * 2L, VideoLimits.HevcMaxBitrate(EffectiveLevel)) : Bitrate * 2L;

    public const string DefaultName = "1080p30";

    // Older browsers may still send the previous preset names.
    private static readonly Dictionary<string, string> LegacyNames = new(StringComparer.Ordinal)
    {
        ["minimal"] = "720p30", ["low"] = "720p30", ["hotel"] = "720p30", ["data"] = "720p30",
        ["balanced24"] = "1080p24", ["balanced"] = "1080p30", ["high15"] = "2160p24", ["high"] = "2160p30"
    };

    public static QualityPreset Parse(string[] args)
    {
        // The gateway passes codec then quality, as it does for the macOS agent. HEVC is the default.
        string codec = "hevc";
        string name;
        if (args.Length > 1)
        {
            codec = ParseCodec(args[0]);
            name = args[1].Trim().ToLowerInvariant();
        }
        else if (args.Length == 1 && IsCodec(args[0]))
        {
            codec = ParseCodec(args[0]);
            name = DefaultName;
        }
        else name = args.Length == 0 ? DefaultName : args[0].Trim().ToLowerInvariant();
        if (LegacyNames.TryGetValue(name, out string? mapped)) name = mapped;

        // Resolution is a bounding box (never upscaled). Bitrates are GPU-encoder targets; software keeps CRF.
        return name switch
        {
            "720p30" => new(codec, name, 1280, 720, 30, 4_000_000),
            "1080p24" => new(codec, name, 1920, 1080, 24, 6_000_000),
            "1080p30" => new(codec, name, 1920, 1080, 30, 8_000_000),
            "1080p60" => new(codec, name, 1920, 1080, 60, 12_000_000),
            "2160p24" => new(codec, name, 3840, 2160, 24, 16_000_000),
            "2160p30" => new(codec, name, 3840, 2160, 30, 20_000_000),
            "2160p60" => new(codec, name, 3840, 2160, 60, 35_000_000),
            _ => throw new ArgumentException("Quality preset must be 720p30, 1080p24, 1080p30, 1080p60, 2160p24, 2160p30, or 2160p60.")
        };
    }

    /// <summary>Largest even size that fits the preset box and the screen, keeping the aspect ratio.</summary>
    public (int Width, int Height) Fit(int screenWidth, int screenHeight)
    {
        double scale = Math.Min(1.0, Math.Min((double)MaxWidth / screenWidth, (double)MaxHeight / screenHeight));
        return (Math.Max(2, (int)Math.Floor(screenWidth * scale) & ~1), Math.Max(2, (int)Math.Floor(screenHeight * scale) & ~1));
    }

    /// <summary>WebCodecs/MSE codec string matching the declared profile and level.</summary>
    public string CodecString => IsHevc
        ? $"hvc1.1.6.L{EffectiveLevel}.90"
        : $"avc1.42E0{EffectiveLevel:X2}";

    private static bool IsCodec(string value) => value.Trim().Equals("h264", StringComparison.OrdinalIgnoreCase) ||
                                                  value.Trim().Equals("hevc", StringComparison.OrdinalIgnoreCase);

    private static string ParseCodec(string value) => value.Trim().ToLowerInvariant() switch
    {
        "h264" => "h264",
        "hevc" => "hevc",
        _ => throw new ArgumentException("Codec must be h264 or hevc.")
    };
}

/// <summary>Video encoder family. Hardware backends use the GPU vendor's encoder in FFmpeg.</summary>
internal enum EncoderBackend { Software, Nvenc, Amf, Qsv }

internal static class FfmpegPipeline
{
    public static readonly EncoderBackend[] HardwareOrder = [EncoderBackend.Nvenc, EncoderBackend.Amf, EncoderBackend.Qsv];

    public static string Name(EncoderBackend backend) => backend switch
    {
        EncoderBackend.Nvenc => "nvenc",
        EncoderBackend.Amf => "amf",
        EncoderBackend.Qsv => "qsv",
        _ => "software"
    };

    public static EncoderBackend? ParseName(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "nvenc" or "nvidia" => EncoderBackend.Nvenc,
        "amf" or "amd" => EncoderBackend.Amf,
        "qsv" or "intel" => EncoderBackend.Qsv,
        "software" or "cpu" => EncoderBackend.Software,
        _ => null
    };

    /// <summary>
    /// Full FFmpeg command line. A single display with a GPU encoder captures with Desktop Duplication
    /// (ddagrab) and scales on the GPU; multi-display desktops keep gdigrab so the whole virtual screen
    /// still matches pointer mapping. <paramref name="drawMouse"/> is false when the browser draws the pointer locally.
    /// </summary>
    public static List<string> Arguments(EncoderBackend backend, QualityPreset preset, Rectangle screen, int width, int height, bool singleDisplay, bool drawMouse = true)
    {
        string fps = preset.Fps.ToString(CultureInfo.InvariantCulture);
        string mouse = drawMouse ? "1" : "0";
        var args = new List<string> { "-hide_banner", "-loglevel", "warning", "-nostats", "-nostdin" };
        if (backend != EncoderBackend.Software && singleDisplay)
        {
            // Frames stay in GPU memory: capture, BGRA->NV12 and scaling run on the D3D11 video processor.
            string filter = $"ddagrab=output_idx=0:framerate={fps}:draw_mouse={mouse},scale_d3d11=width={width}:height={height}:format=nv12";
            // QSV takes system-memory NV12 most reliably; one GPU download of NV12 is still far cheaper than GDI capture.
            if (backend == EncoderBackend.Qsv) filter += ",hwdownload,format=nv12";
            args.AddRange(["-filter_complex", filter]);
        }
        else
        {
            args.AddRange([
                "-f", "gdigrab", "-framerate", preset.Fps.ToString(CultureInfo.InvariantCulture), "-draw_mouse", mouse,
                "-video_size", $"{screen.Width}x{screen.Height}",
                "-offset_x", screen.Left.ToString(CultureInfo.InvariantCulture), "-offset_y", screen.Top.ToString(CultureInfo.InvariantCulture), "-i", "desktop",
                "-an", "-vf", $"scale={width}:{height}:flags=fast_bilinear" + (backend == EncoderBackend.Software ? "" : ",format=nv12")
            ]);
        }
        args.AddRange(EncoderArguments(backend, preset));
        args.AddRange(["-flush_packets", "1", "-f", preset.IsHevc ? "hevc" : "h264", "pipe:1"]);
        return args;
    }

    /// <summary>
    /// Encoder options. All paths: no B-frames, one IDR per second (GOP = fps), access unit delimiters.
    /// The agent re-inserts parameter sets on every keyframe, so encoders need not repeat them.
    /// Rate control is capped at the target bitrate with a ~100 ms VBV: a 1 s buffer lets motion emit a second's worth
    /// of extra data in a burst, which queues in the network (e.g. a Cloudflare tunnel) as up to a second of lag.
    /// </summary>
    public static List<string> EncoderArguments(EncoderBackend backend, QualityPreset preset)
    {
        string fps = preset.Fps.ToString(CultureInfo.InvariantCulture);
        string bitrate = preset.Bitrate.ToString(CultureInfo.InvariantCulture);
        string bufsize = (preset.Bitrate / 10).ToString(CultureInfo.InvariantCulture);
        string[] rate = ["-b:v", bitrate, "-maxrate", bitrate, "-bufsize", bufsize];
        bool hevc = preset.IsHevc;
        // NVENC/AMF/x264/x265 take "5.0"–"5.2"; QSV takes libvpl's numeric MFX levels (50–52 for both codecs).
        string level = VideoLimits.LevelName(preset.Codec, preset.EffectiveLevel);
        string qsvLevel = (hevc ? preset.EffectiveLevel / 3 : preset.EffectiveLevel).ToString(CultureInfo.InvariantCulture);
        switch (backend)
        {
            case EncoderBackend.Nvenc:
                return [
                    "-c:v", hevc ? "hevc_nvenc" : "h264_nvenc", "-preset", "p3", "-tune", "ull",
                    "-profile:v", hevc ? "main" : "baseline", "-level:v", level, .. (hevc ? new[] { "-tier", "main" } : []),
                    "-rc", "vbr", .. rate, "-g", fps, "-bf", "0", "-zerolatency", "1", "-delay", "0", "-aud", "1"
                ];
            case EncoderBackend.Amf:
                return [
                    "-c:v", hevc ? "hevc_amf" : "h264_amf", "-usage", "ultralowlatency", "-quality", "balanced",
                    "-profile:v", hevc ? "main" : "constrained_baseline", "-level:v", level, .. (hevc ? new[] { "-profile_tier", "main" } : []),
                    "-rc", "vbr_latency", .. rate, "-g", fps, "-bf", "0", "-aud", "1"
                ];
            case EncoderBackend.Qsv:
                return [
                    "-c:v", hevc ? "hevc_qsv" : "h264_qsv", "-preset", "veryfast",
                    "-profile:v", hevc ? "main" : "baseline", "-level:v", qsvLevel, .. (hevc ? new[] { "-tier", "main" } : []),
                    .. rate, "-g", fps, "-bf", "0", "-async_depth", "1", "-aud", "1"
                ];
            default:
                // CRF controls visual quality/bitrate; 4K uses the fastest preset so CPU encoding can keep up.
                string hevcPreset = preset.MaxHeight switch { <= 720 => "ultrafast", <= 1080 => "superfast", _ => "ultrafast" };
                string hevcCrf = preset.MaxHeight switch { <= 720 => "27", <= 1080 => "25", _ => "24" };
                return hevc
                    ? [
                        "-c:v", "libx265", "-preset", hevcPreset, "-tune", "zerolatency", "-crf", hevcCrf,
                        "-profile:v", "main", "-level:v", level, "-pix_fmt", "yuv420p",
                        "-x265-params", $"aud=1:repeat-headers=1:keyint={fps}:min-keyint={fps}:scenecut=0:bframes=0:open-gop=0:level-idc={level}:high-tier=0"
                    ]
                    : [
                        "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                        "-profile:v", "baseline", "-level:v", level, "-pix_fmt", "yuv420p",
                        "-x264-params", $"aud=1:repeat-headers=1:keyint={fps}:min-keyint={fps}:scenecut=0"
                    ];
        }
    }

    /// <summary>Short synthetic encode that proves the GPU driver and encoder actually work.</summary>
    public static List<string> ProbeArguments(EncoderBackend backend, string codec)
    {
        var preset = new QualityPreset(codec, "720p30", 1280, 720, 30, 4_000_000);
        return [
            "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30", "-frames:v", "5", "-vf", "format=nv12",
            .. EncoderArguments(backend, preset), "-f", "null", "-"
        ];
    }
}

/// <summary>Chooses NVIDIA, AMD or Intel GPU encoding when available; otherwise software.</summary>
internal static class EncoderSelector
{
    private const string OverrideVariable = "REMOTECONTROL_VIDEO_ENCODER";
    // A healthy GPU probe finishes in well under a second. The total budget keeps probing plus software
    // fallback inside the gateway's 15 s and the browser's 12 s first-frame deadlines.
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan TotalProbeBudget = TimeSpan.FromSeconds(5);

    public static EncoderBackend Select(string ffmpeg, string codec, CancellationToken cancellationToken = default)
    {
        string? requested = Environment.GetEnvironmentVariable(OverrideVariable);
        if (!string.IsNullOrWhiteSpace(requested) && !requested.Trim().Equals("auto", StringComparison.OrdinalIgnoreCase))
        {
            if (FfmpegPipeline.ParseName(requested) is { } forced) return forced;
            Console.Error.WriteLine($"Ignoring unknown {OverrideVariable}={requested}; expected auto, nvenc, amf, qsv or software.");
        }

        string key = FfmpegKey(ffmpeg);
        var cache = LoadCache();
        if (cache.TryGetValue(key + "|" + codec, out string? cached) && FfmpegPipeline.ParseName(cached) is { } known)
            return known;

        EncoderBackend chosen = EncoderBackend.Software;
        bool complete = true;
        var budget = Stopwatch.StartNew();
        foreach (EncoderBackend backend in FfmpegPipeline.HardwareOrder)
        {
            cancellationToken.ThrowIfCancellationRequested();
            TimeSpan remaining = TotalProbeBudget - budget.Elapsed;
            if (remaining <= TimeSpan.Zero) { complete = false; break; }
            ProbeResult result = Probe(ffmpeg, backend, codec, remaining < ProbeTimeout ? remaining : ProbeTimeout, cancellationToken);
            if (result == ProbeResult.Works) { chosen = backend; break; }
            if (result == ProbeResult.TimedOut) complete = false;
        }
        cancellationToken.ThrowIfCancellationRequested();
        // Only cache a definitive answer; a slow/timed-out probe is retried on the next connection.
        if (chosen != EncoderBackend.Software || complete)
        {
            cache[key + "|" + codec] = FfmpegPipeline.Name(chosen);
            SaveCache(cache);
        }
        return chosen;
    }

    /// <summary>Re-probe on the next connection after a GPU pipeline failed (driver update, GPU switch).</summary>
    public static void Forget(string ffmpeg, string codec)
    {
        var cache = LoadCache();
        if (cache.Remove(FfmpegKey(ffmpeg) + "|" + codec)) SaveCache(cache);
    }

    private enum ProbeResult { Works, Fails, TimedOut }

    private static ProbeResult Probe(string ffmpeg, EncoderBackend backend, string codec, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var info = new ProcessStartInfo
        {
            FileName = ffmpeg,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (string argument in FfmpegPipeline.ProbeArguments(backend, codec)) info.ArgumentList.Add(argument);
        try
        {
            using var process = Process.Start(info);
            if (process is null) return ProbeResult.Fails;
            Task<string> stderr = process.StandardError.ReadToEndAsync();
            Task<string> stdout = process.StandardOutput.ReadToEndAsync();
            // Kill the probe as soon as the viewer disconnects, so no FFmpeg process outlives the agent.
            using var registration = cancellationToken.Register(() =>
            {
                try { process.Kill(entireProcessTree: true); } catch { /* already exited */ }
            });
            if (!process.WaitForExit(timeout))
            {
                try { process.Kill(entireProcessTree: true); } catch { /* already exiting */ }
                process.WaitForExit(1000);
                return ProbeResult.TimedOut;
            }
            Task.WaitAll([stderr, stdout], TimeSpan.FromSeconds(1));
            cancellationToken.ThrowIfCancellationRequested();
            return process.ExitCode == 0 ? ProbeResult.Works : ProbeResult.Fails;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            return ProbeResult.Fails;
        }
    }

    private static string FfmpegKey(string ffmpeg)
    {
        try
        {
            var file = new FileInfo(ffmpeg);
            if (file.Exists) return $"{file.FullName}|{file.Length}|{file.LastWriteTimeUtc.Ticks}";
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or NotSupportedException) { }
        return ffmpeg;
    }

    private static string CachePath
    {
        get
        {
            string? dataDir = Environment.GetEnvironmentVariable("REMOTECONTROL_DATA_DIR");
            if (string.IsNullOrWhiteSpace(dataDir))
                dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RemoteControl");
            return Path.Combine(dataDir, "video-encoder.json");
        }
    }

    private static Dictionary<string, string> LoadCache()
    {
        try
        {
            if (File.Exists(CachePath))
                return JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(CachePath)) ?? new();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
        return new();
    }

    private static void SaveCache(Dictionary<string, string> cache)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(CachePath)!);
            File.WriteAllText(CachePath, JsonSerializer.Serialize(cache));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* cache is optional */ }
    }
}
