import Foundation
import AppKit
import ScreenCaptureKit
import ApplicationServices
import CanaveralVMCore

@MainActor final class MacDesktopDevice: GuestDesktopDevice, GuestStreamDevice {
    private let inputStateURL: URL?
    private var streamGeometry: MacInputGeometry?
    private var input: GuestDisplayInput<MacInputBackend>?
    init(inputStateURL: URL? = nil) { self.inputStateURL=inputStateURL }
    private func inputController(requireState: Bool = false) throws -> GuestDisplayInput<MacInputBackend> {
        guard Self.isVirtualGuest, let inputStateURL else { throw CanaveralError.unavailable("Guest stream input state is unavailable.") }
        if let input { return input }
        let journal=try GuestInputStateJournal(inputStateURL)
        let backend=MacInputBackend { [weak self] in
            guard let geometry=self?.streamGeometry else { throw CanaveralError.unavailable("Guest stream capture geometry is unavailable.") }
            return geometry
        }
        let recovered=try journal.read()
        guard !requireState || recovered != nil else { throw CanaveralError.unavailable("Held-input recovery evidence is missing; reset cannot be confirmed.") }
        let controller=try GuestDisplayInput(backend:backend,recovered:recovered,save:journal.save)
        input=controller; return controller
    }
    private func refuseHeldStreamInput() throws {
        guard Self.isVirtualGuest else { throw CanaveralError.unavailable("Input runs only inside a virtual guest.") }
        if inputStateURL != nil {
            let state=try inputController().state
            guard !state.held, !state.uncertain else { throw CanaveralError.unavailable("Reset owned stream input before legacy input.") }
        }
    }
    func captureStream() async throws -> GuestStreamFrame { try await captureBoundFrame() }
    func performStream(_ event: GuestStreamEvent, frame: GuestStreamFrameBinding, expiresAt: Double) async throws {
        guard Self.isVirtualGuest, expiresAt.isFinite, NativeLeaseClock.now() < expiresAt else { throw CanaveralError.unavailable("Guest input frame expired.") }
        try frame.validate()
        streamGeometry = .init(displayID:frame.displayID,bounds:CGRect(x:frame.bounds.x,y:frame.bounds.y,width:frame.bounds.width,height:frame.bounds.height),expiresAt:expiresAt)
        let controller=try inputController()
        switch event {
        case let .key(keysym,down): try controller.key(keysym:keysym,down:down)
        case let .pointer(x,y,buttons):
            guard (0..<frame.width).contains(x), (0..<frame.height).contains(y) else { throw CanaveralError.invalid("Pointer is outside the captured guest frame.") }
            try controller.pointer(mask:buttons,point:.init(x:Double(x)/Double(max(1,frame.width-1)),y:Double(y)/Double(max(1,frame.height-1))))
        case let .text(text): try controller.text(text)
        }
    }
    func requireNeutralStreamInput() async throws {
        guard Self.isVirtualGuest else { throw GuestStreamRefusal.unsupported }
        let state=try inputController().state
        if state.uncertain { throw GuestStreamRefusal.resetUncertain }
        guard !state.held else { throw GuestStreamRefusal.busy }
    }
    func performSemantic(_ action: GuestStreamSemanticAction, frame: GuestStreamFrameBinding?, expiresAt: Double?) async throws {
        try await requireNeutralStreamInput()
        if case let .accessibility(request,snapshot)=action {
            try await performAccessibility(request,expected:snapshot); return
        }
        guard let frame, let expiresAt else { throw GuestStreamRefusal.stale }
        switch action {
        case let .tap(x,y):
            try await performStream(.pointer(x:x,y:y,buttons:1),frame:frame,expiresAt:expiresAt)
            try await performStream(.pointer(x:x,y:y,buttons:0),frame:frame,expiresAt:expiresAt)
        case let .text(text): try await performStream(.text(text),frame:frame,expiresAt:expiresAt)
        case let .keys(keys):
            for key in keys { try await performStream(.key(keysym:key,down:true),frame:frame,expiresAt:expiresAt) }
            for key in keys.reversed() { try await performStream(.key(keysym:key,down:false),frame:frame,expiresAt:expiresAt) }
        case .accessibility: break
        }
    }
    func resetStreamInput(requireState: Bool) async throws {
        guard Self.isVirtualGuest else { throw CanaveralError.unavailable("Input reset runs only inside a virtual guest.") }
        streamGeometry = .init(displayID:CGMainDisplayID(),bounds:CGDisplayBounds(CGMainDisplayID()))
        try inputController(requireState:requireState).reset()
    }
    private lazy var accessibility = GuestAccessibilityTree(backend: MacAccessibilityBackend())
    func inspectAccessibility() async throws -> GuestAccessibilitySnapshot {
        guard Self.isVirtualGuest else { throw CanaveralError.unavailable("Native accessibility runs only inside a virtual guest.") }
        return try accessibility.inspect()
    }
    func performAccessibility(_ action: GuestAccessibilityAction, expected: GuestAccessibilitySnapshot) async throws {
        guard Self.isVirtualGuest else { throw CanaveralError.unavailable("Native accessibility actions run only inside a virtual guest.") }
        try refuseHeldStreamInput()
        try accessibility.perform(action,expected:expected)
    }
    nonisolated static var isVirtualGuest: Bool {
        var value: Int32 = 0; var length = MemoryLayout<Int32>.size
        return sysctlbyname("kern.hv_vmm_present", &value, &length, nil, 0) == 0 && value == 1
    }
    func capture() async throws -> DesktopFrame { try await captureBoundFrame().frame }
    private func captureBoundFrame() async throws -> GuestStreamFrame {
        guard Self.isVirtualGuest else { throw CanaveralError.unavailable("The desktop helper runs only inside a virtual guest.") }
        guard CGPreflightScreenCaptureAccess() else { throw CanaveralError.unavailable("Allow Screen Recording for Canaveral Guest in this VM's System Settings.") }
        let identity=CGMainDisplayID(), bounds=CGDisplayBounds(CGMainDisplayID())
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == identity }) else { throw CanaveralError.unavailable("Guest display unavailable.") }
        let config = SCStreamConfiguration()
        let scale = min(1, 1440.0 / Double(display.width))
        config.width = max(1, Int(Double(display.width) * scale)); config.height = max(1, Int(Double(display.height) * scale))
        config.showsCursor = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: config)
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw CanaveralError.unavailable("Guest screenshot encoding failed.") }
        guard CGMainDisplayID() == identity, CGDisplayBounds(identity) == bounds else { throw CanaveralError.unavailable("Guest display changed during capture.") }
        return .init(frame:DesktopFrame(width:image.width,height:image.height,pngBase64:data.base64EncodedString()),displayID:identity,bounds:.init(x:bounds.minX,y:bounds.minY,width:bounds.width,height:bounds.height))
    }
    func perform(_ action: DesktopAction) async throws {
        guard Self.isVirtualGuest, AXIsProcessTrusted() else { throw CanaveralError.unavailable("Allow Accessibility for Canaveral Guest inside the VM.") }
        try refuseHeldStreamInput()
        try action.validate(); try Task.checkCancellation()
        switch action.kind {
        case .click:
            let bounds = CGDisplayBounds(CGMainDisplayID())
            let point = CGPoint(x: bounds.minX + action.x! * max(0, bounds.width - 1), y: bounds.minY + action.y! * max(0, bounds.height - 1))
            guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left), let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { throw CanaveralError.unavailable("Could not create guest pointer events.") }
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        case .typeText:
            let text = Array(action.text!.utf16)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { throw CanaveralError.unavailable("Could not create guest text events.") }
            down.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
            up.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        case .key:
            let components = action.key!.lowercased().split(separator: "+").map(String.init)
            let keys: [String: CGKeyCode] = ["a": 0, "c": 8, "v": 9, "x": 7, "z": 6, "l": 37, "w": 13, "q": 12, "return": 36, "tab": 48, "space": 49, "escape": 53, "delete": 51, "left": 123, "right": 124, "up": 126, "down": 125]
            guard let last = components.last, let code = keys[last], Set(components.dropLast()).isSubset(of: ["cmd", "ctrl", "shift", "alt"]) else { throw CanaveralError.invalid("Unsupported guest shortcut.") }
            var flags = CGEventFlags()
            for modifier in components.dropLast() { switch modifier { case "cmd": flags.insert(.maskCommand); case "ctrl": flags.insert(.maskControl); case "shift": flags.insert(.maskShift); case "alt": flags.insert(.maskAlternate); default: break } }
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw CanaveralError.unavailable("Could not create guest keyboard events.") }
            down.flags = flags; up.flags = flags; down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        case .scroll:
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(action.delta!), wheel2: 0, wheel3: 0) else { throw CanaveralError.unavailable("Could not create guest scroll event.") }
            event.post(tap: .cghidEventTap)
        }
    }
}
