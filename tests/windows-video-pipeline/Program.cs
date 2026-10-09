using System.Drawing;
using RemoteControl.Windows;

// Usage: VideoPipeline.Tests split <annexb-file> <codec>
// Splits an Annex-B stream exactly like the agent; agent packets go to stdout for the Node test to inspect.
if (args.Length == 3 && args[0] == "split")
{
    int firstFrameCalls = 0;
    var parser = new AnnexBAccessUnitParser(args[2], () => firstFrameCalls++);
    byte[] data = File.ReadAllBytes(args[1]);
    var random = new Random(7);
    for (int offset = 0; offset < data.Length;)
    {
        // Mix tiny and large chunks so start codes straddle pipe reads.
        int count = Math.Min(data.Length - offset, random.Next(1, 3) == 1 ? random.Next(1, 8) : random.Next(1, 65536));
        parser.Push(data.AsSpan(offset, count));
        offset += count;
    }
    parser.Finish();
    if (firstFrameCalls != 1 || !parser.EmittedFrames) throw new Exception($"First-frame callback ran {firstFrameCalls} times.");
    return 0;
}

// Header-only output (AUD, parameter sets, SEI, no picture) must not count as a frame, so the agent can fall back.
foreach (string codec in new[] { "h264", "hevc" })
{
    int calls = 0;
    var headerOnly = new AnnexBAccessUnitParser(codec, () => calls++);
    byte[] stream = codec == "h264"
        ? [0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x32, 0, 0, 0, 1, 0x68, 0xce, 0, 0, 0, 1, 0x06, 0x05, 0x80, 0, 0, 0, 1, 0x09, 0xf0]
        : [0, 0, 0, 1, 0x46, 0x01, 0x50, 0, 0, 0, 1, 0x40, 0x01, 0x0c, 0, 0, 0, 1, 0x4e, 0x01, 0x05, 0x80, 0, 0, 0, 1, 0x46, 0x01, 0x50];
    headerOnly.Push(stream);
    headerOnly.Finish();
    if (calls != 0 || headerOnly.EmittedFrames) throw new Exception($"{codec}: header-only output was reported as a frame");
}

