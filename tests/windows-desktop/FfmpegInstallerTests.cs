using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using RemoteControl.Windows;

internal static class FfmpegInstallerTests
{
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
    private static byte[] Archive(string? unsafeName = null, bool license = true)
    {
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
        {
            void Add(string name, string text) { using var writer = new StreamWriter(zip.CreateEntry(name).Open()); writer.Write(text); }
            Add("fixture/bin/ffmpeg.exe", "test executable");
            Add("fixture/bin/ffplay.exe", "not needed");
            Add("fixture/README.txt", "build config");
            if (license) Add("fixture/LICENSE", "GPLv3");
            if (unsafeName is not null) Add(unsafeName, "must not escape");
        }
        return memory.ToArray();
    }
    private sealed class Download(byte[] bytes, int fail = 0, long? length = null) : HttpMessageHandler
    {
        public int Count;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Count++;
            if (Count <= fail) throw new HttpRequestException("temporary network failure");
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };
            if (length.HasValue) response.Content.Headers.ContentLength = length;
            return Task.FromResult(response);
        }
    }
    public static async Task Run(string root)
    {
        Directory.CreateDirectory(root);
        byte[] bytes = Archive();
        var spec = FfmpegInstaller.Distribution with
        {
            ArchiveRoot = "fixture", ArchiveSha256 = Hash(bytes),
            ExecutableSha256 = Hash(Encoding.UTF8.GetBytes("test executable")),
        };
        Check(new Uri(spec.Url).Scheme == "https", "production source must be HTTPS");
        string destination = Path.Combine(root, "installed");
        var download = new Download(bytes, fail: 1);
        await FfmpegInstaller.EnsureAsync(destination, spec, null, CancellationToken.None, new HttpClient(download));
        Check(download.Count == 2, "transient download failure must retry");
        Check(File.ReadAllText(Path.Combine(destination, "ffmpeg.exe")) == "test executable", "flatten executable path");
        Check(File.Exists(Path.Combine(destination, "LICENSE")) && File.Exists(Path.Combine(destination, "THIRD-PARTY.txt")), "preserve license and notice");
        Check(!File.Exists(Path.Combine(destination, "ffplay.exe")), "do not install unnecessary tools");
        var cached = new Download(bytes);
        await FfmpegInstaller.EnsureAsync(destination, spec, null, CancellationToken.None, new HttpClient(cached));
        Check(cached.Count == 0, "installed executable must skip download");

        string zipPath = Path.Combine(root, "fixture.zip");
        async Task Reject(byte[] archive, FfmpegDistribution policy, string label)
        {
            File.WriteAllBytes(zipPath, archive);
            try { await FfmpegInstaller.InstallArchiveAsync(zipPath, destination, policy, CancellationToken.None); throw new Exception("Expected rejection: " + label); }
            catch (InvalidDataException) { }
            Check(File.ReadAllText(Path.Combine(destination, "ffmpeg.exe")) == "test executable", "failure must preserve previous installation: " + label);
            Check(!Directory.EnumerateDirectories(root, ".ffmpeg-stage-*").Any(), "failed stage must be cleaned");
        }
        await Reject(bytes, spec with { ArchiveSha256 = new string('0', 64) }, "archive hash");
        await Reject(bytes, spec with { ExecutableSha256 = new string('0', 64) }, "exe hash");
        await Reject(bytes, spec with { MaxExtractBytes = 1 }, "expansion limit");
        await Reject(bytes, spec with { MaxDownloadBytes = 1 }, "download limit");
        foreach (string name in new[] { "fixture/../../escape.txt", "fixture\\..\\escape.txt", "/outside", "fixture/C:/outside" })
        {
            byte[] hostile = Archive(name);
            await Reject(hostile, spec with { ArchiveSha256 = Hash(hostile) }, "unsafe ZIP path");
        }
        byte[] noLicense = Archive(license: false);
        await Reject(noLicense, spec with { ArchiveSha256 = Hash(noLicense) }, "missing license");

        var tooLarge = new Download(bytes, length: spec.MaxDownloadBytes + 1);
        try { await FfmpegInstaller.EnsureAsync(Path.Combine(root, "oversized"), spec, null, CancellationToken.None, new HttpClient(tooLarge)); throw new Exception("Oversized HTTP response accepted"); }
        catch (InvalidDataException) { }
        Check(tooLarge.Count == 1, "size violation must not retry");
        var alwaysFails = new Download(bytes, fail: 10);
        try { await FfmpegInstaller.EnsureAsync(Path.Combine(root, "network-failure"), spec, null, CancellationToken.None, new HttpClient(alwaysFails)); throw new Exception("Network failure accepted"); }
        catch (IOException) { }
        Check(alwaysFails.Count == 3, "network retry must be bounded");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        File.WriteAllBytes(zipPath, bytes);
        try { await FfmpegInstaller.InstallArchiveAsync(zipPath, destination, spec, cancellation.Token); throw new Exception("Cancellation ignored"); }
        catch (OperationCanceledException) { }
        Check(!Directory.EnumerateDirectories(root, ".ffmpeg-*").Any(), "temporary directories must be cleaned");
        Console.WriteLine("PASS: FFmpeg auto-install, cache, retry, checksums, ZIP safety and cancellation");
    }
}
