import AppKit
import ApplicationServices
import CoreGraphics
import ServiceManagement

// Menu-bar-only host: no Dock icon. Closing the settings window keeps the service running;
// "退出" in the status menu stops the gateway and capture.
@MainActor
final class DesktopHost: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate {
    private static let lanKey = "AllowTrustedLAN"
    private var window: NSWindow!
    private var statusItem: NSStatusItem!
    private var controller: Process?
    private var input: Pipe?
    private var output = Data()
    private var configured = false
    private var running = false
    private var ready = false
    private var addresses: [String] = []
    private var lastError: String?
    // Start automatically once (password + permissions ready), e.g. after login.
    private var wantsAutoStart = true
    private var pendingStart: Bool?
    private var timer: Timer?
    private let password = NSSecureTextField()
    private let confirmation = NSSecureTextField()
    private let owner = NSTextField(labelWithString: "正在检查访问密码…")
    private let permissions = NSTextField(wrappingLabelWithString: "")
    private let status = NSTextField(wrappingLabelWithString: "服务尚未启动。")
    private let lan = NSButton(checkboxWithTitle: "允许受信任的局域网访问（HTTP 不加密）", target: nil, action: nil)
    private let login = NSButton(checkboxWithTitle: "登录时自动打开（在菜单栏后台运行并自动启动服务）", target: nil, action: nil)
    private var save: NSButton!
    private var start: NSButton!
    private var stop: NSButton!
    private var browser: NSButton!
    private var logPath: String?

