using System.Buffers.Binary;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace RemoteControl.Windows;

/// <summary>
/// Local-cursor mode: FFmpeg leaves the pointer out of the video and the browser draws it with no round trip.
/// This polls the current cursor and sends its shape (PNG + hotspot) to the gateway whenever it changes.
/// </summary>
internal static class CursorMonitor
{
    private const int CursorShowing = 0x1;

    public static Task RunAsync(CancellationToken cancellationToken) => Task.Run(async () =>
    {
        double scale = DpiScale();
        IntPtr last = IntPtr.Zero;
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(50));
        try
        {
            do
            {
                var info = new CURSORINFO { cbSize = Marshal.SizeOf<CURSORINFO>() };
                // A hidden cursor keeps the last shape: headless hosts without a mouse report it as hidden.
                if (!GetCursorInfo(ref info) || (info.flags & CursorShowing) == 0 || info.hCursor == IntPtr.Zero || info.hCursor == last) continue;
                var shape = Render(info.hCursor);
                if (shape is null) continue;
                last = info.hCursor;
                new PacketWriter().WriteJson(1, new
                {
                    type = "cursor",
                    image = "data:image/png;base64," + Convert.ToBase64String(shape.Value.Png),
                    x = shape.Value.HotX / scale,
                    y = shape.Value.HotY / scale,
                    scale
                });
            } while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false));
        }
        catch (OperationCanceledException) { }
    }, CancellationToken.None);

    /// <summary>Cursor bitmaps follow the system DPI in this per-monitor-aware process; the browser wants CSS pixels.</summary>
    private static double DpiScale()
    {
        try { return Math.Clamp(GetDpiForSystem() / 96.0, 1.0, 4.0); }
        catch (EntryPointNotFoundException) { return 1.0; }
    }

    private static (byte[] Png, int HotX, int HotY)? Render(IntPtr cursor)
    {
        if (!GetIconInfo(cursor, out ICONINFO icon)) return null;
        try
        {
            byte[]? mask = ReadBitmap(icon.hbmMask, out int width, out int maskHeight);
            if (mask is null || width < 1 || width > 256) return null;
            byte[] pixels;
            int height;
            if (icon.hbmColor != IntPtr.Zero)
            {
                byte[]? color = ReadBitmap(icon.hbmColor, out int colorWidth, out height);
                if (color is null || colorWidth != width || height > maskHeight) return null;
                pixels = color;
                bool hasAlpha = false;
                for (int i = 3; i < pixels.Length && !hasAlpha; i += 4) hasAlpha = pixels[i] != 0;
                // Legacy color cursors carry no alpha: the AND mask marks transparent pixels.
                if (!hasAlpha)
                    for (int i = 0; i < width * height; i++) pixels[i * 4 + 3] = mask[i * 4] == 0 ? (byte)255 : (byte)0;
            }
            else
            {
                // Monochrome cursor: AND mask on top, XOR mask below.
                height = maskHeight / 2;
                int count = width * height;
                pixels = new byte[count * 4];
                var inverted = new bool[count];
                for (int i = 0; i < count; i++)
                {
                    bool and = mask[i * 4] != 0, xor = mask[(i + count) * 4] != 0;
                    if (and && !xor) continue;
                    // Screen-inverting pixels (e.g. the text I-beam) cannot be expressed in a PNG: draw them black.
                    inverted[i] = and && xor;
                    byte value = !and && xor ? (byte)255 : (byte)0;
                    pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = value;
                    pixels[i * 4 + 3] = 255;
                }
                // A white outline keeps inverted shapes visible on dark content.
                for (int y = 0; y < height; y++)
                    for (int x = 0; x < width; x++)
                    {
                        int i = y * width + x;
                        if (pixels[i * 4 + 3] != 0) continue;
                        bool edge = false;
                        for (int dy = -1; dy <= 1 && !edge; dy++)
                            for (int dx = -1; dx <= 1 && !edge; dx++)
                            {
                                int nx = x + dx, ny = y + dy;
                                edge = nx >= 0 && ny >= 0 && nx < width && ny < height && inverted[ny * width + nx];
                            }
                        if (edge) pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = pixels[i * 4 + 3] = 255;
                    }
            }
            if (height < 1 || height > 256) return null;
            return (EncodePng(pixels, width, height), icon.xHotspot, icon.yHotspot);
        }
        finally
        {
            if (icon.hbmMask != IntPtr.Zero) DeleteObject(icon.hbmMask);
            if (icon.hbmColor != IntPtr.Zero) DeleteObject(icon.hbmColor);
        }
    }

    /// <summary>Top-down 32-bit BGRA copy of a GDI bitmap (monochrome bitmaps become black/white pixels).</summary>
    private static byte[]? ReadBitmap(IntPtr handle, out int width, out int height)
    {
        width = height = 0;
        var bitmap = new BITMAP();
        if (handle == IntPtr.Zero || GetObject(handle, Marshal.SizeOf<BITMAP>(), ref bitmap) == 0) return null;
        width = bitmap.bmWidth;
        height = Math.Abs(bitmap.bmHeight);
        if (width < 1 || height < 1 || width > 256 || height > 512) return null;
        // BITMAPINFOHEADER plus room for a color table.
        byte[] header = new byte[40 + 256 * 4];
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(0), 40);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(4), width);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(8), -height);
        BinaryPrimitives.WriteInt16LittleEndian(header.AsSpan(12), 1);
        BinaryPrimitives.WriteInt16LittleEndian(header.AsSpan(14), 32);
        byte[] pixels = new byte[width * height * 4];
        IntPtr dc = GetDC(IntPtr.Zero);
        try
        {
            return GetDIBits(dc, handle, 0, (uint)height, pixels, header, 0) == height ? pixels : null;
        }
        finally { ReleaseDC(IntPtr.Zero, dc); }
    }

    private static byte[] EncodePng(byte[] pixels, int width, int height)
    {
        using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try
        {
            for (int y = 0; y < height; y++) Marshal.Copy(pixels, y * width * 4, data.Scan0 + y * data.Stride, width * 4);
        }
        finally { bitmap.UnlockBits(data); }
        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Png);
        return stream.ToArray();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x, y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct CURSORINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ICONINFO
    {
        [MarshalAs(UnmanagedType.Bool)] public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAP
    {
        public int bmType;
        public int bmWidth;
        public int bmHeight;
        public int bmWidthBytes;
        public ushort bmPlanes;
        public ushort bmBitsPixel;
        public IntPtr bmBits;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorInfo(ref CURSORINFO info);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForSystem();

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr window);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr window, IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern int GetObject(IntPtr handle, int size, ref BITMAP bitmap);

    [DllImport("gdi32.dll")]
    private static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint start, uint lines, [Out] byte[] bits, [In, Out] byte[] info, uint usage);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr handle);
}