static void Expect(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

static string Value(List<string> arguments, string name)
{
    int index = arguments.IndexOf(name);
    Expect(index >= 0 && index + 1 < arguments.Count, $"Missing {name} in: {string.Join(' ', arguments)}");
    return arguments[index + 1];
}

var screen = new Rectangle(0, 0, 3840, 2160);
foreach (string codec in new[] { "h264", "hevc" })
{
    // 2160p60 needs level 5.2 (H.264) / 5.1 (HEVC); the agent sets Level from VideoLimits before building arguments.
    var preset = QualityPreset.Parse([codec, "2160p60"]);
    preset = preset with { Level = codec == "hevc" ? VideoLimits.HevcLevel(3840, 2160, 60) : VideoLimits.H264(3840, 2160, 60).Level };
    foreach (EncoderBackend backend in Enum.GetValues<EncoderBackend>())
    {
        foreach (bool dda in new[] { true, false })
        {
            var arguments = FfmpegPipeline.Arguments(backend, preset, screen, 3840, 2160, dda);
            string encoder = Value(arguments, "-c:v");
            string expectedEncoder = backend switch
            {
                EncoderBackend.Nvenc => codec == "hevc" ? "hevc_nvenc" : "h264_nvenc",
                EncoderBackend.Amf => codec == "hevc" ? "hevc_amf" : "h264_amf",
                EncoderBackend.Qsv => codec == "hevc" ? "hevc_qsv" : "h264_qsv",
                _ => codec == "hevc" ? "libx265" : "libx264"
            };
            Expect(encoder == expectedEncoder, $"{backend}/{codec}: encoder {encoder}");
            Expect(arguments[^1] == "pipe:1" && arguments[^2] == codec && arguments[^3] == "-f", $"{backend}/{codec}: raw Annex-B on stdout");
            bool usesDda = arguments.Contains("-filter_complex");
            Expect(usesDda == (dda && backend != EncoderBackend.Software), $"{backend}: Desktop Duplication only for GPU on a single display");
            if (usesDda)
            {
                string filter = Value(arguments, "-filter_complex");
                Expect(filter.StartsWith("ddagrab=output_idx=0:framerate=60:draw_mouse=1,scale_d3d11=width=3840:height=2160:format=nv12", StringComparison.Ordinal), filter);
                Expect(filter.Contains("hwdownload") == (backend == EncoderBackend.Qsv), $"{backend}: {filter}");
            }
            else
            {
                Expect(Value(arguments, "-f") == "gdigrab" && Value(arguments, "-framerate") == "60", $"{backend}: gdigrab fallback");
                string scale = Value(arguments, "-vf");
                Expect(scale.EndsWith(",format=nv12", StringComparison.Ordinal) == (backend != EncoderBackend.Software), $"{backend}: {scale}");
            }
            if (backend != EncoderBackend.Software)
            {
                // Low-latency invariants the browser depends on: GOP = fps, no B-frames, AUD, Main/Baseline at level 5.
                Expect(Value(arguments, "-g") == "60", $"{backend}: GOP");
                Expect(Value(arguments, "-bf") == "0", $"{backend}: B-frames");
                Expect(Value(arguments, "-aud") == "1", $"{backend}: AUD");
                Expect(Value(arguments, "-b:v") == "35000000", $"{backend}: bitrate");
                string profile = Value(arguments, "-profile:v");
                Expect(codec == "hevc" ? profile == "main" : profile is "baseline" or "constrained_baseline", $"{backend}: profile {profile}");
                string level = Value(arguments, "-level:v");
                Expect(level == (backend == EncoderBackend.Qsv ? (codec == "hevc" ? "51" : "52") : codec == "hevc" ? "5.1" : "5.2"), $"{backend}: level {level}");
            }
        }
    }
}
Expect(QualityPreset.Parse([]).Codec == "hevc", "HEVC is the default codec");
Expect(QualityPreset.Parse(["balanced"]).Codec == "hevc", "HEVC is the default codec with a quality-only argument");
Expect(QualityPreset.Parse(["h264", "data"]).Codec == "h264", "explicit H.264 is kept");
// Resolution choices: 720p only at 30 fps; 1080p and 2160p at 24/30/60. Old names still work.
foreach (string name in new[] { "720p30", "1080p24", "1080p30", "1080p60", "2160p24", "2160p30", "2160p60" })
    Expect(QualityPreset.Parse(["hevc", name]).Name == name, name);
foreach (string name in new[] { "720p24", "720p60", "1080p15", "2160p15", "custom" })
{
    try { QualityPreset.Parse(["hevc", name]); throw new Exception($"{name} should be rejected"); }
    catch (ArgumentException) { }
}
Expect(QualityPreset.Parse(["hevc", "high"]).Name == "2160p30" && QualityPreset.Parse(["hevc", "data"]).Name == "720p30", "legacy names");
Expect(QualityPreset.Parse([]).Name == "1080p30", "default preset");
// Fit within the box without upscaling, keep aspect ratio, even dimensions.
Expect(QualityPreset.Parse(["hevc", "1080p30"]).Fit(3840, 2160) == (1920, 1080), "4K desktop at 1080p");
Expect(QualityPreset.Parse(["hevc", "1080p30"]).Fit(2560, 1600) == (1728, 1080), "16:10 desktop is limited by height");
Expect(QualityPreset.Parse(["hevc", "2160p30"]).Fit(1920, 1080) == (1920, 1080), "never upscale");
Expect(QualityPreset.Parse(["hevc", "720p30"]).Fit(3440, 1440) == (1280, 534), "ultrawide is limited by width");
Expect((QualityPreset.Parse(["hevc", "1080p30"]) with { Level = 150 }).CodecString == "hvc1.1.6.L150.90", "HEVC codec string");
Expect((QualityPreset.Parse(["hevc", "2160p60"]) with { Level = 153 }).CodecString == "hvc1.1.6.L153.90", "HEVC 5.1 codec string");
Expect((QualityPreset.Parse(["h264", "2160p60"]) with { Level = 52 }).CodecString == "avc1.42E034", "H.264 5.2 codec string");
Expect(QualityPreset.Parse(["h264", "1080p30"]).CodecString == "avc1.42E032", "H.264 5.0 codec string");
// HEVC level covers the peak bitrate (Main-tier MaxBR 25/40/60 Mbps), and the peak never exceeds the level.
foreach (string name in new[] { "720p30", "1080p24", "1080p30", "1080p60", "2160p24", "2160p30", "2160p60" })
{
    var hevcPreset = QualityPreset.Parse(["hevc", name]);
    var (w, h) = hevcPreset.Fit(3840, 2160);
    hevcPreset = hevcPreset with { Level = VideoLimits.HevcLevel(w, h, hevcPreset.Fps, hevcPreset.Bitrate * 2L) };
    Expect(hevcPreset.PeakBitrate == Math.Min(hevcPreset.Bitrate * 2L, 60_000_000), $"{name}: peak is 2x target, capped at Level 5.2's 60 Mbps");
    Expect(hevcPreset.PeakBitrate <= VideoLimits.HevcMaxBitrate(hevcPreset.EffectiveLevel), $"{name}: peak exceeds level MaxBR");
    long[] limits = [25_000_000, 40_000_000, 60_000_000];
    Expect(hevcPreset.EffectiveLevel == 150 || hevcPreset.Bitrate * 2L > limits[(hevcPreset.EffectiveLevel - 150) / 3 - 1] || (long)w * h * hevcPreset.Fps > 267386880, $"{name}: level {hevcPreset.EffectiveLevel} higher than needed");
}
Expect(VideoLimits.HevcLevel(3840, 2160, 30, 40_000_000) == 153, "4K30 at 40 Mbps peak needs 5.1");
Expect(VideoLimits.HevcLevel(3840, 2160, 60, 70_000_000) == 156, "4K60 at 70 Mbps peak needs 5.2");
Expect((QualityPreset.Parse(["hevc", "2160p60"]) with { Level = 153 }).PeakBitrate == 40_000_000, "peak clamped to the declared level");
Expect(FfmpegPipeline.ParseName("NVIDIA") == EncoderBackend.Nvenc && FfmpegPipeline.ParseName("amd") == EncoderBackend.Amf &&
       FfmpegPipeline.ParseName("intel") == EncoderBackend.Qsv && FfmpegPipeline.ParseName("bogus") is null, "encoder names");
Expect(string.Join(',', FfmpegPipeline.HardwareOrder) == "Nvenc,Amf,Qsv", "GPU probe order");
foreach (EncoderBackend backend in FfmpegPipeline.HardwareOrder)
{
    var probe = FfmpegPipeline.ProbeArguments(backend, "hevc");
    Expect(probe.Contains("lavfi") && probe[^1] == "-" && Value(probe, "-frames:v") == "5", $"{backend}: probe");
}

Console.WriteLine("PASS: Windows GPU/CPU FFmpeg pipelines and HEVC default.");
return 0;
