import AppKit
import ApplicationServices
import CoreGraphics

@MainActor
final class DesktopHost: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var controller: Process?
    private var input: Pipe?
    private var output = Data()
    private var configured = false
    private var running = false
    private var timer: Timer?
    private let password = NSSecureTextField()
    private let confirmation = NSSecureTextField()
    private let owner = NSTextField(labelWithString: "正在检查访问密码…")
    private let permissions = NSTextField(wrappingLabelWithString: "")
    private let status = NSTextField(wrappingLabelWithString: "服务尚未启动。")
    private let lan = NSButton(checkboxWithTitle: "允许受信任的局域网访问（HTTP 不加密）", target: nil, action: nil)
    private var save: NSButton!
    private var start: NSButton!
    private var stop: NSButton!
    private var browser: NSButton!
    private var logPath: String?

    static func launch() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = DesktopHost()
        app.delegate = delegate
        app.run()
        withExtendedLifetime(delegate) {}
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let item = NSMenuItem()
        menu.addItem(item)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 Remote Control", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu
        NSApplication.shared.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 610, height: 740), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Remote Control · 本机设置"
        window.delegate = self
        window.isReleasedWhenClosed = false
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 28)
        ])
        func label(_ text: String, _ size: CGFloat = 14, bold: Bool = false) {
            let field = NSTextField(wrappingLabelWithString: text)
            field.font = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
            stack.addArrangedSubview(field)
            field.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        func button(_ title: String, _ action: Selector) -> NSButton {
            NSButton(title: title, target: self, action: action)
        }
        func row(_ views: [NSView]) {
            let row = NSStackView(views: views)
            row.orientation = .horizontal
            row.spacing = 10
            stack.addArrangedSubview(row)
        }
        label("让这台 Mac 安全地准备就绪", 23, bold: true)
        label("由 Remote Control Agent 申请权限，不再给 Terminal 或 Node 授权。授权必须在这台 Mac 上确认。")
        label("1 · 访问密码", 16, bold: true)
        stack.addArrangedSubview(owner)
        password.placeholderString = "新密码（12–256 个字符）"
        confirmation.placeholderString = "确认密码"
        password.widthAnchor.constraint(equalToConstant: 220).isActive = true
        confirmation.widthAnchor.constraint(equalToConstant: 220).isActive = true
        row([password, confirmation])
        save = button("保存密码", #selector(savePassword))
        stack.addArrangedSubview(save)
        label("2 · 系统权限", 16, bold: true)
        stack.addArrangedSubview(permissions)
        row([button("申请屏幕录制", #selector(requestScreen)), button("申请辅助功能", #selector(requestAccessibility)), button("刷新状态", #selector(refresh))])
        label("系统设置中请选择 Remote Control Agent。屏幕录制批准后若状态未更新，请退出并重新打开应用；无需授予完全磁盘访问。", 12)
        label("启用局域网时，macOS 可能为内置 Remote Control Gateway 弹出入站连接确认。这是防火墙权限，与录屏/辅助功能不同；仅在可信网络允许。", 12)
        label("3 · 启动与连接", 16, bold: true)
        stack.addArrangedSubview(lan)
        start = button("启动服务", #selector(startService))
        stop = button("停止", #selector(stopService))
        browser = button("打开控制网页", #selector(openBrowser))
        row([start, stop, browser, button("查看日志", #selector(openLog))])
        stack.addArrangedSubview(status)
        status.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        label("关闭窗口即停止服务。局域网仅适合可信私有网络；公网请使用 HTTPS / VPN。不会安装后台服务或自动启动。", 12)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        refresh()
        launchController()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    private func launchController() {
        guard let resources = Bundle.main.resourceURL else { status.stringValue = "应用资源缺失，请重新打包。"; return }
        let root = resources.appendingPathComponent("payload")
        let process = Process()
        process.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/RemoteControlGateway.app/Contents/MacOS/RemoteControlGateway")
        process.arguments = [root.appendingPathComponent("dist-server/desktop.js").path]
        process.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "NODE_OPTIONS")
        env.removeValue(forKey: "NODE_PATH")
        env["REMOTECONTROL_AGENT_PATH"] = Bundle.main.executableURL!.path
        env["REMOTECONTROL_HOST"] = "127.0.0.1"
        env["REMOTECONTROL_PORT"] = "8787"
        env["REMOTECONTROL_DATA_DIR"] = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/RemoteControl").path
        process.environment = env
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        input = stdin
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in self?.receive(data) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in
                self?.status.stringValue = String(data: data, encoding: .utf8) ?? "控制进程发生错误。"
            }
        }
        process.terminationHandler = { [weak self] process in
            Task { @MainActor in
                self?.controller = nil
                self?.running = false
                self?.status.stringValue = "控制进程已退出 (\(process.terminationStatus))，请重新打开应用或查看日志。"
                self?.refresh()
            }
        }
        do { try process.run(); controller = process; refresh() }
        catch { status.stringValue = "无法启动内置运行时：\(error.localizedDescription)" }
    }

    private func receive(_ data: Data) {
        output.append(data)
        while let index = output.firstIndex(of: 10) {
            let line = output.prefix(upTo: index)
            output.removeSubrange(...index)
            guard let state = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            configured = state["configured"] as? Bool ?? false
            running = state["running"] as? Bool ?? false
            logPath = state["logPath"] as? String
            if let error = state["error"] as? String { status.stringValue = error }
            else if running {
                let addresses = state["addresses"] as? [String] ?? []
                status.stringValue = "运行中 · http://127.0.0.1:8787" + (addresses.isEmpty ? "\n仅本机访问" : "\n局域网：" + addresses.joined(separator: " · "))
            } else { status.stringValue = "服务已停止。" }
            refresh()
        }
    }

    private func send(_ value: [String: Any]) {
        guard let controller, controller.isRunning, let input else { status.stringValue = "控制进程不可用，请重新打开应用。"; return }
        guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
        data.append(10)
        do { try input.fileHandleForWriting.write(contentsOf: data) }
        catch { status.stringValue = error.localizedDescription }
    }

    @objc private func refresh() {
        let screen = CGPreflightScreenCaptureAccess(), accessibility = AXIsProcessTrusted()
        permissions.stringValue = "屏幕录制：\(screen ? "已授权" : "待授权")    ·    辅助功能：\(accessibility ? "已授权" : "待授权")"
        owner.stringValue = configured ? "已设置 · 保留现有访问密码与会话" : "尚未设置 · 密码仅保存在本机（Argon2id）"
        password.isEnabled = !configured
        confirmation.isEnabled = !configured
        save.isEnabled = !configured && controller != nil
        start.isEnabled = configured && screen && accessibility && !running && controller != nil
        stop.isEnabled = running
        browser.isEnabled = running
        lan.isEnabled = !running
    }
    @objc private func savePassword() {
        send(["action": "setup", "password": password.stringValue, "confirmation": confirmation.stringValue])
        password.stringValue = ""
        confirmation.stringValue = ""
    }
    @objc private func requestScreen() {
        if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
        refresh()
    }
    @objc private func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
        refresh()
    }
    @objc private func startService() {
        if lan.state == .on {
            let alert = NSAlert()
            alert.messageText = "允许局域网访问？"
            alert.informativeText = "HTTP 不加密，会传输密码、屏幕和输入。仅在可信私有网络启用，勿用于公共 Wi-Fi 或公网端口转发。"
            alert.addButton(withTitle: "允许可信局域网")
            alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        start.isEnabled = false
        status.stringValue = "正在启动…"
        send(["action": "start", "lan": lan.state == .on])
    }
    @objc private func stopService() { send(["action": "stop"]) }
    @objc private func openBrowser() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:8787")!) }
    @objc private func openLog() {
        if let logPath { NSWorkspace.shared.open(URL(fileURLWithPath: logPath).deletingLastPathComponent()) }
    }
    func windowWillClose(_ notification: Notification) { NSApplication.shared.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        try? input?.fileHandleForWriting.close()
        if let controller, controller.isRunning { controller.waitUntilExit() }
    }
}
