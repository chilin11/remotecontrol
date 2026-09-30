using RemoteControl.Windows;

static void Check(int width, int height, int fps, int? expectedFps = null)
{
    var actual = VideoLimits.H264Level5(width, height, fps);
    long macroblocks = ((actual.Width + 15L) / 16) * ((actual.Height + 15L) / 16);
    if (actual.Width < 2 || actual.Height < 2 || actual.Width > width || actual.Height > height ||
        actual.Width % 2 != 0 || actual.Height % 2 != 0 || actual.Fps < 1 || actual.Fps > fps ||
        macroblocks > 22080 || macroblocks * actual.Fps > 589824 ||
        (actual.Width + 15) / 16 > 420 || (actual.Height + 15) / 16 > 420)
        throw new Exception($"Invalid Level 5.0 fallback: {width}x{height}@{fps} -> {actual}");
    if (expectedFps.HasValue && (actual.Width != width || actual.Height != height || actual.Fps != expectedFps))
        throw new Exception($"Unexpected fallback for {width}x{height}@{fps}: {actual}");
}

Check(2560, 1440, 60, 30);
Check(2560, 1440, 15, 15);
Check(1920, 1080, 30, 30);
Check(1920, 1080, 24, 24);
Check(1920, 1080, 60, 60);
Check(1280, 720, 24, 24);
Check(2560, 2160, 60); // portrait/tall desktops exceed MaxFS as well as MaxMBPS
Check(1280, 8000, 30);
Check(8000, 1280, 30);
Check(2, 100000, 60);
Check(100000, 2, 60);
Check(2559, 1439, 60);
for (int width = 2; width <= 8192; width += 127)
    for (int height = 2; height <= 8192; height += 131)
        foreach (int fps in new[] { 15, 24, 30, 60 }) Check(width, height, fps);
Console.WriteLine("PASS: H.264 Level 5.0 dimensions, macroblock rate and actual fallback FPS.");
