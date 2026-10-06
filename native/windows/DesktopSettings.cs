using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace RemoteControl.Windows;

// Only non-secret UI preferences live here. Passwords/sessions stay in the database.
internal sealed class DesktopSettings
{
    internal const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    internal const string StartupName = "RemoteControl";
    public bool AllowLan { get; set; }
    public string? FirewallProgram { get; set; }

    public static DesktopSettings Load(string directory)
    {
        string file = Path.Combine(directory, "windows-desktop.json");
        if (!File.Exists(file)) return new();
        return JsonSerializer.Deserialize<DesktopSettings>(File.ReadAllText(file))
            ?? throw new InvalidDataException("Windows 设置文件为空，请查看日志并修复 windows-desktop.json。");
    }

    public void Save(string directory)
    {
        Directory.CreateDirectory(directory);
        string file = Path.Combine(directory, "windows-desktop.json");
        string temporary = file + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this), new UTF8Encoding(false));
        File.Move(temporary, file, overwrite: true);
    }

    internal static string StartupCommand(string executable) => $"\"{executable}\" --background";

    public static bool StartupEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return string.Equals(key?.GetValue(StartupName) as string,
            StartupCommand(Environment.ProcessPath!), StringComparison.OrdinalIgnoreCase);
    }

    public static void SetStartup(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey)
            ?? throw new InvalidOperationException("无法写入当前用户登录启动项。");
        if (enabled) key.SetValue(StartupName, StartupCommand(Environment.ProcessPath!), RegistryValueKind.String);
        else key.DeleteValue(StartupName, throwOnMissingValue: false);
        if (StartupEnabled() != enabled) throw new IOException("登录启动项校验失败，设置未生效。");
    }
}
