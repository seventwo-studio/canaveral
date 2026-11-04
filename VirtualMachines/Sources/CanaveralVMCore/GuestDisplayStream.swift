import Foundation
import Darwin

public enum GuestStreamRefusal: String, Error, LocalizedError, Sendable {
    case busy="input_busy", resetUncertain="input_reset_uncertain", stale="input_stale", unsupported="capability_unsupported"
    public var state: String { switch self { case .busy: "busy"; case .resetUncertain: "reset-uncertain"; case .stale: "stale"; case .unsupported: "not-ready" } }
    public var errorDescription: String? { switch self {
        case .busy: "Guest input is owned or in progress."
        case .resetUncertain: "Guest input reset or outcome is uncertain."
        case .stale: "Guest stream identity or captured frame is stale."
        case .unsupported: "This native semantic input action is unsupported."
    } }
}

public struct GuestStreamFrameBinding: Sendable {
    public var id: UUID, width: Int, height: Int, displayID: UInt32, bounds: GuestAccessibilityBounds
    public func validate() throws {
        guard (1...4096).contains(width), (1...4096).contains(height), displayID != 0,
              bounds.valid, bounds.width > 0, bounds.height > 0 else { throw CanaveralError.invalid("Invalid guest frame input binding.") }
    }
}
public struct GuestStreamFrame: Codable, Sendable {
    public var frame: DesktopFrame
    public var displayID: UInt32
    public var bounds: GuestAccessibilityBounds
    public init(frame: DesktopFrame, displayID: UInt32, bounds: GuestAccessibilityBounds) { self.frame=frame; self.displayID=displayID; self.bounds=bounds }
    public var binding: GuestStreamFrameBinding { .init(id:frame.id,width:frame.width,height:frame.height,displayID:displayID,bounds:bounds) }
    public func validate() throws {
        try frame.validate()
        guard displayID != 0, bounds.valid, bounds.width > 0, bounds.height > 0 else { throw CanaveralError.invalid("Invalid captured guest input geometry.") }
    }
}
public enum GuestStreamEvent: Sendable {
    case key(keysym:UInt32,down:Bool)
    case pointer(x:Int,y:Int,buttons:UInt8)
    case text(String)
}
public enum GuestStreamSemanticAction: Sendable {
    case tap(x:Int,y:Int)
    case text(String)
    case keys([UInt32])
    case accessibility(GuestAccessibilityAction,GuestAccessibilitySnapshot)
}
public protocol GuestStreamDevice: Sendable {
    func captureStream() async throws -> GuestStreamFrame
    func performStream(_ event: GuestStreamEvent, frame: GuestStreamFrameBinding, expiresAt: Double) async throws
    func resetStreamInput(requireState: Bool) async throws
    func requireNeutralStreamInput() async throws
    func performSemantic(_ action: GuestStreamSemanticAction, frame: GuestStreamFrameBinding?, expiresAt: Double?) async throws
}
public extension GuestStreamDevice {
    func requireNeutralStreamInput() async throws { throw GuestStreamRefusal.unsupported }
    func performSemantic(_ action: GuestStreamSemanticAction, frame: GuestStreamFrameBinding?, expiresAt: Double?) async throws { throw GuestStreamRefusal.unsupported }
}
private struct GuestStreamRecord: Codable {
    var version=1
    var id: UUID, phase: String
    var ready=false
}
/// Small, private, pinned-directory records; no process/endpoint recovery from journals.
private final class GuestStreamJournal {
    private let descriptor: Int32
    init(_ url: URL) throws {
        try FileManager.default.createDirectory(at:url,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let fd=Darwin.open(url.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
        guard fd >= 0 else { throw CanaveralError.unavailable("Guest stream journal is unavailable.") }
        guard fchmod(fd,mode_t(0o700)) == 0 else { Darwin.close(fd); throw CanaveralError.unavailable("Guest stream journal could not be made private.") }
        descriptor=fd
    }
    deinit { Darwin.close(descriptor) }
    func read(_ name: String) throws -> GuestStreamRecord? {
        let fd=openat(descriptor,name,O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC)
        if fd < 0 { if errno == ENOENT { return nil }; throw CanaveralError.unavailable("Guest stream receipt cannot be inspected.") }
        defer { Darwin.close(fd) }
        var value=stat(), data=Data()
        guard fstat(fd,&value) == 0, value.st_mode & S_IFMT == S_IFREG, (0...4096).contains(value.st_size) else { throw CanaveralError.unavailable("Guest stream receipt is not a bounded regular file.") }
        var buffer=[UInt8](repeating:0,count:4097)
        while data.count < 4097 {
            let count=Darwin.read(fd,&buffer,min(buffer.count,4097-data.count))
            if count > 0 { data.append(contentsOf:buffer.prefix(count)) }
            else if count == 0 { break }
            else if errno != EINTR { throw CanaveralError.unavailable("Guest stream receipt read failed.") }
        }
        let record=try JSONDecoder().decode(GuestStreamRecord.self,from:data)
        guard record.version == 1, ["starting","active","blocked","releasing","closed"].contains(record.phase), record.phase != "active" || record.ready else { throw CanaveralError.unavailable("Guest stream receipt version/state differs.") }
        return record
    }
    func write(_ record: GuestStreamRecord, name: String) throws {
        let temporary=".stream-"+UUID().uuidString.lowercased(), data=try JSONEncoder().encode(record)
        let fd=openat(descriptor,temporary,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,mode_t(0o600))
        guard fd >= 0 else { throw CanaveralError.unavailable("Guest stream receipt creation failed.") }
        defer { Darwin.close(fd); unlinkat(descriptor,temporary,0) }
        try data.withUnsafeBytes { raw in
            var offset=0
            while offset < raw.count {
                let count=Darwin.write(fd,raw.baseAddress!.advanced(by:offset),raw.count-offset)
                if count > 0 { offset+=count } else if count < 0 && errno == EINTR { continue }
                else { throw CanaveralError.unavailable("Guest stream receipt write failed.") }
            }
        }
        guard fsync(fd) == 0, renameat(descriptor,temporary,descriptor,name) == 0, fsync(descriptor) == 0 else { throw CanaveralError.unavailable("Guest stream receipt publication is uncertain.") }
    }
}

/// Authenticated by DesktopBridge, which also serializes legacy and stream input.
public actor GuestDisplayStream {
    private let device: any GuestStreamDevice
    private let journal: GuestStreamJournal
    private let clock: @Sendable () -> Double
    private var owner: GuestStreamRecord?
    private var frames: [UUID:(value:GuestStreamFrameBinding,started:Double)]=[:]
    private var generation=UUID(), acting=false, fenced=false
    private var sequence: Int64=0
    private var lastFingerprint: String?
    public init(device: any GuestStreamDevice, state: URL, clock: @escaping @Sendable () -> Double = { NativeLeaseClock.now() }) throws {
        self.device=device; self.clock=clock
        let records=try GuestStreamJournal(state); journal=records
        if var previous=try records.read("owner.json"), previous.phase != "closed" {
            previous.phase="blocked"; owner=previous
        }
    }
    private func name(_ id: UUID) -> String { id.uuidString.lowercased()+".json" }
    public func busy() -> Bool { fenced || owner != nil || acting }
    public func invalidateFrames() { generation=UUID(); frames.removeAll() }
    public func capture() async throws -> GuestStreamFrame {
        guard !fenced else { throw GuestStreamRefusal.resetUncertain }
        guard !acting else { throw GuestStreamRefusal.busy }
        let epoch=generation, started=clock()
        let value=try await device.captureStream(); try value.validate()
        let now=clock()
        guard !fenced, !acting, epoch == generation, started.isFinite, now >= started, now-started < 15 else { throw GuestStreamRefusal.stale }
        frames=frames.filter { now >= $0.value.started && now-$0.value.started < 15 }
        guard frames[value.frame.id] == nil else { throw CanaveralError.invalid("Guest capture reused a frame identity.") }
        if frames.count >= 180, let first=frames.min(by:{ $0.value.started < $1.value.started }) { frames.removeValue(forKey:first.key) }
        frames[value.frame.id]=(value.binding,started)
        return value
    }
    public func handle(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard !fenced else { throw GuestStreamRefusal.resetUncertain }
        guard request.method == "POST", request.target == request.path, request.body.count <= 16384,
              let object=try JSONDecoder().decode(JSONValue.self,from:request.body).object,
              let raw=object["streamId"]?.string, let id=UUID(uuidString:raw) else { throw CanaveralError.invalid("Invalid guest stream envelope.") }
        switch request.path {
        case "/v1/display/take":
            guard Set(object.keys) == ["streamId"], !acting else { throw CanaveralError.invalid("Invalid or unavailable stream take.") }
            if let current=owner {
                guard current.phase == "active" else { throw GuestStreamRefusal.resetUncertain }
                guard current.id == id else { throw GuestStreamRefusal.busy }
                return try .json(JSONValue.object(["streamId":.string(id.uuidString),"sequence":.number(Double(sequence)),"state":.string("owned")]))
            }
            guard try journal.read(name(id)) == nil else { throw CanaveralError.unavailable("Guest stream identity was previously attempted and will not be reopened.") }
            acting=true; generation=UUID(); defer { acting=false }
            var record=GuestStreamRecord(id:id,phase:"starting"); owner=record
            try journal.write(record,name:name(id)); try journal.write(record,name:"owner.json")
            do {
                try await device.resetStreamInput(requireState:false)
                record.ready=true; record.phase="active"; try journal.write(record,name:"owner.json"); owner=record
                sequence=0; lastFingerprint=nil
            } catch { owner?.phase="blocked"; throw error }
            return try .json(JSONValue.object(["streamId":.string(id.uuidString),"sequence":.number(0),"state":.string("owned")]))
        case "/v1/display/input":
            guard Set(object.keys) == ["streamId","sequence","frameId","event"], !acting,
                  let frameRaw=object["frameId"]?.string, let frameID=UUID(uuidString:frameRaw),
                  let event=object["event"]?.object else { throw CanaveralError.invalid("Invalid guest stream input fields.") }
            let eventSequence=try integer(object["sequence"],maximum:9007199254740991)
            let encoder=JSONEncoder(); encoder.outputFormatting=[.sortedKeys]
            let fingerprint=Secrets.hash(String(decoding:try encoder.encode(JSONValue.object(object)),as:UTF8.self))
            guard owner?.phase == "active" else { throw GuestStreamRefusal.resetUncertain }
            guard owner?.id == id else { throw GuestStreamRefusal.busy }
            if eventSequence == sequence, lastFingerprint == fingerprint { return try acknowledgement(id) }
            guard eventSequence == sequence+1, let saved=frames[frameID] else { throw CanaveralError.invalid("Guest stream sequence or captured frame differs.") }
            let now=clock()
            guard now.isFinite, now >= saved.started, now-saved.started < 15 else { throw GuestStreamRefusal.stale }
            let parsed=try parse(event,frame:saved.value)
            acting=true; generation=UUID(); defer { acting=false }
            // Do not clear issued frames between held events. Identity, geometry
            // and age remain checked; an input owner needs key-up/drag continuity.
            do { try await device.performStream(parsed,frame:saved.value,expiresAt:saved.started+15) }
            catch { owner?.phase="blocked"; lastFingerprint=nil; throw error }
            sequence=eventSequence; lastFingerprint=fingerprint
            return try acknowledgement(id)
        case "/v1/display/release":
            guard Set(object.keys) == ["streamId"], !acting else { throw CanaveralError.invalid("Invalid guest stream release.") }
            if owner?.id != id {
                if let previous=try journal.read(name(id)), previous.id == id, previous.phase == "closed" { return try .json(["released":true]) }
                throw CanaveralError.unavailable("This stream cannot release another input owner.")
            }
            try await resetOwner()
            return try .json(["released":true])
        default: return .error("Unknown guest display stream endpoint.",status:404)
        }
    }
    private func acknowledgement(_ id: UUID) throws -> HTTPResponse {
        try .json(JSONValue.object(["streamId":.string(id.uuidString),"sequence":.number(Double(sequence)),"posted":.bool(true)]))
    }
    private func integer(_ value: JSONValue?, maximum: Int64) throws -> Int64 {
        guard case .number(let value)=value, value.isFinite, value >= 0, value <= Double(maximum), value.rounded(.towardZero) == value else { throw CanaveralError.invalid("Guest stream integers must be exact and nonnegative.") }
        return Int64(value)
    }
    private func parse(_ value: [String:JSONValue], frame: GuestStreamFrameBinding) throws -> GuestStreamEvent {
        switch value["type"]?.string {
        case "key":
            guard Set(value.keys) == ["type","keysym","down"], case .bool(let down)=value["down"] else { throw CanaveralError.invalid("Invalid guest stream key event.") }
            return .key(keysym:UInt32(try integer(value["keysym"],maximum:Int64(UInt32.max))),down:down)
        case "pointer":
            guard Set(value.keys) == ["type","x","y","buttons"] else { throw CanaveralError.invalid("Invalid guest stream pointer event.") }
            return .pointer(x:Int(try integer(value["x"],maximum:Int64(frame.width-1))),y:Int(try integer(value["y"],maximum:Int64(frame.height-1))),buttons:UInt8(try integer(value["buttons"],maximum:255)))
        case "text":
            guard Set(value.keys) == ["type","text"], let text=value["text"]?.string, !text.contains("\0"), text.utf8.count <= 16000 else { throw CanaveralError.invalid("Invalid guest stream text event.") }
            return .text(text)
        default: throw CanaveralError.invalid("Unsupported guest stream input event.")
        }
    }
    public func semantic(id: UUID, frameID: UUID?, operation: @Sendable (GuestStreamFrameBinding?,Double?) async throws -> Void) async throws {
        guard !fenced, !acting else { throw GuestStreamRefusal.resetUncertain }
        guard owner?.phase == "active" else { throw GuestStreamRefusal.resetUncertain }
        guard owner?.id == id else { throw GuestStreamRefusal.busy }
        var binding: GuestStreamFrameBinding?, expiry: Double?
        if let frameID {
            guard let saved=frames[frameID] else { throw GuestStreamRefusal.stale }
            let now=clock()
            guard now.isFinite, now >= saved.started, now-saved.started < 15 else { throw GuestStreamRefusal.stale }
            binding=saved.value; expiry=saved.started+15
        }
        acting=true; generation=UUID(); defer { acting=false }
        do {
            try await device.requireNeutralStreamInput()
            try await operation(binding,expiry)
        } catch let refusal as GuestStreamRefusal {
            if refusal == .resetUncertain { owner?.phase="blocked" }
            throw refusal
        } catch { owner?.phase="blocked"; lastFingerprint=nil; throw error }
    }
    public func shutdown() async throws {
        fenced=true; invalidateFrames()
        try await resetOwner()
    }
    /// Called only by an explicit authenticated native control transition/cleanup.
    public func resetOwner() async throws {
        guard !acting else { throw CanaveralError.unavailable("Guest stream input is still in progress.") }
        acting=true; generation=UUID(); frames.removeAll(); defer { acting=false }
        if var record=owner {
            record.phase="releasing"; owner=record
            // Journal failure cannot prevent clearing still-owned native input.
            try? journal.write(record,name:"owner.json")
            do {
                try await device.resetStreamInput(requireState:record.ready)
                record.phase="closed"
                try journal.write(record,name:name(record.id)); try journal.write(record,name:"owner.json")
                owner=nil; sequence=0; lastFingerprint=nil
            } catch { owner?.phase="blocked"; throw error }
        } else { try await device.resetStreamInput(requireState:false) }
    }
}
