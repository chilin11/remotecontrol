import AppKit
import Foundation
import ScreenCaptureKit
import VideoToolbox
import CoreMedia
import CoreGraphics
import ApplicationServices

private let codecName = CommandLine.arguments.dropFirst().first ?? "hevc"
private let qualityName = CommandLine.arguments.dropFirst(2).first ?? "1080p30"
// Local cursor: the browser draws the pointer itself, so keep it out of the video and report its shape.
private let localCursor = CommandLine.arguments.dropFirst(3).contains("local-cursor")
private let codecType: CMVideoCodecType = codecName == "h264" ? kCMVideoCodecType_H264 : kCMVideoCodecType_HEVC

private struct Quality {
    let width: Int
    let height: Int
    let fps: Int
    let bitrate: Int
}
private let quality: Quality = {
    // Older gateways/browsers may still pass the previous preset names.
    switch qualityName {
    case "720p30", "minimal", "low", "hotel", "data": return Quality(width: 1280, height: 720, fps: 30, bitrate: 4_000_000)
    case "1080p24", "balanced24": return Quality(width: 1920, height: 1080, fps: 24, bitrate: 6_000_000)
    case "1080p60": return Quality(width: 1920, height: 1080, fps: 60, bitrate: 12_000_000)
    case "2160p24", "high15": return Quality(width: 3840, height: 2160, fps: 24, bitrate: 16_000_000)
    case "2160p30", "high": return Quality(width: 3840, height: 2160, fps: 30, bitrate: 20_000_000)
    case "2160p60": return Quality(width: 3840, height: 2160, fps: 60, bitrate: 35_000_000)
    default: return Quality(width: 1920, height: 1080, fps: 30, bitrate: 8_000_000)
    }
}()

/// Lowest HEVC Main-tier level (general_level_idc 150/153/156 = 5.0/5.1/5.2) covering the frame size, sample rate
/// and the target bitrate (MaxBR 25/40/60 Mbps). VideoToolbox's AutoLevel picks the real level; this is the declared one.
private func hevcLevel(_ width: Int, _ height: Int, _ fps: Int) -> Int {
    let samples = width * height
    if samples <= 8_912_896 && samples * fps <= 267_386_880 && quality.bitrate <= 25_000_000 { return 150 }
    if samples <= 8_912_896 && samples * fps <= 534_773_760 && quality.bitrate <= 40_000_000 { return 153 }
    return 156
}

/// Lowest H.264 level (level_idc 50/51/52) for the stream, from Table A-1 MaxFS/MaxMBPS.
private func h264Level(_ width: Int, _ height: Int, _ fps: Int) -> Int {
    let macroblocks = ((width + 15) / 16) * ((height + 15) / 16)
    if macroblocks <= 22_080 && macroblocks * fps <= 589_824 { return 50 }
    if macroblocks <= 36_864 && macroblocks * fps <= 983_040 { return 51 }
    return 52
}

final class PacketWriter {
    private let lock = NSLock()
    func send(type: UInt8, data: Data) {
        guard data.count < 16 * 1024 * 1024 else { return }
        var packet = Data([type])
        var size = UInt32(data.count).bigEndian
        withUnsafeBytes(of: &size) { packet.append(contentsOf: $0) }
        packet.append(data)
        lock.lock()
        FileHandle.standardOutput.write(packet)
        lock.unlock()
    }
    func json(_ value: [String: Any], type: UInt8 = 1) {
        if let data = try? JSONSerialization.data(withJSONObject: value) { send(type: type, data: data) }
    }
}

