import Foundation
import ApplicationServices
import Carbon
import CanaveralVMCore

struct MacInputGeometry {
    let displayID: CGDirectDisplayID
    let bounds: CGRect
    let expiresAt: Double?
    init(displayID: CGDirectDisplayID, bounds: CGRect, expiresAt: Double? = nil) { self.displayID=displayID; self.bounds=bounds; self.expiresAt=expiresAt }
}

/// Native posting only. The bridge supplies scoped ownership, frame geometry and durable state.
@MainActor final class MacInputBackend: GuestInputBackend {
    private let geometry: () throws -> MacInputGeometry
    init(geometry: @escaping () throws -> MacInputGeometry) { self.geometry=geometry }
    private func current(_ value: MacInputGeometry) -> Bool {
        value.displayID == CGMainDisplayID() && CGDisplayBounds(value.displayID) == value.bounds &&
        (value.expiresAt.map { $0.isFinite && NativeLeaseClock.now() < $0 } ?? true)
    }
    private func authorize() throws {
        guard MacDesktopDevice.isVirtualGuest, AXIsProcessTrusted() else {
            throw CanaveralError.unavailable("Native input requires an authorized virtual guest and existing Accessibility permission.")
        }
    }
    private static let special: [UInt32:UInt16]=[
        0xff08:UInt16(kVK_Delete),0xff09:UInt16(kVK_Tab),0xff0d:UInt16(kVK_Return),0xff1b:UInt16(kVK_Escape),
        0xffff:UInt16(kVK_ForwardDelete),0xff50:UInt16(kVK_Home),0xff57:UInt16(kVK_End),0xff55:UInt16(kVK_PageUp),0xff56:UInt16(kVK_PageDown),
        0xff51:UInt16(kVK_LeftArrow),0xff52:UInt16(kVK_UpArrow),0xff53:UInt16(kVK_RightArrow),0xff54:UInt16(kVK_DownArrow),
        0xffe1:UInt16(kVK_Shift),0xffe2:UInt16(kVK_RightShift),0xffe3:UInt16(kVK_Control),0xffe4:UInt16(kVK_RightControl),
        0xffe9:UInt16(kVK_Option),0xffea:UInt16(kVK_RightOption),0xffe7:UInt16(kVK_Command),0xffe8:UInt16(kVK_RightCommand),
        0xffeb:UInt16(kVK_Command),0xffec:UInt16(kVK_RightCommand),0xff63:UInt16(kVK_Help),
        0xff8d:UInt16(kVK_ANSI_KeypadEnter),0xffaa:UInt16(kVK_ANSI_KeypadMultiply),0xffab:UInt16(kVK_ANSI_KeypadPlus),
        0xffad:UInt16(kVK_ANSI_KeypadMinus),0xffae:UInt16(kVK_ANSI_KeypadDecimal),0xffaf:UInt16(kVK_ANSI_KeypadDivide),
        0xffbd:UInt16(kVK_ANSI_KeypadEquals),0xff7f:UInt16(kVK_ANSI_KeypadClear),
    ]
    func resolve(keysym: UInt32, modifiers: GuestInputModifiers) throws -> GuestInputKey {
        try authorize()
        if let code=Self.special[keysym] { return .init(keysym:keysym,code:code) }
        let functions: [UInt16]=[UInt16(kVK_F1),UInt16(kVK_F2),UInt16(kVK_F3),UInt16(kVK_F4),UInt16(kVK_F5),UInt16(kVK_F6),UInt16(kVK_F7),UInt16(kVK_F8),UInt16(kVK_F9),UInt16(kVK_F10),UInt16(kVK_F11),UInt16(kVK_F12),UInt16(kVK_F13),UInt16(kVK_F14),UInt16(kVK_F15),UInt16(kVK_F16),UInt16(kVK_F17),UInt16(kVK_F18),UInt16(kVK_F19),UInt16(kVK_F20)]
        if (0xffbe...0xffd1).contains(keysym) { return .init(keysym:keysym,code:functions[Int(keysym-0xffbe)]) }
        let keypad: [UInt16]=[UInt16(kVK_ANSI_Keypad0),UInt16(kVK_ANSI_Keypad1),UInt16(kVK_ANSI_Keypad2),UInt16(kVK_ANSI_Keypad3),UInt16(kVK_ANSI_Keypad4),UInt16(kVK_ANSI_Keypad5),UInt16(kVK_ANSI_Keypad6),UInt16(kVK_ANSI_Keypad7),UInt16(kVK_ANSI_Keypad8),UInt16(kVK_ANSI_Keypad9)]
        if (0xffb0...0xffb9).contains(keysym) { return .init(keysym:keysym,code:keypad[Int(keysym-0xffb0)]) }
        let value: UInt32
        if (0x20...0x7e).contains(keysym) || (0xa0...0xff).contains(keysym) { value=keysym }
        else if keysym & 0xff000000 == 0x01000000 { value=keysym & 0x00ffffff }
        else { throw CanaveralError.invalid("Unsupported native keyboard keysym.") }
        guard let scalar=UnicodeScalar(value), !CharacterSet.controlCharacters.contains(scalar) else {
            throw CanaveralError.invalid("Unsupported native keyboard scalar.")
        }
        let text=String(scalar)
        if modifiers.intersection([.command,.control,.option]).isEmpty { return .init(keysym:keysym,code:0,unicode:text) }
        // Resolve shortcuts against this guest's active layout, rather than assuming ANSI labels.
        return .init(keysym:keysym,code:try physicalKey(text,modifiers:modifiers))
    }
    private func physicalKey(_ text: String, modifiers: GuestInputModifiers) throws -> UInt16 {
        guard let source=TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let property=TISGetInputSourceProperty(source,kTISPropertyUnicodeKeyLayoutData) else {
            throw CanaveralError.unavailable("Guest keyboard layout is unavailable for this shortcut.")
        }
        let data=Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()
        guard let bytes=CFDataGetBytePtr(data), CFDataGetLength(data) >= MemoryLayout<UCKeyboardLayout>.size else {
            throw CanaveralError.unavailable("Guest Unicode keyboard layout is unavailable.")
        }
        let layout=UnsafeRawPointer(bytes).assumingMemoryBound(to:UCKeyboardLayout.self)
        var flags=UInt32(0)
        if modifiers.contains(.shift) { flags|=UInt32(shiftKey) }
        if modifiers.contains(.option) { flags|=UInt32(optionKey) }
        for code: UInt16 in 0...127 {
            // Avoid treating modifier-only translations as ordinary printable keys.
            if [kVK_Shift,kVK_RightShift,kVK_Control,kVK_RightControl,kVK_Option,kVK_RightOption,kVK_Command,kVK_RightCommand,kVK_CapsLock,kVK_Function].contains(Int(code)) { continue }
            var dead: UInt32=0, length=0, output=[UniChar](repeating:0,count:16)
            let result=UCKeyTranslate(layout,code,UInt16(kUCKeyActionDown),flags>>8,UInt32(LMGetKbdType()),OptionBits(kUCKeyTranslateNoDeadKeysMask),&dead,output.count,&length,&output)
            if result == noErr, length > 0, length <= output.count,
               String(utf16CodeUnits:output,count:length) == text { return code }
        }
        throw CanaveralError.invalid("This shortcut cannot be resolved in the guest's active keyboard layout.")
    }
    private func flags(_ modifiers: GuestInputModifiers) -> CGEventFlags {
        var result=CGEventSource.flagsState(.combinedSessionState).intersection(.maskAlphaShift)
        if modifiers.contains(.shift) { result.insert(.maskShift) }
        if modifiers.contains(.control) { result.insert(.maskControl) }
        if modifiers.contains(.option) { result.insert(.maskAlternate) }
        if modifiers.contains(.command) { result.insert(.maskCommand) }
        return result
    }
    func post(_ values: [GuestNativeInput]) throws {
        try authorize(); try Task.checkCancellation()
        let display=try geometry(), rect=display.bounds
        guard current(display), [rect.minX,rect.minY,rect.width,rect.height].allSatisfy(\.isFinite), rect.width > 0, rect.height > 0,
              let source=CGEventSource(stateID:.hidSystemState), let cursor=CGEvent(source:nil)?.location else {
            throw CanaveralError.unavailable("Guest display input geometry is unavailable.")
        }
        func point(_ value: GuestInputPoint) throws -> CGPoint {
            guard value.valid else { throw CanaveralError.invalid("Invalid normalized native pointer position.") }
            return .init(x:rect.minX+value.x*max(0,rect.width-1),y:rect.minY+value.y*max(0,rect.height-1))
        }
        var events: [CGEvent]=[], position=cursor
        func append(_ event: CGEvent?, _ modifiers: GuestInputModifiers) throws {
            guard let event else { throw CanaveralError.unavailable("Guest native input construction failed.") }
            event.flags=flags(modifiers); events.append(event)
        }
        for value in values {
            switch value {
            case let .key(key,down,modifiers,repeated):
                guard key.valid, let event=CGEvent(keyboardEventSource:source,virtualKey:key.code,keyDown:down) else { throw CanaveralError.invalid("Invalid native keyboard event.") }
                if !key.modifier.isEmpty { event.type = .flagsChanged }
                event.setIntegerValueField(.keyboardEventAutorepeat,value:repeated ? 1 : 0)
                if let text=key.unicode { let units=Array(text.utf16); event.keyboardSetUnicodeString(stringLength:units.count,unicodeString:units) }
                try append(event,modifiers)
            case let .move(value,buttons,modifiers):
                position=try point(value)
                let button=buttons.first ?? 0
                guard let native=CGMouseButton(rawValue:UInt32(button)) else { throw CanaveralError.invalid("Unsupported native pointer button.") }
                let kind: CGEventType=buttons.isEmpty ? .mouseMoved : button == 0 ? .leftMouseDragged : button == 1 ? .rightMouseDragged : .otherMouseDragged
                try append(CGEvent(mouseEventSource:source,mouseType:kind,mouseCursorPosition:position,mouseButton:native),modifiers)
            case let .button(button,down,value,modifiers,reset):
                position=reset ? cursor : try point(value)
                guard let native=CGMouseButton(rawValue:UInt32(button)) else { throw CanaveralError.invalid("Unsupported native pointer button.") }
                let kind: CGEventType=button == 0 ? (down ? .leftMouseDown : .leftMouseUp) : button == 1 ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
                let event=CGEvent(mouseEventSource:source,mouseType:kind,mouseCursorPosition:position,mouseButton:native)
                event?.setIntegerValueField(.mouseEventButtonNumber,value:Int64(button)); try append(event,modifiers)
            case let .scroll(horizontal,vertical,modifiers):
                let event=CGEvent(scrollWheelEvent2Source:source,units:.line,wheelCount:2,wheel1:Int32(vertical),wheel2:Int32(horizontal),wheel3:0)
                event?.location=position; try append(event,modifiers)
            case let .text(text,modifiers):
                guard text.utf8.count <= 16000, !text.contains("\0") else { throw CanaveralError.invalid("Invalid guest text payload.") }
                var units: [UniChar]=[]
                func emit() throws {
                    guard !units.isEmpty else { return }
                    for down in [true,false] {
                        guard let event=CGEvent(keyboardEventSource:source,virtualKey:0,keyDown:down) else { throw CanaveralError.unavailable("Guest text construction failed.") }
                        event.keyboardSetUnicodeString(stringLength:units.count,unicodeString:units); try append(event,modifiers)
                    }
                    units.removeAll(keepingCapacity:true)
                }
                for scalar in text.unicodeScalars { let part=Array(String(scalar).utf16); if units.count+part.count > 20 { try emit() }; units+=part }
                try emit()
            }
        }
        // Construct/validate every event before posting the first one. A thrown
        // posting/cancellation failure still leaves the caller's pending state fenced.
        try authorize(); try Task.checkCancellation()
        guard current(display) else { throw CanaveralError.unavailable("Guest display geometry changed before input dispatch.") }
        for event in events { event.post(tap:.cghidEventTap) }
    }
}
