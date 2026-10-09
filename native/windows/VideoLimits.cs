namespace RemoteControl.Windows;

internal static class VideoLimits
{
    // H.264 Annex A Table A-1 (MaxFS in macroblocks, MaxMBPS). Baseline profile, levels 5.0–5.2.
    private static readonly (int Level, long MaxFrameMacroblocks, long MaxMacroblocksPerSecond)[] H264Levels =
    [
        (50, 22080, 589824),
        (51, 36864, 983040),
        (52, 36864, 2073600)
    ];

    // HEVC Annex A Table A.8 (MaxLumaPs, MaxLumaSr, Main-tier MaxBR in bit/s), levels 5.0–5.2.
    private static readonly (int Level, long MaxLumaPictureSize, long MaxLumaSampleRate, long MaxBitrate)[] HevcLevels =
    [
        (150, 8912896, 267386880, 25_000_000),
        (153, 8912896, 534773760, 40_000_000),
        (156, 8912896, 1069547520, 60_000_000)
    ];

    /// <summary>
    /// Picks the lowest H.264 level from 5.0 to 5.2 that fits the frame. If even 5.2 does not fit, scales the
    /// frame to the 5.2 frame-size limit and lowers the frame rate (preferring a conventional 30 fps).
    /// </summary>
    public static (int Width, int Height, int Fps, int Level) H264(int width, int height, int fps)
    {
        if (width < 2 || height < 2 || fps < 1)
            throw new ArgumentOutOfRangeException(nameof(width), "Video dimensions and frame rate must be positive.");
        width &= ~1;
        height &= ~1;
        foreach (var level in H264Levels)
        {
            long macroblocks = Macroblocks(width, height);
            if (macroblocks <= level.MaxFrameMacroblocks && FitsDimension(width, height, level.MaxFrameMacroblocks) &&
                macroblocks * fps <= level.MaxMacroblocksPerSecond)
                return (width, height, fps, level.Level);
        }
        var top = H264Levels[^1];
        (width, height) = ScaleToFrameLimit(width, height, top.MaxFrameMacroblocks);
        int maxFps = (int)(top.MaxMacroblocksPerSecond / Macroblocks(width, height));
        if (fps > maxFps) fps = Math.Min(maxFps, 30);
        return (width, height, Math.Max(1, fps), top.Level);
    }

    /// <summary>Lowest HEVC Main-tier level (general_level_idc: 150/153/156) for the frame, rate and peak bitrate.</summary>
    public static int HevcLevel(int width, int height, int fps, long peakBitrate = 0)
    {
        long samples = (long)width * height;
        foreach (var level in HevcLevels)
            if (samples <= level.MaxLumaPictureSize && samples * fps <= level.MaxLumaSampleRate && peakBitrate <= level.MaxBitrate)
                return level.Level;
        return HevcLevels[^1].Level;
    }

    /// <summary>Main-tier maximum bitrate for an HEVC level; encoders must not peak above it.</summary>
    public static long HevcMaxBitrate(int level)
    {
        foreach (var entry in HevcLevels)
            if (entry.Level == level) return entry.MaxBitrate;
        return HevcLevels[^1].MaxBitrate;
    }

    /// <summary>Dotted level name used by FFmpeg encoders ("5.0", "5.1", "5.2").</summary>
    public static string LevelName(string codec, int level)
    {
        int tenths = codec == "hevc" ? level / 3 : level;
        return $"{tenths / 10}.{tenths % 10}";
    }

    private static bool FitsDimension(int width, int height, long maxFrameMacroblocks)
    {
        long maxDimension = (long)Math.Floor(Math.Sqrt(maxFrameMacroblocks * 8));
        return (width + 15) / 16 <= maxDimension && (height + 15) / 16 <= maxDimension;
    }

    private static (int Width, int Height) ScaleToFrameLimit(int width, int height, long maxFrameMacroblocks)
    {
        int sourceWidth = width;
        int sourceHeight = height;
        int maxDimensionPixels = (int)Math.Floor(Math.Sqrt(maxFrameMacroblocks * 8)) * 16;
        double scale = Math.Min(1, Math.Min((double)maxDimensionPixels / width, (double)maxDimensionPixels / height));
        scale = Math.Min(scale, Math.Sqrt((double)maxFrameMacroblocks / Macroblocks(width, height)));
        width = Math.Max(2, (int)Math.Floor(width * scale) & ~1);
        height = Math.Max(2, (int)Math.Floor(height * scale) & ~1);
        // Ceiling to macroblocks can keep a scaled frame just over MaxFS.
        while (Macroblocks(width, height) > maxFrameMacroblocks || !FitsDimension(width, height, maxFrameMacroblocks))
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
        return (width, height);
    }

    private static long Macroblocks(int width, int height) => ((width + 15L) / 16) * ((height + 15L) / 16);
}
