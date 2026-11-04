import Foundation

public struct GuestInputModifiers: OptionSet, Sendable, Equatable {
    public let rawValue: UInt8
    public init(rawValue: UInt8) { self.rawValue=rawValue }
    public static let shift=Self(rawValue:1), control=Self(rawValue:2), option=Self(rawValue:4), command=Self(rawValue:8)
}
public struct GuestInputPoint: Codable, Sendable, Equatable {
    public var x: Double, y: Double
    public init(x: Double, y: Double) { self.x=x; self.y=y }
    public var valid: Bool { x.isFinite && y.isFinite && (0...1).contains(x) && (0...1).contains(y) }
}
/// Store the resolved native key at key-down so layout changes cannot redirect key-up/reset.
public struct GuestInputKey: Codable, Sendable, Equatable {
    public var keysym: UInt32, code: UInt16, unicode: String?
    public init(keysym: UInt32, code: UInt16, unicode: String? = nil) { self.keysym=keysym; self.code=code; self.unicode=unicode }
    public var modifier: GuestInputModifiers {
        switch keysym {
        case 0xffe1,0xffe2: return .shift
        case 0xffe3,0xffe4: return .control
        case 0xffe9,0xffea: return .option
        case 0xffe7,0xffe8,0xffeb,0xffec: return .command
        default: return []
        }
    }
    public var valid: Bool { code <= 127 && (unicode.map { !$0.isEmpty && !$0.contains("\0") && $0.utf16.count <= 16 } ?? true) }
}
public enum GuestNativeInput: Sendable, Equatable {
    case key(GuestInputKey,down:Bool,modifiers:GuestInputModifiers,repeated:Bool)
    case move(GuestInputPoint,buttons:[UInt8],modifiers:GuestInputModifiers)
    case button(UInt8,down:Bool,point:GuestInputPoint,modifiers:GuestInputModifiers,reset:Bool)
    case scroll(horizontal:Int,vertical:Int,modifiers:GuestInputModifiers)
    case text(String,modifiers:GuestInputModifiers)
}
@MainActor public protocol GuestInputBackend {
    func resolve(keysym: UInt32, modifiers: GuestInputModifiers) throws -> GuestInputKey
    func post(_ events: [GuestNativeInput]) throws
}
public struct GuestInputState: Codable, Sendable, Equatable {
    public var keys: [GuestInputKey], buttons: [UInt8], point: GuestInputPoint, uncertain: Bool
    public init(keys: [GuestInputKey] = [], buttons: [UInt8] = [], point: GuestInputPoint = .init(x:0,y:0), uncertain: Bool = false) {
        self.keys=keys; self.buttons=buttons; self.point=point; self.uncertain=uncertain
    }
    public var modifiers: GuestInputModifiers { keys.reduce([]) { $0.union($1.modifier) } }
    public var held: Bool { !keys.isEmpty || !buttons.isEmpty }
    public func validate() throws {
        guard keys.count <= 128, Set(keys.map(\.keysym)).count == keys.count, keys.allSatisfy(\.valid), point.valid,
              Set(buttons).count == buttons.count, buttons.allSatisfy({ (0...3).contains($0) }) else {
            throw CanaveralError.invalid("Invalid native held-input state.")
        }
    }
}

