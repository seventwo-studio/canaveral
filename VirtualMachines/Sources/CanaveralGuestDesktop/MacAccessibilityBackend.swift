import Foundation
import AppKit
import ApplicationServices
import CanaveralVMCore

/// All AX calls are guest-only and stay on the guest helper's main actor.
@MainActor final class MacAccessibilityBackend: GuestAccessibilityBackend {
    typealias Element = AXUIElement
    private var deadline = 0.0
    private var applications: [pid_t: String] = [:]
    private var launches: [pid_t: Double] = [:]
    private func permitted() throws {
        guard MacDesktopDevice.isVirtualGuest else { throw CanaveralError.unavailable("Native accessibility runs only inside a virtual guest.") }
        guard AXIsProcessTrusted() else { throw CanaveralError.unavailable("Allow Accessibility for Canaveral Guest inside this VM.") }
    }
    private func budget() throws {
        try Task.checkCancellation()
        guard NativeLeaseClock.now() < deadline else { throw CanaveralError.unavailable("Native accessibility inspection budget ended.") }
    }
    func roots() throws -> [AXUIElement] {
        try permitted(); deadline = NativeLeaseClock.now()+3; applications.removeAll(); launches.removeAll()
        let system = AXUIElementCreateSystemWide()
        guard AXUIElementSetMessagingTimeout(system,0.1) == .success else { throw CanaveralError.unavailable("Native accessibility timeout is unavailable.") }
        return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy != .prohibited }
            .sorted { $0.processIdentifier < $1.processIdentifier }.map { application in
                applications[application.processIdentifier] = application.bundleIdentifier ?? ""
                launches[application.processIdentifier] = application.launchDate?.timeIntervalSince1970
                return AXUIElementCreateApplication(application.processIdentifier)
            }
    }
    private func value(_ element: AXUIElement, _ key: String) throws -> CFTypeRef? {
        try budget()
        var result: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element,key as CFString,&result)
        if status == .invalidUIElement || status == .cannotComplete { throw CanaveralError.unavailable("A native accessibility element is unavailable.") }
        return status == .success ? result : nil
    }
    private func text(_ element: AXUIElement, _ key: String) throws -> String {
        guard let result = try value(element,key) as? String else { return "" }
        return String(result.prefix(2000))
    }
    private func scalar(_ value: CFTypeRef) -> JSONValue? {
        if CFGetTypeID(value) == CFBooleanGetTypeID(), let number = value as? NSNumber { return .bool(number.boolValue) }
        if let text = value as? String { return .string(String(text.prefix(2000))) }
        if let number = value as? NSNumber, number.doubleValue.isFinite { return .number(number.doubleValue) }
        if let url = value as? URL { return .string(String(url.absoluteString.prefix(2000))) }
        return nil
    }
    private func bounds(_ element: AXUIElement) throws -> GuestAccessibilityBounds? {
        guard let position = try value(element,kAXPositionAttribute), let size = try value(element,kAXSizeAttribute),
              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue,.cgPoint,&point), AXValueGetValue(size as! AXValue,.cgSize,&dimensions) else { return nil }
        let result = GuestAccessibilityBounds(x:Double(point.x),y:Double(point.y),width:Double(dimensions.width),height:Double(dimensions.height))
        return result.valid ? result : nil
    }
    func attributes(_ element: AXUIElement) throws -> GuestAccessibilityAttributes {
        let role = try text(element,kAXRoleAttribute)
        guard !role.isEmpty else { throw CanaveralError.unavailable("Native accessibility role is unavailable.") }
        let subrole = try text(element,kAXSubroleAttribute)
        let secure = subrole == kAXSecureTextFieldSubrole || role == kAXSecureTextFieldSubrole
        let identifier = try text(element,kAXIdentifierAttribute)
        var properties: [String:JSONValue] = ["AXRole":.string(role),"AXSubrole":.string(subrole),"AXIdentifier":.string(identifier)]
        var states: [String:Bool] = ["password":secure]
        for (key,attribute) in [("enabled",kAXEnabledAttribute),("focused",kAXFocusedAttribute),("selected",kAXSelectedAttribute),("expanded",kAXExpandedAttribute)] {
            if let number = try value(element,attribute) as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() { states[key] = number.boolValue }
        }
        var pid: pid_t = 0
        if AXUIElementGetPid(element,&pid) == .success {
            properties["processId"] = .number(Double(pid)); properties["applicationIdentifier"] = .string(applications[pid] ?? "")
            if let started=launches[pid], started.isFinite { properties["processStartedAt"] = .number(started) }
        }
        try budget()
        var names: CFArray?
        if AXUIElementCopyAttributeNames(element,&names) == .success, let names = names as? [String] {
            let allowed = Array(names.sorted().prefix(128))
            properties["availableAttributes"] = .array(allowed.map { .string(String($0.prefix(200))) })
            if !secure {
                let relationships: Set<String> = [kAXChildrenAttribute,kAXParentAttribute,kAXWindowsAttribute,kAXTopLevelUIElementAttribute,kAXWindowAttribute,kAXContentsAttribute]
                for name in allowed where !relationships.contains(name) {
                    if let raw = try value(element,name), let encoded = scalar(raw) { properties[name] = encoded }
                }
            }
        }
        let frame = try bounds(element)
        try budget()
        var native: CFArray?, actions: [String] = []
        if AXUIElementCopyActionNames(element,&native) == .success, let names = native as? [String] {
            let raw = Array(Set(names.filter { !$0.isEmpty && $0.utf8.count <= 200 })).sorted().prefix(128)
            properties["nativeActions"] = .array(raw.map { .string($0) })
            if states["enabled"] == true, let frame, frame.width > 0, frame.height > 0 {
                actions = Array(Set(raw.map { $0 == kAXPressAction ? "click" : $0 })).sorted()
            }
        }
        let label: String
        if secure { label = "[redacted]" }
        else {
            let title = try text(element,kAXTitleAttribute)
            label = title.isEmpty ? try text(element,kAXDescriptionAttribute) : title
        }
        return .init(role:role,name:label,identifier:identifier,states:states,actions:actions,bounds:frame,properties:properties)
    }
    func children(_ element: AXUIElement, limit: Int) throws -> (elements:[AXUIElement],truncated:Bool) {
        try budget()
        var count: CFIndex = 0
        let status = AXUIElementGetAttributeValueCount(element,kAXChildrenAttribute as CFString,&count)
        if status == .attributeUnsupported || status == .noValue { return ([],false) }
        guard status == .success, count >= 0 else { throw CanaveralError.unavailable("Native accessibility children are unavailable.") }
        let amount = min(count,limit)
        if amount == 0 { return ([],count > 0) }
        try budget()
        var raw: CFArray?
        guard AXUIElementCopyAttributeValues(element,kAXChildrenAttribute as CFString,0,amount,&raw) == .success,
              let children = raw as? [AXUIElement] else { throw CanaveralError.unavailable("Native accessibility child capture failed.") }
        return (children,count > amount)
    }
    func hash(_ element: AXUIElement) -> Int { Int(truncatingIfNeeded:CFHash(element)) }
    func same(_ first: AXUIElement, _ second: AXUIElement) -> Bool { CFEqual(first,second) }
    func perform(_ element: AXUIElement, action: String) throws {
        try permitted(); try Task.checkCancellation()
        let native = action == "click" ? kAXPressAction : action
        // The tree revalidates the reported native action and full ancestor chain.
        guard AXUIElementPerformAction(element,native as CFString) == .success else {
            throw CanaveralError.unavailable("Native action was not confirmed; inspect before issuing another effect.")
        }
    }
}
