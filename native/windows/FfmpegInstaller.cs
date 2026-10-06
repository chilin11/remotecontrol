using System.IO.Compression;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;

namespace RemoteControl.Windows;

internal sealed record FfmpegDistribution(string Version, string Url, string ArchiveSha256,
    string ExecutableSha256, string ArchiveRoot, string Source, string License,
    long MaxDownloadBytes, long MaxExtractBytes);

internal static class FfmpegInstaller
{
    internal static FfmpegDistribution Distribution
    {
        get
        {
            using var stream = typeof(FfmpegInstaller).Assembly.GetManifestResourceStream("RemoteControl.FfmpegDistribution")
                ?? throw new InvalidDataException("FFmpeg 下载配置缺失。");
            return JsonSerializer.Deserialize<FfmpegDistribution>(stream, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new InvalidDataException("FFmpeg 下载配置为空。");
        }
    }

    internal static async Task<bool> MatchesAsync(string file, string expected, CancellationToken token)
    {
        if (!File.Exists(file)) return false;
        await using var stream = File.OpenRead(file);
        string actual = Convert.ToHexString(await SHA256.HashDataAsync(stream, token));
        return actual.Equals(expected, StringComparison.OrdinalIgnoreCase);
    }

    public static Task<string> EnsureAsync(string directory, IProgress<string>? progress, CancellationToken token)
        => EnsureAsync(directory, Distribution, progress, token);

    internal static async Task<string> EnsureAsync(string directory, FfmpegDistribution distribution,
        IProgress<string>? progress, CancellationToken token, HttpClient? testClient = null)
    {
        string executable = Path.Combine(directory, "ffmpeg.exe");
        if (await MatchesAsync(executable, distribution.ExecutableSha256, token)
            && File.Exists(Path.Combine(directory, "THIRD-PARTY.txt"))) return executable;
        string parent = Path.GetDirectoryName(Path.GetFullPath(directory))!;
        Directory.CreateDirectory(parent);
        string work = Path.Combine(parent, ".ffmpeg-install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        try
        {
            string archive = Path.Combine(work, "download.zip");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(TimeSpan.FromMinutes(10));
            using var handler = new SocketsHttpHandler { AllowAutoRedirect = false, ConnectTimeout = TimeSpan.FromSeconds(15) };
            using var client = testClient ?? new HttpClient(handler)
            {
                Timeout = Timeout.InfiniteTimeSpan,
                DefaultRequestVersion = System.Net.HttpVersion.Version11,
                DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact
            };
            for (int attempt = 1; ; attempt++)
            {
                try
                {
                    progress?.Report($"FFmpeg {distribution.Version} 缺失，正在自动下载（{attempt}/3）…");
                    using var headersTimeout = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
                    headersTimeout.CancelAfter(TimeSpan.FromSeconds(30));
                    using var response = await client.GetAsync(distribution.Url, HttpCompletionOption.ResponseHeadersRead, headersTimeout.Token);
                    response.EnsureSuccessStatusCode();
                    if (response.Content.Headers.ContentLength is long length && length > distribution.MaxDownloadBytes)
                        throw new InvalidDataException("FFmpeg 下载体积超过安全限制。");
                    await using var input = await response.Content.ReadAsStreamAsync(deadline.Token);
                    await using var output = File.Create(archive);
                    byte[] buffer = new byte[65536];
                    long total = 0;
                    int lastMb = -1;
                    while (true)
                    {
                        using var idleTimeout = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
                        idleTimeout.CancelAfter(TimeSpan.FromSeconds(30));
                        int count = await input.ReadAsync(buffer, idleTimeout.Token);
                        if (count == 0) break;
                        total += count;
                        if (total > distribution.MaxDownloadBytes) throw new InvalidDataException("FFmpeg 下载体积超过安全限制。");
                        await output.WriteAsync(buffer.AsMemory(0, count), deadline.Token);
                        int mb = (int)(total / 1048576);
                        if (mb != lastMb) { progress?.Report($"正在下载 FFmpeg：{mb} MB…"); lastMb = mb; }
                    }
                    break;
                }
                catch (Exception ex) when (!deadline.IsCancellationRequested &&
                    ((ex is HttpRequestException or IOException) && ex is not InvalidDataException || ex is OperationCanceledException))
                {
                    if (attempt >= 3)
                        throw new IOException("FFmpeg 自动下载失败（已尝试 3 次）。请检查网络、代理或磁盘后点击“检查并自动修复”重试。", ex);
                    await Task.Delay(TimeSpan.FromSeconds(attempt), deadline.Token);
                }
            }
            progress?.Report("下载完成，正在校验 SHA-256 并安装…");
            // InstallArchive never executes the downloaded files.
            await InstallArchiveAsync(archive, directory, distribution, deadline.Token);
            progress?.Report("FFmpeg 已自动安装，正在检查采集和编码能力…");
            return executable;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new TimeoutException("FFmpeg 下载超时，请检查网络后点击“检查并自动修复”重试。");
        }
        finally { if (Directory.Exists(work)) Directory.Delete(work, recursive: true); }
    }

    internal static async Task InstallArchiveAsync(string archive, string destination, FfmpegDistribution distribution, CancellationToken token)
    {
        if (new FileInfo(archive).Length > distribution.MaxDownloadBytes
            || !await MatchesAsync(archive, distribution.ArchiveSha256, token))
            throw new InvalidDataException("FFmpeg SHA-256 校验失败，未安装或执行下载文件。");
        string parent = Path.GetDirectoryName(Path.GetFullPath(destination))!;
        Directory.CreateDirectory(parent);
        string stage = Path.Combine(parent, ".ffmpeg-stage-" + Guid.NewGuid().ToString("N"));
        string backup = Path.Combine(parent, ".ffmpeg-old-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        bool committed = false;
        try
        {
            using var zip = ZipFile.OpenRead(archive);
            long expanded = 0;
            foreach (var entry in zip.Entries)
            {
                token.ThrowIfCancellationRequested();
                string name = entry.FullName.Replace('\\', '/');
                if (name.StartsWith('/') || name.Contains(':') || name.Split('/').Any(part => part is ".." or ".")
                    || !name.StartsWith(distribution.ArchiveRoot + "/", StringComparison.Ordinal)
                    || ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000)
                    throw new InvalidDataException("FFmpeg 压缩包包含不安全路径。");
                expanded = checked(expanded + entry.Length);
                if (expanded > distribution.MaxExtractBytes) throw new InvalidDataException("FFmpeg 解压体积超过安全限制。");
                string relative = name[(distribution.ArchiveRoot.Length + 1)..];
                if (relative.Length == 0 || relative.EndsWith('/')) continue;
                // Keep upstream documentation/licenses/configuration. Only FFmpeg is needed, not ffplay/ffprobe.
                if (relative.StartsWith("bin/", StringComparison.Ordinal) && relative != "bin/ffmpeg.exe") continue;
                string target = Path.Combine(stage, relative == "bin/ffmpeg.exe" ? "ffmpeg.exe" : relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                await using var input = entry.Open();
                await using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write);
                await input.CopyToAsync(output, token);
            }
            if (!await MatchesAsync(Path.Combine(stage, "ffmpeg.exe"), distribution.ExecutableSha256, token)
                || !File.Exists(Path.Combine(stage, "README.txt")) || !File.Exists(Path.Combine(stage, "LICENSE")))
                throw new InvalidDataException("FFmpeg 文件、许可证缺失或可执行文件校验失败。");
            await File.WriteAllTextAsync(Path.Combine(stage, "THIRD-PARTY.txt"),
                $"FFmpeg {distribution.Version} Windows x64 static essentials by Gyan Doshi\nArchive: {distribution.Url}\nArchive SHA-256: {distribution.ArchiveSha256}\nExecutable SHA-256: {distribution.ExecutableSha256}\nLicense: {distribution.License}\nFFmpeg source: {distribution.Source}\nExact build configuration and third-party components: README.txt\nUpstream build/source information: https://www.gyan.dev/ffmpeg/builds/\nRedistributors must satisfy applicable GPL/source and third-party license obligations; these notices are not a legal compliance certification.\n", token);
            token.ThrowIfCancellationRequested();
            bool previous = Directory.Exists(destination);
            if (previous) Directory.Move(destination, backup);
            try { Directory.Move(stage, destination); committed = true; }
            catch { if (previous) Directory.Move(backup, destination); throw; }
        }
        finally
        {
            if (Directory.Exists(stage)) Directory.Delete(stage, recursive: true);
            if (committed && Directory.Exists(backup)) Directory.Delete(backup, recursive: true);
        }
    }
}