/// A native input state machine; HTTP authorization, ownership and frame binding belong to its bridge.
@MainActor public final class GuestDisplayInput<Backend: GuestInputBackend> {
    public let backend: Backend
    public private(set) var state: GuestInputState
    private let save: (GuestInputState) throws -> Void
    public init(backend: Backend, recovered: GuestInputState? = nil, save: @escaping (GuestInputState) throws -> Void) throws {
        self.backend=backend; self.save=save
        var value=recovered ?? .init(); try value.validate()
        if recovered != nil { value.uncertain=true }
        state=value
    }
    private func dispatch(_ events: [GuestNativeInput], next: GuestInputState) throws {
        guard !events.isEmpty else { return }
        var pending=next
        var keys=Dictionary(uniqueKeysWithValues:state.keys.map { ($0.keysym,$0) })
        for key in next.keys { keys[key.keysym]=key }
        pending.keys=keys.values.sorted { $0.keysym < $1.keysym }
        pending.buttons=Set(state.buttons+next.buttons).sorted(); pending.uncertain=true
        // Persist the union: a release might fail before the old held key goes up.
        try save(pending)
        state=pending
        try backend.post(events)
        try save(next)
        state=next
    }
    public func key(keysym: UInt32, down: Bool) throws {
        guard !state.uncertain else { throw CanaveralError.unavailable("Native input reset is required before more events.") }
        let held=state.keys.first { $0.keysym == keysym }
        if !down, held == nil { return } // An unowned key-up must not release a local key.
        guard !down || held != nil || state.keys.count < 128 else { throw CanaveralError.invalid("Too many simultaneously held native keys.") }
        let key=try held ?? backend.resolve(keysym:keysym,modifiers:state.modifiers)
        guard key.keysym == keysym, key.valid else { throw CanaveralError.invalid("Native keyboard resolution differs from the requested key.") }
        var next=state
        if down, held == nil { next.keys.append(key); next.keys.sort { $0.keysym < $1.keysym } }
        if !down { next.keys.removeAll { $0.keysym == keysym } }
        // Modifier-up carries flags after release; left/right modifiers remain independent.
        try dispatch([.key(key,down:down,modifiers:next.modifiers,repeated:down && held != nil)],next:next)
    }
    public func pointer(mask: UInt8, point: GuestInputPoint) throws {
        guard !state.uncertain else { throw CanaveralError.unavailable("Native input reset is required before more events.") }
        guard point.valid else { throw CanaveralError.invalid("Native pointer coordinates must be finite normalized points.") }
        let mapping: [(UInt8,UInt8)]=[(1,0),(2,2),(4,1),(128,3)]
        let buttons=mapping.compactMap { mask & $0.0 != 0 ? $0.1 : nil }.sorted()
        let modifiers=state.modifiers
        var events: [GuestNativeInput]=[]
        if point != state.point { events.append(.move(point,buttons:state.buttons,modifiers:modifiers)) }
        for button in state.buttons where !buttons.contains(button) { events.append(.button(button,down:false,point:point,modifiers:modifiers,reset:false)) }
        for button in buttons where !state.buttons.contains(button) { events.append(.button(button,down:true,point:point,modifiers:modifiers,reset:false)) }
        let vertical=(mask & 8 != 0 ? 1 : 0)-(mask & 16 != 0 ? 1 : 0)
        let horizontal=(mask & 32 != 0 ? 1 : 0)-(mask & 64 != 0 ? 1 : 0)
        if horizontal != 0 || vertical != 0 { events.append(.scroll(horizontal:horizontal,vertical:vertical,modifiers:modifiers)) }
        var next=state; next.point=point; next.buttons=buttons
        try dispatch(events,next:next)
    }
    public func text(_ text: String) throws {
        guard !state.uncertain else { throw CanaveralError.unavailable("Native input reset is required before more events.") }
        guard !text.contains("\0"), text.utf8.count <= 16000 else { throw CanaveralError.invalid("Native text exceeds its control envelope.") }
        if text.isEmpty { return }
        // One complete input transaction; the native backend owns bounded UTF-16 event construction.
        try dispatch([.text(text,modifiers:state.modifiers)],next:state)
    }
    public func reset() throws {
        var next=GuestInputState(point:state.point)
        // Release ordinary keys before modifiers, preserving flags for each step.
        let keys=state.keys.sorted { a,b in
            if a.modifier.isEmpty != b.modifier.isEmpty { return a.modifier.isEmpty }
            return a.keysym < b.keysym
        }
        var held=state, events: [GuestNativeInput]=[]
        for key in keys {
            held.keys.removeAll { $0.keysym == key.keysym }
            events.append(.key(key,down:false,modifiers:held.modifiers,repeated:false))
        }
        for button in state.buttons { events.append(.button(button,down:false,point:state.point,modifiers:[],reset:true)) }
        if events.isEmpty {
            // A prior unconfirmed text/move or even an empty recovered marker still requires explicit reset confirmation.
            try save(next); state=next; return
        }
        next.uncertain=false
        try dispatch(events,next:next)
    }
}
