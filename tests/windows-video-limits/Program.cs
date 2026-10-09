using RemoteControl.Windows;

static void Check(int width, int height, int fps, int? expectedFps = null, int? expectedLevel = null)
{
    var actual = VideoLimits.H264(width, height, fps);
    long macroblocks = ((actual.Width + 15L) / 16) * ((actual.Height + 15L) / 16);
    (long maxFs, long maxMbps) = actual.Level switch { 50 => (22080L, 589824L), 51 => (36864L, 983040L), 52 => (36864L, 2073600L), _ => (0L, 0L) };
    long maxDimension = (long)Math.Floor(Math.Sqrt(maxFs * 8));
    if (actual.Width < 2 || actual.Height < 2 || actual.Width > width || actual.Height > height ||
        actual.Width % 2 != 0 || actual.Height % 2 != 0 || actual.Fps < 1 || actual.Fps > fps ||
        macroblocks > maxFs || macroblocks * actual.Fps > maxMbps ||
        (actual.Width + 15) / 16 > maxDimension || (actual.Height + 15) / 16 > maxDimension)
        throw new Exception($"Invalid H.264 level fallback: {width}x{height}@{fps} -> {actual}");
    if (expectedFps.HasValue && (actual.Width != (width & ~1) || actual.Height != (height & ~1) || actual.Fps != expectedFps))
        throw new Exception($"Unexpected fallback for {width}x{height}@{fps}: {actual}");
    if (expectedLevel.HasValue && actual.Level != expectedLevel)
        throw new Exception($"Unexpected level for {width}x{height}@{fps}: {actual}");
}

// The visible presets keep their size and frame rate; only the declared level rises.
Check(1280, 720, 30, 30, 50);
Check(1920, 1080, 24, 24, 50);
Check(1920, 1080, 30, 30, 50);
Check(1920, 1080, 60, 60, 50);
Check(2560, 1440, 60, 60, 51);
Check(3840, 2160, 24, 24, 51);
Check(3840, 2160, 30, 30, 51);
Check(3840, 2160, 60, 60, 52);
// Only desktops beyond Level 5.2's frame size are scaled; fps is capped to the macroblock rate.
Check(2560, 2160, 60);
Check(5120, 2880, 60);
Check(1280, 8000, 30);
Check(8000, 1280, 30);
Check(2, 100000, 60);
Check(100000, 2, 60);
Check(2559, 1439, 60);
for (int width = 2; width <= 8192; width += 127)
    for (int height = 2; height <= 8192; height += 131)
        foreach (int fps in new[] { 24, 30, 60 }) Check(width, height, fps);

static void Hevc(int width, int height, int fps, int expected)
{
    int level = VideoLimits.HevcLevel(width, height, fps);
    if (level != expected) throw new Exception($"HEVC {width}x{height}@{fps}: level {level}, expected {expected}");
}
Hevc(1920, 1080, 60, 150);
Hevc(3840, 2160, 30, 150);
Hevc(3840, 2160, 60, 153);
if (VideoLimits.LevelName("hevc", 153) != "5.1" || VideoLimits.LevelName("h264", 52) != "5.2" || VideoLimits.LevelName("h264", 50) != "5.0")
    throw new Exception("Level names");
Console.WriteLine("PASS: H.264 Level 5.0-5.2 dimensions, macroblock rate, actual fallback FPS and HEVC levels.");
