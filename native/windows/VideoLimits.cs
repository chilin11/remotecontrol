namespace RemoteControl.Windows;

internal static class VideoLimits
{
    // H.264 Annex A, Level 5.0. Keep avc1.42E032 truthful for both playback paths.
    private const long MaxFrameMacroblocks = 22080;
    private const long MaxMacroblocksPerSecond = 589824;
    private static readonly int MaxDimensionMacroblocks = (int)Math.Floor(Math.Sqrt(MaxFrameMacroblocks * 8));

    public static (int Width, int Height, int Fps) H264Level5(int width, int height, int fps)
    {
        if (width < 2 || height < 2 || fps < 1)
            throw new ArgumentOutOfRangeException(nameof(width), "Video dimensions and frame rate must be positive.");

        int sourceWidth = width;
        int sourceHeight = height;
        width &= ~1;
        height &= ~1;
        double scale = Math.Min(1, Math.Min(
            (double)(MaxDimensionMacroblocks * 16) / width,
            (double)(MaxDimensionMacroblocks * 16) / height));
        scale = Math.Min(scale, Math.Sqrt((double)MaxFrameMacroblocks / Macroblocks(width, height)));
        width = Math.Max(2, (int)Math.Floor(width * scale) & ~1);
        height = Math.Max(2, (int)Math.Floor(height * scale) & ~1);
        // Ceiling to macroblocks can keep a scaled frame just over MaxFS.
        while (Macroblocks(width, height) > MaxFrameMacroblocks)
        {
            if (width >= height)
            {
                width -= 2;
                height = Math.Max(2, (int)((long)sourceHeight * width / sourceWidth) & ~1);
            }
            else
            {
                height -= 2;
                width = Math.Max(2, (int)((long)sourceWidth * height / sourceHeight) & ~1);
            }
        }
        int maxFps = (int)(MaxMacroblocksPerSecond / Macroblocks(width, height));
        // Prefer a conventional 30 fps fallback when a requested 60 fps does not fit.
        if (fps > maxFps) fps = Math.Min(maxFps, 30);
        return (width, height, fps);
    }

    private static long Macroblocks(int width, int height) => ((width + 15L) / 16) * ((height + 15L) / 16);
}
