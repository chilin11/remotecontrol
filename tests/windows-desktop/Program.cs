using RemoteControl.Windows;

string directory = args[0];
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
var defaults = DesktopSettings.Load(directory);
Check(!defaults.AllowLan && defaults.FirewallProgram is null, "Default must be local-only");
defaults.AllowLan = true;
defaults.FirewallProgram = @"C:\应用 folder\runtime\node.exe";
defaults.Save(directory);
var restored = DesktopSettings.Load(directory);
Check(restored.AllowLan && restored.FirewallProgram == defaults.FirewallProgram, "LAN consent and path must survive restart");
Check(!File.Exists(Path.Combine(directory, "windows-desktop.json.tmp")), "Atomic save must finish");
Check(DesktopSettings.StartupCommand(@"C:\应用 folder\RemoteControl.exe") == "\"C:\\应用 folder\\RemoteControl.exe\" --background", "Startup path must be quoted");
restored.AllowLan = false;
restored.Save(directory);
Check(!DesktopSettings.Load(directory).AllowLan, "Disabling LAN must persist");
File.WriteAllText(Path.Combine(directory, "windows-desktop.json"), "not json");
try { DesktopSettings.Load(directory); throw new Exception("Corrupt settings must not be ignored"); }
catch (System.Text.Json.JsonException) { }
Console.WriteLine("PASS: Windows desktop settings");
await FfmpegInstallerTests.Run(Path.Combine(directory, "installer"));
if (args.Length > 1)
{
    await FfmpegInstaller.InstallArchiveAsync(args[1], Path.Combine(directory, "upstream"), FfmpegInstaller.Distribution, CancellationToken.None);
    Console.WriteLine("PASS: real upstream FFmpeg archive installation");
}
if (args.Length > 2 && args[2] == "--download")
{
    await FfmpegInstaller.EnsureAsync(Path.Combine(directory, "live-download"), new Progress<string>(Console.WriteLine), CancellationToken.None);
    Console.WriteLine("PASS: production HTTPS FFmpeg automatic download and installation");
}
