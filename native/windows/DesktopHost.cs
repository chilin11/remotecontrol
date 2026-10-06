using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
using System.Windows.Forms;

namespace RemoteControl.Windows;

internal static class DesktopHost
{
    // The SDK's default executable manifest requests asInvoker. Only the explicit
    // firewall action below uses runas; capture and the gateway stay unelevated.
    public static int Run(bool background = false)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            string identity = System.Security.Principal.WindowsIdentity.GetCurrent().User!.Value;
            using var mutex = new Mutex(false, @"Local\RemoteControl.Desktop." + identity);
            using var activation = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\RemoteControl.Show." + identity);
            bool owner;
            try { owner = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { owner = true; }
            if (!owner) { if (!background) activation.Set(); return 0; }
            try
            {
                using var form = new DesktopWindow(background, activation);
                form.QueueInitialization();
                Application.Run(form);
            }
            finally { mutex.ReleaseMutex(); }
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "远程控制启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}

internal sealed class DesktopWindow : Form
{
    private const string LocalUrl = "http://127.0.0.1:8787";
    private readonly string root = AppContext.BaseDirectory;
    private readonly string dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RemoteControl");
    private readonly TextBox password = new() { UseSystemPasswordChar = true, MaxLength = 256, Width = 330 };
    private readonly TextBox confirmation = new() { UseSystemPasswordChar = true, MaxLength = 256, Width = 330 };
    private readonly Label passwordState = TextLabel("正在读取现有设置…");
    private readonly Label readinessState = TextLabel("尚未检查 FFmpeg 和交互桌面。");
    private readonly Label serviceState = TextLabel("服务未启动；默认仅本机访问。");
    private readonly Label errorState = TextLabel("");
    private readonly TextBox addresses = new() { ReadOnly = true, Multiline = true, Width = 720, Height = 65, Dock = DockStyle.Top, ScrollBars = ScrollBars.Vertical };
    private readonly CheckBox lan = new() { Text = "允许可信私有局域网访问（保存后下次沿用）", AutoSize = true };
    private readonly CheckBox startup = new() { Text = "开机后登录当前用户时自动启动（后台托盘）", AutoSize = true };
    private readonly Label startupState = TextLabel("");
    private readonly Button setup = MakeButton("保存密码并启动");
    private readonly Button check = MakeButton("检查并自动修复");
    private readonly Button start = MakeButton("启动服务");
    private readonly Button stop = MakeButton("停止服务");
    private readonly Button browser = MakeButton("打开浏览器");
    private readonly Button logs = MakeButton("查看日志");
    private readonly Button firewall = MakeButton("申请私有网络权限（UAC）");
    private readonly Button hide = MakeButton("隐藏到托盘");
    private readonly NotifyIcon tray = new();
    private readonly ToolStripMenuItem trayStart = new("启动服务");
    private readonly ToolStripMenuItem trayStop = new("停止服务");
    private readonly System.Windows.Forms.Timer activationTimer = new() { Interval = 500 };
    private readonly System.Windows.Forms.Timer readinessRetry = new() { Interval = 5000 };
    private readonly EventWaitHandle activation;
    private readonly bool background;
    private DesktopSettings settings = new();
    private bool showRequested, autoStartPending = true, starting, updatingStartup, checking, configuringFirewall;
    private readonly System.Windows.Forms.Timer timeout = new() { Interval = 25000 };
    private readonly CancellationTokenSource lifetime = new();
    private bool preparing;
    private string? resolvedFfmpeg;
    private Process? controller;
    private ProcessJob? job;
    private int generation;
    private bool closing, busy = true, configured, running, ready;
    private string? pendingAction;
    private string logPath;
    private string NodePath => Path.Combine(root, "runtime", "node.exe");
    private string FfmpegPath => resolvedFfmpeg ?? Path.Combine(root, "ffmpeg", "ffmpeg.exe");
    private string HostLog => Path.Combine(dataDir, "desktop-host.log");

    public DesktopWindow(bool background, EventWaitHandle activation)
    {
        this.background = background;
        this.activation = activation;
        Text = "远程控制 · Windows";
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath!);
        ClientSize = new Size(790, 780);
        MinimumSize = new Size(700, 680);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 10);
        logPath = Path.Combine(dataDir, "desktop.log");
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(12) };
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 29));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 30));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 35));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 6));
        Controls.Add(layout);

        var first = Step("1 · 访问密码（已有密码不会被覆盖）");
        first.Controls.Add(passwordState);
        first.Controls.Add(InputRow("密码（12–256 个字符）", password));
        first.Controls.Add(InputRow("再次输入密码", confirmation));
        first.Controls.Add(Buttons(setup));
        layout.Controls.Add(first.Parent!, 0, 0);
        var second = Step("2 · 权限与运行条件");
        second.Controls.Add(TextLabel("自动检查屏幕采集和桌面条件，无需录屏/辅助功能授权。局域网防火墙只需一次 Windows 管理员确认；应用本身以普通用户运行。锁屏、UAC 安全桌面和管理员窗口不支持远控。"));
        second.Controls.Add(readinessState);
        second.Controls.Add(Buttons(check, firewall));
        second.Controls.Add(TextLabel("仅允许 TCP 8787、Private、LocalSubnet，不开放公共网络。请在 Windows 设置中将可信网络设为“专用”；公司策略或路由隔离仍可能阻止连接。"));
        layout.Controls.Add(second.Parent!, 0, 1);
        var third = Step("3 · 启动与访问");
        third.Controls.Add(lan);
        third.Controls.Add(startup);
        third.Controls.Add(startupState);
        third.Controls.Add(serviceState);
        third.Controls.Add(Buttons(start, stop, browser, logs, hide));
        third.Controls.Add(addresses);
        third.Controls.Add(TextLabel("本机：" + LocalUrl + "　关闭窗口仅隐藏到托盘；彻底退出请用托盘菜单。"));
        layout.Controls.Add(third.Parent!, 0, 2);
        errorState.ForeColor = Color.Firebrick;
        layout.Controls.Add(errorState, 0, 3);

        setup.Click += (_, _) => SavePassword();
        check.Click += async (_, _) => await RecoverAndCheck();
        start.Click += async (_, _) => await StartGateway();
        stop.Click += (_, _) => StopGateway();
        browser.Click += (_, _) => OpenTarget(LocalUrl);
        logs.Click += (_, _) => OpenLogs();
        firewall.Click += async (_, _) => await RequestFirewall();
        startup.CheckedChanged += (_, _) => ChangeStartup();
        hide.Click += (_, _) => Hide();
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开设置", null, (_, _) => ShowSettings());
        menu.Items.Add("打开控制网页", null, (_, _) => OpenTarget(LocalUrl));
        menu.Items.Add(trayStart);
        menu.Items.Add(trayStop);
        menu.Items.Add("查看日志", null, (_, _) => OpenLogs());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出（停止远控）", null, (_, _) => { closing = true; Close(); });
        trayStart.Click += async (_, _) => { ShowSettings(); await StartGateway(); };
        trayStop.Click += (_, _) => StopGateway();
        tray.Icon = Icon ?? SystemIcons.Application;
        tray.Text = "远程控制 · 正在准备";
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += (_, _) => ShowSettings();
        activationTimer.Tick += (_, _) => { if (activation.WaitOne(0)) ShowSettings(); };
        activationTimer.Start();
        readinessRetry.Tick += async (_, _) => { if (!ready && !starting) await CheckReadiness(); };
        timeout.Tick += (_, _) =>
        {
            FailController("控制进程响应超时，已停止进程树。请点击检查就绪状态重试并查看日志。");
        };
        FormClosing += (_, e) =>
        {
            if (!closing && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                tray.ShowBalloonTip(2500, "远程控制仍在后台", "双击托盘图标打开设置，右键菜单可停止或退出。", ToolTipIcon.Info);
                return;
            }
            closing = true;
            tray.Visible = false;
            lifetime.Cancel();
            timeout.Stop();
            CloseController();
        };
        RefreshControls();
    }

    protected override void SetVisibleCore(bool value) => base.SetVisibleCore(value && (!background || showRequested));

    public void QueueInitialization()
    {
        _ = Handle;
        BeginInvoke((Action)(async () =>
        {
            try
            {
                settings = DesktopSettings.Load(dataDir);
                lan.Checked = settings.AllowLan;
                updatingStartup = true;
                startup.Checked = DesktopSettings.StartupEnabled();
                updatingStartup = false;
                startupState.Text = startup.Checked ? "已启用登录后台启动；请保持程序目录不变。" : "未启用自启动。";
                await PrepareController();
                await CheckReadiness();
                if (background && !configured && !busy) ShowSettings();
            }
            catch (OperationCanceledException) when (closing) { }
            catch (Exception ex) { FailController("自动准备失败：" + ex.Message + " 请检查网络后点击“检查并自动修复”重试。"); }
            finally { updatingStartup = false; }
        }));
    }

    private void ShowSettings()
    {
        showRequested = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void ChangeStartup()
    {
        if (updatingStartup) return;
        try
        {
            DesktopSettings.SetStartup(startup.Checked);
            startupState.Text = startup.Checked ? "已启用：下次登录自动在托盘运行，不请求 UAC。" : "已关闭登录自启动；当前服务不受影响。";
        }
        catch (Exception ex)
        {
            updatingStartup = true;
            startup.Checked = !startup.Checked;
            updatingStartup = false;
            errorState.Text = "自启动设置失败：" + ex.Message;
        }
    }

    private void StopGateway()
    {
        autoStartPending = false;
        readinessRetry.Stop();
        Send(new { action = "stop" }, "stop");
    }

    private void TryAutoStart()
    {
        if (!autoStartPending || busy || !configured || !ready || running || closing || configuringFirewall) return;
        autoStartPending = false;
        bool allowLan = settings.AllowLan && string.Equals(settings.FirewallProgram, NodePath, StringComparison.OrdinalIgnoreCase);
        if (settings.AllowLan && !allowLan)
        {
            lan.Checked = false;
            tray.ShowBalloonTip(4000, "需要重新配置局域网", "程序目录已变更，本次只启动本机模式；请打开设置重新申请防火墙。", ToolTipIcon.Warning);
        }
        Send(new { action = "start", lan = allowLan }, "start");
    }

    private static Label TextLabel(string text) => new() { Text = text, AutoSize = true, MaximumSize = new Size(730, 0), Margin = new Padding(4, 3, 4, 3) };
    private static Button MakeButton(string text) => new() { Text = text, AutoSize = true, Margin = new Padding(4), Padding = new Padding(5, 2, 5, 2) };
    private static FlowLayoutPanel Buttons(params Control[] items)
    {
        var panel = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, WrapContents = true };
        panel.Controls.AddRange(items);
        return panel;
    }
    private static FlowLayoutPanel InputRow(string title, TextBox input) => Buttons(TextLabel(title), input);
    private static FlowLayoutPanel Step(string title)
    {
        var group = new GroupBox { Text = title, Dock = DockStyle.Fill, Padding = new Padding(8) };
        var flow = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true };
        group.Controls.Add(flow);
        return flow;
    }

    private void RefreshControls()
    {
        bool connected = controller is not null;
        setup.Enabled = connected && !busy && !configured;
        password.Enabled = confirmation.Enabled = !configured && !busy && connected;
        start.Enabled = connected && !busy && configured && ready && !running && !starting && !configuringFirewall;
        stop.Enabled = connected && !busy && running;
        browser.Enabled = running;
        lan.Enabled = configured && !running && !busy && !starting && !configuringFirewall;
        startup.Enabled = !busy && configured && !starting && !configuringFirewall;
        firewall.Enabled = !starting && !configuringFirewall;
        check.Enabled = !checking && !starting && !configuringFirewall && !preparing;
        trayStart.Enabled = start.Enabled;
        trayStop.Enabled = stop.Enabled;
        tray.Text = running ? "远程控制 · 后台运行" : "远程控制 · 服务未运行";
        passwordState.Text = configured ? "已有访问密码，已保留。请使用原密码登录；此向导不会重置密码。" : "首次使用请设置两次相同密码（12–256 个字符）。";
    }

    private void SavePassword()
    {
        if (configured) return;
        if (password.Text.Length is < 12 or > 256 || password.Text != confirmation.Text)
        {
            errorState.Text = "密码需为 12–256 个字符，且两次输入一致。";
            return;
        }
        Send(new { action = "setup", password = password.Text, confirmation = confirmation.Text }, "setup");
        password.Clear();
        confirmation.Clear();
    }

    private async Task StartGateway()
    {
        if (starting || configuringFirewall || busy || !configured || !ready || running || closing) return;
        starting = true;
        autoStartPending = false;
        RefreshControls();
        try
        {
            bool allowLan = lan.Checked;
            string? notice = null;
            if (allowLan && !settings.AllowLan && MessageBox.Show(this,
                "仅在可信私有网络开启。HTTP 不加密密码和画面；任何持有密码的人可控制桌面，不要做公网端口映射。\n\n此选择将保存，下次启动沿用。继续？",
                "允许可信局域网", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            if (allowLan && !string.Equals(settings.FirewallProgram, NodePath, StringComparison.OrdinalIgnoreCase))
            {
                if (!await RequestFirewall())
                {
                    allowLan = false;
                    lan.Checked = false;
                    notice = errorState.Text + " 已改用本机模式；可稍后重新申请。";
                }
            }
            if (closing) return;
            settings.AllowLan = allowLan;
            settings.Save(dataDir);
            Send(new { action = "start", lan = allowLan }, "start");
            if (notice is not null) errorState.Text = notice;
        }
        catch (Exception ex) { errorState.Text = "保存启动设置失败：" + ex.Message; }
        finally { starting = false; if (!closing) RefreshControls(); }
    }

    private async Task PrepareController()
    {
        if (preparing || closing) return;
        preparing = true;
        ready = false;
        RefreshControls();
        try
        {
            string bundled = Path.Combine(root, "ffmpeg", "ffmpeg.exe");
            if (File.Exists(bundled)) resolvedFfmpeg = bundled;
            else
            {
                readinessState.Text = "检测到 FFmpeg 缺失，正在自动下载安装（无需管理员权限）…";
                var progress = new Progress<string>(message => { if (!closing) readinessState.Text = message; });
                string installed = Path.Combine(dataDir, "ffmpeg-" + FfmpegInstaller.Distribution.Version);
                resolvedFfmpeg = await Task.Run(() => FfmpegInstaller.EnsureAsync(installed, progress, lifetime.Token));
            }
            if (!closing) StartController();
        }
        finally { preparing = false; if (!closing) RefreshControls(); }
    }

    private void StartController()
    {
        foreach (string file in new[] { NodePath, FfmpegPath, Path.Combine(root, "dist-server", "desktop.js"), Environment.ProcessPath ?? "" })
            if (!File.Exists(file)) throw new FileNotFoundException("部署文件缺失：" + file);
        foreach (string folder in new[] { "dist", "node_modules" })
            if (!Directory.Exists(Path.Combine(root, folder))) throw new DirectoryNotFoundException("部署目录缺失：" + folder);
        Directory.CreateDirectory(dataDir);
        var info = new ProcessStartInfo(NodePath)
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        // Ignore inherited service binding overrides: the UI owns this decision.
        info.Environment["REMOTECONTROL_HOST"] = "127.0.0.1";
        info.Environment["REMOTECONTROL_PORT"] = "8787";
        info.ArgumentList.Add(Path.Combine(root, "dist-server", "desktop.js"));
        info.Environment["REMOTECONTROL_AGENT_PATH"] = Environment.ProcessPath!;
        info.Environment["REMOTECONTROL_FFMPEG_PATH"] = FfmpegPath;
        info.Environment["REMOTECONTROL_DATA_DIR"] = dataDir;
        info.Environment.Remove("REMOTECONTROL_AGENT_COMMAND");
        info.Environment.Remove("NODE_OPTIONS");
        info.Environment.Remove("NODE_PATH");
        var nextJob = new ProcessJob();
        var process = new Process { StartInfo = info };
        try
        {
            if (!process.Start()) throw new InvalidOperationException("无法启动 bundled Node。");
            // desktop.js never starts a gateway until it receives a start command.
            // Assign before writing any stdin: every gateway/agent/FFmpeg child
            // inherits this job, without the Process.Start / child-spawn race.
            nextJob.Add(process);
        }
        catch
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
            nextJob.Dispose();
            process.Dispose();
            throw;
        }
        job = nextJob;
        controller = process;
        int current = ++generation;
        busy = true;
        pendingAction = null;
        timeout.Start();
        _ = Task.Run(() => ReadReplies(process, current));
        _ = Task.Run(async () =>
        {
            try
            {
                while (await process.StandardError.ReadLineAsync() is { } line) AppendHostLog(line);
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException) { }
        });
        RefreshControls();
    }

    private async Task ReadReplies(Process process, int current)
    {
        try
        {
            while (await process.StandardOutput.ReadLineAsync() is { } line)
            {
                if (line.Length > 65536) throw new InvalidDataException("IPC 状态行过长。");
                var state = JsonSerializer.Deserialize<ControllerState>(line) ?? throw new InvalidDataException("IPC 状态为空。");
                Post(current, () => ApplyState(state));
            }
            Post(current, () => FailController("控制进程已退出。服务和捕获进程已停止，请点击检查就绪状态恢复。"));
        }
        catch (Exception ex)
        {
            Post(current, () => FailController("控制进程通信失败：" + ex.Message));
        }
    }

    private void Post(int current, Action action)
    {
        if (closing || IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke((Action)(() => { if (!closing && current == generation) action(); })); }
        catch (InvalidOperationException) { }
    }

    private void ApplyState(ControllerState state)
    {
        bool needsCleanup = !state.running && (running || pendingAction == "stop" || (pendingAction == "start" && state.error is not null));
        if (pendingAction == "setup") autoStartPending = true;
        configured = state.configured;
        running = state.running;
        busy = false;
        pendingAction = null;
        timeout.Stop();
        if (configured) { password.Clear(); confirmation.Clear(); }
        if (running) lan.Checked = state.lan;
        if (!string.IsNullOrWhiteSpace(state.logPath)) logPath = state.logPath;
        serviceState.Text = running ? (state.lan ? "正在运行 · 局域网模式（仅在可信网络使用）" : "正在运行 · 仅本机访问") : "服务已停止；可选择本机或局域网后启动。";
        addresses.Text = running ? string.Join(Environment.NewLine, new[] { LocalUrl }.Concat(state.lan ? state.addresses ?? [] : [])) : "";
        if (state.error is not null) errorState.Text = state.error;
        if (needsCleanup)
        {
            // Node's Windows SIGTERM is forceful: even a normal stop may leave
            // descendants. Dispose the old job before accepting another start.
            CloseController();
            try { StartController(); }
            catch (Exception ex) { FailController(ex.Message); }
        }
        RefreshControls();
        if (state.error is not null && !Visible)
            tray.ShowBalloonTip(4000, "远程控制需要处理", state.error, ToolTipIcon.Warning);
        if (background && !configured && !busy) ShowSettings();
        TryAutoStart();
    }

    private void Send(object command, string action)
    {
        if (controller is null || busy) return;
        try
        {
            busy = true;
            pendingAction = action;
            errorState.Text = "";
            controller.StandardInput.WriteLine(JsonSerializer.Serialize(command));
            controller.StandardInput.Flush();
            timeout.Start();
            RefreshControls();
        }
        catch (Exception ex) { FailController("发送操作失败：" + ex.Message); }
    }

    private void FailController(string error)
    {
        CloseController();
        running = busy = false;
        autoStartPending = false;
        readinessRetry.Stop();
        pendingAction = null;
        timeout.Stop();
        errorState.Text = error;
        serviceState.Text = "服务不可用；本次进程树已关闭。";
        addresses.Clear();
        AppendHostLog(error);
        if (!Visible) tray.ShowBalloonTip(4000, "远程控制未启动", error, ToolTipIcon.Warning);
        RefreshControls();
    }

    private void CloseController()
    {
        ++generation;
        var process = controller;
        controller = null;
        try
        {
            if (process is not null)
            {
                try { process.StandardInput.Close(); } catch { }
                try
                {
                    if (!process.WaitForExit(4000))
                    {
                        process.Kill(entireProcessTree: true);
                        process.WaitForExit(1000);
                    }
                }
                catch (InvalidOperationException) { }
                catch (Win32Exception) { }
            }
        }
        finally
        {
            // KILL_ON_JOB_CLOSE also handles grandchildren whose parent already
            // exited, which Kill(entireProcessTree) can no longer discover.
            job?.Dispose();
            job = null;
            process?.Dispose();
        }
    }

    private async Task RecoverAndCheck()
    {
        if (closing || busy || preparing || starting || configuringFirewall || checking) return;
        try
        {
            if (controller is null)
            {
                settings = DesktopSettings.Load(dataDir);
                lan.Checked = settings.AllowLan;
                autoStartPending = true;
                await PrepareController();
            }
            await CheckReadiness();
        }
        catch (OperationCanceledException) when (closing) { }
        catch (Exception ex) { FailController("自动修复失败：" + ex.Message + " 请检查网络后重试。"); }
    }

    private async Task CheckReadiness()
    {
        if (checking || closing) return;
        checking = true;
        check.Enabled = false;
        ready = false;
        RefreshControls();
        readinessState.Text = "正在检查交互桌面、gdigrab 和 libx264…";
        try
        {
            string result = await Task.Run(() =>
            {
                if (!Environment.UserInteractive) throw new InvalidOperationException("当前不是交互用户会话。");
                IntPtr desktop = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS
                if (desktop == IntPtr.Zero) throw new InvalidOperationException("当前输入桌面不可访问；请解锁并返回普通桌面。");
                try
                {
                    var name = new StringBuilder(256);
                    if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out _) || !name.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("当前为安全或非默认桌面，请退出 UAC / 锁屏后重试。");
                }
                finally { CloseDesktop(desktop); }
                string devices = ProbeFfmpeg("-devices");
                string encoders = ProbeFfmpeg("-encoders");
                if (!Regex.IsMatch(devices, @"\bgdigrab\b")) throw new InvalidOperationException("bundled FFmpeg 缺少 gdigrab 屏幕采集。");
                if (!Regex.IsMatch(encoders, @"\blibx264\b")) throw new InvalidOperationException("bundled FFmpeg 缺少 libx264 编码器。");
                return "就绪：普通交互桌面；gdigrab / libx264 可用。" + (Regex.IsMatch(encoders, @"\blibx265\b") ? "可选 HEVC（libx265）可用。" : "未提供可选 libx265；请使用 H.264。");
            });
            if (closing) return;
            ready = true;
            readinessState.Text = result + "（检查不保证受保护内容或实际采集成功。）";
        }
        catch (Exception ex)
        {
            if (!closing)
            {
                readinessState.Text = "未就绪：" + ex.Message;
                if (autoStartPending) readinessRetry.Start();
            }
        }
        finally
        {
            checking = false;
            if (!closing)
            {
                if (ready) { readinessRetry.Stop(); TryAutoStart(); }
                check.Enabled = true;
                RefreshControls();
            }
        }
    }

    private string ProbeFfmpeg(string argument)
    {
        if (!File.Exists(FfmpegPath)) throw new FileNotFoundException("部署缺少 ffmpeg/ffmpeg.exe。");
        using var process = new Process { StartInfo = new ProcessStartInfo(FfmpegPath)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
        } };
        process.StartInfo.ArgumentList.Add("-hide_banner");
        process.StartInfo.ArgumentList.Add(argument);
        using var probeJob = new ProcessJob();
        process.Start();
        try { probeJob.Add(process); }
        catch (Win32Exception) when (process.HasExited) { /* A fast listing may already be complete. */ }
        catch
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
            throw;
        }
        Task<string> output = process.StandardOutput.ReadToEndAsync();
        Task<string> error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(10000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("FFmpeg 检查超时。");
        }
        string text = output.GetAwaiter().GetResult() + error.GetAwaiter().GetResult();
        if (process.ExitCode != 0) throw new InvalidOperationException("FFmpeg 检查失败（" + process.ExitCode + "）。");
        return text;
    }

    private async Task<bool> RequestFirewall()
    {
        if (closing || configuringFirewall) return false;
        if (!File.Exists(NodePath)) { errorState.Text = "缺少 runtime/node.exe，无法申请权限。"; return false; }
        if (MessageBox.Show(this, "将显示一次 Windows 管理员确认，仅开放此程序的私有网络 TCP 8787 / 本地子网。不会关闭防火墙或开放公共网络。\n\n继续？", "配置局域网访问", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
        {
            errorState.Text = "已取消局域网防火墙配置。";
            return false;
        }
        configuringFirewall = true;
        RefreshControls();
        // Encode rather than interpolate shell arguments; single quotes in the
        // bundled absolute path are escaped as PowerShell literal quotes.
        string program = NodePath.Replace("'", "''");
        string script = $$"""
            $ErrorActionPreference = 'Stop'
            try {
              $name = 'RemoteControl-Desktop-Private-8787-v1'
              $owner = 'RemoteControl desktop host: bundled node TCP8787 Private LocalSubnet v1'
              $program = '{{program}}'
              $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -Name $name -ErrorAction SilentlyContinue)
              if ($rules.Count -gt 0) {
                if ($rules.Count -ne 1) { throw 'Rule name conflict; no changes made.' }
                $r = $rules[0]
                $app = @($r | Get-NetFirewallApplicationFilter)
                $port = @($r | Get-NetFirewallPortFilter)
                $addr = @($r | Get-NetFirewallAddressFilter)
                if ($r.Description -ne $owner -or $r.Direction -ne 'Inbound' -or $r.Action -ne 'Allow' -or $r.Enabled -ne 'True' -or $r.Profile.ToString() -ne 'Private' -or $r.EdgeTraversalPolicy -ne 'Block' -or $app.Count -ne 1 -or $port.Count -ne 1 -or $port[0].Protocol -notin @('TCP','6') -or (@($port[0].LocalPort) -join ',') -ne '8787' -or (@($port[0].RemotePort) -join ',') -ne 'Any' -or $addr.Count -ne 1 -or (@($addr[0].RemoteAddress) -join ',') -ne 'LocalSubnet' -or (@($addr[0].LocalAddress) -join ',') -ne 'Any') {
                  throw 'Existing rule differs or belongs to another deployment; no changes made.'
                }
                if ($app[0].Program -ne $program) { $r | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $program | Out-Null }
              } else {
                New-NetFirewallRule -PolicyStore PersistentStore -Name $name -DisplayName 'RemoteControl Desktop (Private TCP 8787)' -Description $owner -Direction Inbound -Action Allow -Enabled True -Program $program -Protocol TCP -LocalPort 8787 -Profile Private -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block | Out-Null
              }
              exit 0
            } catch { Write-Error $_ -ErrorAction Continue; exit 1 }
            """;
        try
        {
            string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            using var process = Process.Start(new ProcessStartInfo(powershell)
            {
                UseShellExecute = true, Verb = "runas", WorkingDirectory = root,
                Arguments = "-NoProfile -NonInteractive -EncodedCommand " + encoded
            }) ?? throw new InvalidOperationException("无法启动防火墙授权。");
            await process.WaitForExitAsync();
            if (closing) return false;
            if (process.ExitCode != 0) throw new InvalidOperationException("防火墙规则未通过校验，可能受组织策略限制或存在同名规则冲突。");
            settings.FirewallProgram = NodePath;
            settings.Save(dataDir);
            if (!closing) errorState.Text = "私有网络规则已配置。若手机仍无法连接，请检查 Windows 网络是否为“专用”及路由器设备隔离。";
            return true;
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            if (!closing) errorState.Text = "已取消 UAC 授权；服务不受影响，仍可使用本机模式。";
        }
        catch (Exception ex) { if (!closing) errorState.Text = "防火墙申请失败（不影响本机模式）：" + ex.Message; }
        finally { configuringFirewall = false; if (!closing) RefreshControls(); }
        return false;
    }

    private void OpenTarget(string target)
    {
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
        catch (Exception ex) { errorState.Text = "无法打开：" + ex.Message; }
    }
    private void OpenLogs()
    {
        if (File.Exists(logPath)) OpenTarget(logPath);
        else if (File.Exists(HostLog)) OpenTarget(HostLog);
        else OpenTarget(dataDir);
    }
    private void AppendHostLog(string line)
    {
        try { Directory.CreateDirectory(dataDir); File.AppendAllText(HostLog, $"{DateTimeOffset.Now:O} {line}\n", Encoding.UTF8); }
        catch { /* A logging failure must not prevent process-tree cleanup. */ }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            closing = true;
            lifetime.Cancel();
            timeout.Dispose();
            activationTimer.Dispose();
            readinessRetry.Dispose();
            tray.Visible = false;
            tray.ContextMenuStrip?.Dispose();
            tray.Dispose();
            CloseController();
        }
        base.Dispose(disposing);
    }

    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder information, int length, out int needed);

    private sealed record ControllerState(bool configured, bool running, bool lan, string? url, string[]? addresses, string? logPath, string? error);
}

// A non-inheritable handle owned only by the host. Descendants cannot break
// away: no BREAKAWAY_OK flags are granted. Closing it kills all remaining members.
internal sealed class ProcessJob : IDisposable
{
    private readonly SafeFileHandle handle;
    public ProcessJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法创建进程 Job。");
        var limits = new ExtendedLimits { Basic = new BasicLimits { LimitFlags = 0x00002000 } }; // KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "无法设置 Job 进程树清理策略。");
        }
    }
    public void Add(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "无法将控制进程加入 Job；为避免孤儿进程，拒绝启动。");
    }
    public void Dispose() => handle.Dispose();

    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
}