    private var lanEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: Self.lanKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.lanKey) }
    }
    private var permissionsGranted: Bool { CGPreflightScreenCaptureAccess() && AXIsProcessTrusted() }
    private var loginItemEnabled: Bool {
        let state = SMAppService.mainApp.status
        return state == .enabled || state == .requiresApproval
    }

    static func launch() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = DesktopHost()
        app.delegate = delegate
        app.run()
        withExtendedLifetime(delegate) {}
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMainMenu()
        buildStatusItem()
        buildWindow()
        refresh()
        launchController()
        // Only interrupt the user when setup is incomplete; otherwise stay in the menu bar.
        if !permissionsGranted { showWindow() }
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return false
    }

    // Accessory apps show no menu bar, but key equivalents (⌘V in password fields, ⌘W, ⌘Q) still route here.
    private func buildMainMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appMenu.addItem(withTitle: "退出 Remote Control", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApplication.shared.mainMenu = menu
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let image = NSImage(systemSymbolName: "display", accessibilityDescription: "Remote Control")
        image?.isTemplate = true
        statusItem.button?.image = image
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        func info(_ title: String) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }
        func action(_ title: String, _ selector: Selector, enabled: Bool = true, checked: Bool = false, key: String = "") {
            let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
            item.target = self
            item.isEnabled = enabled
            item.state = checked ? .on : .off
            menu.addItem(item)
        }
        info(summary())
        if running { for address in addresses { info("　" + address) } }
        menu.addItem(.separator())
        if running { action("停止服务", #selector(stopService)) }
        else { action("启动服务", #selector(startService), enabled: canStart()) }
        action("打开控制网页", #selector(openBrowser), enabled: running)
        menu.addItem(.separator())
        action("允许可信局域网访问", #selector(toggleLanFromMenu), enabled: controller != nil, checked: lanEnabled)
        action("登录时自动打开", #selector(toggleLoginFromMenu), checked: loginItemEnabled)
        menu.addItem(.separator())
        action("设置与权限…", #selector(showWindow), key: ",")
        action("查看日志", #selector(openLog), enabled: logPath != nil)
        menu.addItem(.separator())
        action("退出 Remote Control", #selector(quit), key: "q")
    }

    private func summary() -> String {
        if controller == nil { return "控制进程未运行" }
        if !configured { return "未设置访问密码" }
        if !permissionsGranted { return "等待系统权限" }
        if running { return addresses.isEmpty ? "运行中 · 仅本机" : "运行中 · 局域网" }
        if pendingStart != nil { return "正在启动…" }
        return lastError == nil ? "服务已停止" : "已停止 · 出现错误"
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 610, height: 760), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
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
        label("启用局域网时，macOS 可能为内置 Remote Control Gateway 弹出入站连接确认。这是系统防火墙确认，应用无法代为点击；仅在可信网络允许。", 12)
        label("3 · 启动与连接", 16, bold: true)
        lan.target = self
        lan.action = #selector(toggleLanFromWindow)
        lan.state = lanEnabled ? .on : .off
        stack.addArrangedSubview(lan)
        login.target = self
        login.action = #selector(toggleLoginFromWindow)
        stack.addArrangedSubview(login)
        start = button("启动服务", #selector(startService))
        stop = button("停止", #selector(stopService))
        browser = button("打开控制网页", #selector(openBrowser))
        row([start, stop, browser, button("查看日志", #selector(openLog))])
        stack.addArrangedSubview(status)
        status.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        label("应用只在菜单栏显示图标。关闭此窗口不会停止服务；从菜单栏图标选择“退出”才会停止。密码和权限就绪后，打开应用即自动启动服务。局域网仅适合可信私有网络；公网请使用 HTTPS / VPN。", 12)
        window.center()
    }

    @objc private func showWindow() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        refresh()
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
        catch { status.stringValue = "无法启动内置运行时：\(error.localizedDescription)"; showWindow() }
    }

    private func receive(_ data: Data) {
        output.append(data)
        while let index = output.firstIndex(of: 10) {
            let line = output.prefix(upTo: index)
            output.removeSubrange(...index)
            guard let state = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            ready = true
            configured = state["configured"] as? Bool ?? false
            running = state["running"] as? Bool ?? false
            logPath = state["logPath"] as? String
            addresses = state["addresses"] as? [String] ?? []
            lastError = state["error"] as? String
            if let error = lastError { status.stringValue = error; pendingStart = nil }
            else if running {
                status.stringValue = "运行中 · http://127.0.0.1:8787" + (addresses.isEmpty ? "\n仅本机访问" : "\n局域网：" + addresses.joined(separator: " · "))
            } else if let restart = pendingStart {
                // Network mode changed while running: the gateway stopped, now start it again.
                pendingStart = nil
                send(["action": "start", "lan": restart])
                status.stringValue = "正在启动…"
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

    private func canStart() -> Bool { configured && permissionsGranted && !running && controller != nil }

    @objc private func refresh() {
        let screen = CGPreflightScreenCaptureAccess(), accessibility = AXIsProcessTrusted()
        permissions.stringValue = "屏幕录制：\(screen ? "已授权" : "待授权")    ·    辅助功能：\(accessibility ? "已授权" : "待授权")"
        owner.stringValue = configured ? "已设置 · 保留现有访问密码与会话" : "尚未设置 · 密码仅保存在本机（Argon2id）"
        password.isEnabled = !configured
        confirmation.isEnabled = !configured
        save.isEnabled = !configured && controller != nil
        start.isEnabled = canStart()
        stop.isEnabled = running
        browser.isEnabled = running
        lan.state = lanEnabled ? .on : .off
        lan.isEnabled = controller != nil
        login.state = loginItemEnabled ? .on : .off
        statusItem?.button?.appearsDisabled = !running
        statusItem?.button?.toolTip = "Remote Control · " + summary()
        if wantsAutoStart && ready && canStart() && pendingStart == nil {
            wantsAutoStart = false
            beginStart()
        }
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

    private func beginStart() {
        start.isEnabled = false
        status.stringValue = "正在启动…"
        send(["action": "start", "lan": lanEnabled])
    }
    @objc private func startService() { wantsAutoStart = false; beginStart() }
    @objc private func stopService() { wantsAutoStart = false; pendingStart = nil; send(["action": "stop"]) }

    private func setLan(_ enabled: Bool) {
        if enabled && !lanEnabled {
            NSApplication.shared.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "允许局域网访问？"
            alert.informativeText = "HTTP 不加密，会传输密码、屏幕和输入。仅在可信私有网络启用，勿用于公共 Wi-Fi 或公网端口转发。此选择会被记住，之后自动启动时沿用。"
            alert.addButton(withTitle: "允许可信局域网")
            alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else { refresh(); return }
        }
        guard enabled != lanEnabled else { refresh(); return }
        lanEnabled = enabled
        if running {
            pendingStart = enabled
            status.stringValue = "正在切换网络模式…"
            send(["action": "stop"])
        }
        refresh()
    }
    @objc private func toggleLanFromWindow() { setLan(lan.state == .on) }
    @objc private func toggleLanFromMenu() { setLan(!lanEnabled) }

    private func setLoginItem(_ enabled: Bool) {
        let service = SMAppService.mainApp
        do {
            if enabled { try service.register() } else { try service.unregister() }
        } catch {
            NSApplication.shared.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = enabled ? "无法加入登录项" : "无法移除登录项"
            alert.informativeText = "\(error.localizedDescription)\n请确认应用已拖入“应用程序”文件夹后再试，或在 系统设置 › 通用 › 登录项 中手动调整。"
            alert.runModal()
        }
        if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        refresh()
    }
    @objc private func toggleLoginFromWindow() { setLoginItem(login.state == .on) }
    @objc private func toggleLoginFromMenu() { setLoginItem(!loginItemEnabled) }

    @objc private func openBrowser() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:8787")!) }
    @objc private func openLog() {
        if let logPath { NSWorkspace.shared.open(URL(fileURLWithPath: logPath).deletingLastPathComponent()) }
    }
    @objc private func quit() { NSApplication.shared.terminate(nil) }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        try? input?.fileHandleForWriting.close()
        if let controller, controller.isRunning { controller.waitUntilExit() }
    }
}