final class Agent: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let writer = PacketWriter()
    var stream: SCStream?
    var encoder: VTCompressionSession?
    var displayBounds = CGRect.zero
    var lastMouse = CGPoint.zero
    var width = 0
    var height = 0
    var pressedKeys = Set<CGKeyCode>()
    var pressedButtons = Set<String>()
    var lastClickTime: TimeInterval = 0
    var lastClickPoint = CGPoint.zero
    var lastClickButton = ""
    var clickCount: Int64 = 1
    var clickDragged = false
    var pressPoint = CGPoint.zero
    // Capture-queue state: the newest screen image, so a keyframe can be produced even while the screen is still
    // (ScreenCaptureKit delivers no frames then, and the keyframe interval counts frames, not time).
    let captureQueue = DispatchQueue(label: "remotecontrol.capture")
    private var lastImage: CVImageBuffer?
    private var lastPTS = CMTime.invalid
    private var lastEncodedAt: TimeInterval = 0
    private var forceKeyframe = false

    func start() async throws {
        guard codecName == "hevc" || codecName == "h264" else { throw NSError(domain: "RemoteControl", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unsupported codec"]) }
        if !AXIsProcessTrusted() { throw NSError(domain: "RemoteControl", code: 2, userInfo: [NSLocalizedDescriptionKey: "Grant Remote Control Agent Accessibility permission in System Settings, then reconnect"]) }
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
            throw NSError(domain: "RemoteControl", code: 3, userInfo: [NSLocalizedDescriptionKey: "Grant Remote Control Agent Screen Recording permission, then reconnect"])
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { throw NSError(domain: "RemoteControl", code: 3, userInfo: [NSLocalizedDescriptionKey: "No display is available"]) }
        displayBounds = CGDisplayBounds(CGDirectDisplayID(display.displayID))
        // Retina displays expose logical dimensions through SCDisplay and CGDisplayPixelsWide.
        // Use the active display mode's physical pixel dimensions for sharper capture.
        let displayMode = CGDisplayCopyDisplayMode(CGDirectDisplayID(display.displayID))
        let pixelWidth = displayMode?.pixelWidth ?? display.width
        let pixelHeight = displayMode?.pixelHeight ?? display.height
        guard pixelWidth >= 2, pixelHeight >= 2 else { throw NSError(domain: "RemoteControl", code: 3, userInfo: [NSLocalizedDescriptionKey: "Display pixel dimensions are unavailable"]) }
        // Fit inside the preset's resolution box (e.g. 1920×1080) without upscaling, keeping the aspect ratio.
        let ratio = min(1.0, min(Double(quality.width) / Double(pixelWidth), Double(quality.height) / Double(pixelHeight)))
        width = max(2, (Int(Double(pixelWidth) * ratio) / 2) * 2)
        height = max(2, (Int(Double(pixelHeight) * ratio) / 2) * 2)
        try makeEncoder()
        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(quality.fps))
        // One surface stays held as `lastImage`; the extra slot keeps it from starving capture.
        config.queueDepth = 4
        config.showsCursor = !localCursor
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
        self.stream = stream
        let codecString = codecName == "hevc" ? "hvc1.1.6.L\(hevcLevel(width, height, quality.fps)).B0" : String(format: "avc1.42E0%02X", h264Level(width, height, quality.fps))
        writer.json(["type": "stream", "codec": codecName, "codecString": codecString, "width": width, "height": height, "fps": quality.fps])
        try await stream.startCapture()
        DispatchQueue.global(qos: .userInteractive).async { self.readInput() }
        if localCursor { startCursorUpdates() }
    }

    private var cursorTimer: DispatchSourceTimer?
    private var lastCursorSignature: Int?

    /// Polls the system cursor (AppKit, so on the main queue) and sends its shape when it changes.
    private func startCursorUpdates() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(20), leeway: .milliseconds(4))
        timer.setEventHandler { [weak self] in self?.sendCursorIfChanged() }
        timer.resume()
        cursorTimer = timer
    }

    private func sendCursorIfChanged() {
        guard let cursor = NSCursor.currentSystem else { return }
        let size = cursor.image.size
        guard size.width >= 1, size.height >= 1, size.width <= 128, size.height <= 128 else { return }
        // Render at 2x so the browser can show it sharply on Retina screens; the bitmap doubles as the change signature.
        let scale = 2.0
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int((size.width * scale).rounded()), pixelsHigh: Int((size.height * scale).rounded()), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 32), let pixels = rep.bitmapData else { return }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        cursor.image.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        var hasher = Hasher()
        hasher.combine(bytes: UnsafeRawBufferPointer(start: pixels, count: rep.bytesPerRow * rep.pixelsHigh))
        hasher.combine(cursor.hotSpot.x)
        hasher.combine(cursor.hotSpot.y)
        let signature = hasher.finalize()
        guard signature != lastCursorSignature, let png = rep.representation(using: .png, properties: [:]) else { return }
        lastCursorSignature = signature
        // hotSpot is measured from the top-left corner in points, which is what CSS expects.
        writer.json(["type": "cursor", "image": "data:image/png;base64," + png.base64EncodedString(), "x": Double(cursor.hotSpot.x), "y": Double(cursor.hotSpot.y), "scale": scale])
    }

    private func makeEncoder() throws {
        var created: VTCompressionSession?
        let ref = Unmanaged.passUnretained(self).toOpaque()
        let hardware: CFDictionary = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true] as CFDictionary
        let status = VTCompressionSessionCreate(allocator: kCFAllocatorDefault, width: Int32(width), height: Int32(height), codecType: codecType, encoderSpecification: hardware, imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: { refcon, _, status, _, buffer in
            guard status == noErr, let refcon, let buffer else { return }
            Unmanaged<Agent>.fromOpaque(refcon).takeUnretainedValue().writeEncoded(buffer)
        }, refcon: ref, compressionSessionOut: &created)
        guard status == noErr, let created else { throw NSError(domain: "RemoteControl", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Video encoder could not start"]) }
        encoder = created
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AverageBitRate, value: quality.bitrate as CFNumber)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: quality.fps as CFNumber)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: quality.fps as CFNumber)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        // Emit every frame as soon as it is encoded instead of holding frames for rate-control lookahead.
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: 0 as CFNumber)
        let profile = codecName == "hevc" ? kVTProfileLevel_HEVC_Main_AutoLevel : kVTProfileLevel_H264_Baseline_AutoLevel
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ProfileLevel, value: profile)
        VTCompressionSessionPrepareToEncodeFrames(created)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid, let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastImage = image
        encode(image, at: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
    }

    /// Capture queue only.
    private func encode(_ image: CVImageBuffer, at time: CMTime) {
        guard let encoder else { return }
        // VideoToolbox needs increasing timestamps; a re-encoded frame can land just after a captured one.
        var pts = time
        if lastPTS.isValid && pts <= lastPTS { pts = lastPTS + CMTime(value: 1, timescale: 1000) }
        lastPTS = pts
        lastEncodedAt = ProcessInfo.processInfo.systemUptime
        let properties: CFDictionary? = forceKeyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary : nil
        forceKeyframe = false
        VTCompressionSessionEncodeFrame(encoder, imageBuffer: image, presentationTimeStamp: pts, duration: .invalid, frameProperties: properties, sourceFrameRefcon: nil, infoFlagsOut: nil)
    }

    /// The gateway or browser dropped frames and waits for a keyframe: encode the newest image as one now.
    private func requestKeyframe() {
        captureQueue.async {
            self.forceKeyframe = true
            guard let image = self.lastImage, self.lastPTS.isValid else { return }
            // Advance the timestamp by the real time since the last frame so rate control sees the true gap.
            let elapsed = max(1.0 / Double(quality.fps), ProcessInfo.processInfo.systemUptime - self.lastEncodedAt)
            self.encode(image, at: self.lastPTS + CMTime(seconds: elapsed, preferredTimescale: 90_000))
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        writer.json(["type": "error", "message": error.localizedDescription], type: 3)
        exit(1)
    }

    private func writeEncoded(_ sample: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr, let pointer else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let keyframe = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool != true
        var bytes = Data([keyframe ? 1 : 0])
        if keyframe, let format = CMSampleBufferGetFormatDescription(sample) {
            let count = codecName == "hevc" ? 3 : 2
            for index in 0..<count {
                var parameter: UnsafePointer<UInt8>?
                var size = 0
                let status: OSStatus
                if codecName == "hevc" {
                    status = CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &parameter, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
                } else {
                    status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &parameter, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
                }
                if status == noErr, let parameter { bytes.append(contentsOf: [0, 0, 0, 1]); bytes.append(parameter, count: size) }
            }
        }
        let raw = UnsafeRawBufferPointer(start: pointer, count: length)
        var offset = 0
        while offset + 4 <= length {
            let size = (Int(raw[offset]) << 24) | (Int(raw[offset + 1]) << 16) | (Int(raw[offset + 2]) << 8) | Int(raw[offset + 3])
            offset += 4
            guard size > 0, offset + size <= length else { return }
            bytes.append(contentsOf: [0, 0, 0, 1])
            bytes.append(contentsOf: raw[offset..<(offset + size)])
            offset += size
        }
        writer.send(type: 2, data: bytes)
    }

    private func readInput() {
        while let line = readLine() {
            guard let data = line.data(using: .utf8), let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = event["type"] as? String else { continue }
            switch type {
            case "move":
                guard let x = event["x"] as? Double, let y = event["y"] as? Double else { continue }
                let point = CGPoint(x: displayBounds.minX + min(max(x, 0), 1) * displayBounds.width, y: displayBounds.minY + min(max(y, 0), 1) * displayBounds.height)
                lastMouse = point
                let mouseType: CGEventType
                let mouseButton: CGMouseButton
                if pressedButtons.contains("right") { mouseType = .rightMouseDragged; mouseButton = .right }
                else if pressedButtons.contains("left") { mouseType = .leftMouseDragged; mouseButton = .left }
                else { mouseType = .mouseMoved; mouseButton = .left }
                if !pressedButtons.isEmpty && hypot(point.x - pressPoint.x, point.y - pressPoint.y) > 5 { clickDragged = true }
                CGEvent(mouseEventSource: nil, mouseType: mouseType, mouseCursorPosition: point, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
            case "button":
                guard let button = event["button"] as? String, let down = event["down"] as? Bool else { continue }
                guard button == "left" || button == "right" else { continue }
                let right = button == "right"
                let now = ProcessInfo.processInfo.systemUptime
                if down {
                    clickCount = button == lastClickButton && now - lastClickTime < 0.5 && hypot(lastMouse.x - lastClickPoint.x, lastMouse.y - lastClickPoint.y) < 6 ? 2 : 1
                    clickDragged = false
                    pressPoint = lastMouse
                    pressedButtons.insert(button)
                } else {
                    pressedButtons.remove(button)
                    if !clickDragged { lastClickButton = button; lastClickTime = now; lastClickPoint = lastMouse }
                    else { lastClickButton = "" }
                }
                let kind: CGEventType = right ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .leftMouseDown : .leftMouseUp)
                if let mouse = CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: lastMouse, mouseButton: right ? .right : .left) {
                    mouse.setIntegerValueField(.mouseEventClickState, value: clickCount)
                    mouse.post(tap: .cghidEventTap)
                }
            case "wheel":
                guard let dy = event["dy"] as? Int else { continue }
                CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(max(-1000, min(1000, -dy))), wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
            case "key":
                guard let code = event["code"] as? String, let down = event["down"] as? Bool, let keyCode = Self.keyCodes[code] else { continue }
                if down { pressedKeys.insert(keyCode) } else { pressedKeys.remove(keyCode) }
                if let key = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down) {
                    key.flags = (event["fn"] as? Bool == true ? key.flags.union(.maskSecondaryFn) : key.flags.subtracting(.maskSecondaryFn))
                    key.post(tap: .cghidEventTap)
                }
            case "text":
                guard let text = event["text"] as? String, text.count <= 32 else { continue }
                for scalar in text.unicodeScalars {
                    let units = Array(String(scalar).utf16)
                    for down in [true, false] {
                        if let key = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) {
                            key.flags = key.flags.subtracting(.maskSecondaryFn)
                            units.withUnsafeBufferPointer { buffer in
                                if let characters = buffer.baseAddress {
                                    key.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: characters)
                                }
                            }
                            key.post(tap: .cghidEventTap)
                        }
                    }
                }
            case "keyframe":
                requestKeyframe()
            default: break
            }
        }
        for code in pressedKeys {
            if let key = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
                key.flags = key.flags.subtracting(.maskSecondaryFn)
                key.post(tap: .cghidEventTap)
            }
        }
        for button in pressedButtons {
            let right = button == "right"
            CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: lastMouse, mouseButton: right ? .right : .left)?.post(tap: .cghidEventTap)
        }
        exit(0)
    }

    private static let keyCodes: [String: CGKeyCode] = [
        "KeyA":0,"KeyS":1,"KeyD":2,"KeyF":3,"KeyH":4,"KeyG":5,"KeyZ":6,"KeyX":7,"KeyC":8,"KeyV":9,"KeyB":11,"KeyQ":12,"KeyW":13,"KeyE":14,"KeyR":15,"KeyY":16,"KeyT":17,"Digit1":18,"Digit2":19,"Digit3":20,"Digit4":21,"Digit6":22,"Digit5":23,"Equal":24,"Digit9":25,"Digit7":26,"Minus":27,"Digit8":28,"Digit0":29,"BracketRight":30,"KeyO":31,"KeyU":32,"BracketLeft":33,"KeyI":34,"KeyP":35,"Enter":36,"KeyL":37,"KeyJ":38,"Quote":39,"KeyK":40,"Semicolon":41,"Backslash":42,"Comma":43,"Slash":44,"KeyN":45,"KeyM":46,"Period":47,"Tab":48,"Space":49,"Backquote":50,"Backspace":51,"Escape":53,"MetaLeft":55,"ShiftLeft":56,"CapsLock":57,"AltLeft":58,"ControlLeft":59,"ShiftRight":60,"AltRight":61,"ControlRight":62,"MetaRight":54,"F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111,"Home":115,"PageUp":116,"Delete":117,"End":119,"PageDown":121,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126
    ]
}

@main struct Main {
    @MainActor static func main() async {
        if CommandLine.arguments.count == 1 || CommandLine.arguments.contains("--desktop") {
            DesktopHost.launch()
            return
        }
        // Capture is a headless child of the desktop host, never a second Dock app.
        NSApplication.shared.setActivationPolicy(.prohibited)
        let agent = Agent()
        do {
            try await agent.start()
            while true { try await Task.sleep(for: .seconds(3600)) }
        } catch {
            agent.writer.json(["type": "error", "message": error.localizedDescription], type: 3)
            exit(1)
        }
    }
}
