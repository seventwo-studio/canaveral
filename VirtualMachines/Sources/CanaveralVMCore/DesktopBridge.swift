import Foundation
import Darwin

public protocol GuestDesktopDevice: Sendable {
    func capture() async throws -> DesktopFrame
    func perform(_ action: DesktopAction) async throws
    func inspectAccessibility() async throws -> GuestAccessibilitySnapshot
    func performAccessibility(_ action: GuestAccessibilityAction, expected: GuestAccessibilitySnapshot) async throws
}
public extension GuestDesktopDevice {
    func inspectAccessibility() async throws -> GuestAccessibilitySnapshot { throw CanaveralError.unavailable("Native guest accessibility is unsupported.") }
    func performAccessibility(_ action: GuestAccessibilityAction, expected: GuestAccessibilitySnapshot) async throws { throw CanaveralError.unavailable("Native guest accessibility actions are unsupported.") }
}
public actor DesktopBridge {
    private let displayStream: GuestDisplayStream?
    private var changingControl=false
    private var closing=false
    private var shutdownWasUncertain: Bool?
    private let workspace: (any GuestWorkspaceService)?
    private let token: String
    private let device: any GuestDesktopDevice
    private let journalURL: URL
    private var receipts: [UUID: DesktopReceipt]
    private var frames: [UUID: Date] = [:]
    private var generation = UUID()
    private var userControl = false
    private let controlURL: URL
    private let controlPendingURL: URL
    private var controlUncertain = false
    private var acting = false
    private let clock: @Sendable () -> Double
    private var inspections: [UUID: (snapshot: GuestAccessibilitySnapshot, started: Double)] = [:]
    public init(token: String, device: any GuestDesktopDevice, journalURL: URL, workspace: (any GuestWorkspaceService)? = nil, displayStream: GuestDisplayStream? = nil, clock: @escaping @Sendable () -> Double = { NativeLeaseClock.now() }) throws {
        guard token.count >= 32 else { throw CanaveralError.invalid("Guest credential is too short.") }
        self.displayStream=displayStream; self.workspace=workspace; self.token = token; self.device = device; self.journalURL = journalURL; self.clock=clock
        controlURL = journalURL.deletingLastPathComponent().appendingPathComponent("control.json")
        let pendingURL=journalURL.deletingLastPathComponent().appendingPathComponent("control-pending.json")
        controlPendingURL = pendingURL
        try FileManager.default.createDirectory(at: journalURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        receipts = FileManager.default.fileExists(atPath: journalURL.path) ? try JSONDecoder().decode([UUID: DesktopReceipt].self, from: Data(contentsOf: journalURL)) : [:]
        if FileManager.default.fileExists(atPath: controlURL.path) { userControl = try JSONDecoder().decode(DesktopControlState.self, from: Data(contentsOf: controlURL)).userControl }
        controlUncertain = FileManager.default.fileExists(atPath: pendingURL.path) || (try? FileManager.default.destinationOfSymbolicLink(atPath:pendingURL.path)) != nil
    }
    public func handle(_ request: HTTPRequest) async -> HTTPResponse {
        guard Secrets.equal(request.bearer, token) else { return .error("Guest credential rejected.", status: 401) }
        guard request.headers["origin"] == nil else { return .error("Browser clients are not supported.", status: 403) }
        guard !closing else { return .error("Guest helper is shutting down.",status:503) }
        do {
            if (request.path.hasPrefix("/v1/files/") || request.path.hasPrefix("/v1/shell/")), let workspace { return try await workspace.handle(request) }
            if request.path.hasPrefix("/v1/display/"), let displayStream {
                if request.method == "GET", request.path == "/v1/display/frame" {
                    guard request.target == request.path, request.body.isEmpty else { throw CanaveralError.invalid("Invalid guest stream capture.") }
                    guard !acting else { throw GuestStreamRefusal.busy }
                    let epoch=generation
                    let frame=try await displayStream.capture()
                    guard !acting, epoch == generation else { throw GuestStreamRefusal.stale }
                    return try .json(frame)
                }
                if controlUncertain { throw GuestStreamRefusal.resetUncertain }
                guard !acting, !userControl else { throw GuestStreamRefusal.busy }
                if request.path == "/v1/display/action" { return try await streamAction(request,stream:displayStream) }
                acting=true; generation=UUID(); frames.removeAll(); inspections.removeAll(); defer { acting=false }
                return try await displayStream.handle(request)
            }
            switch (request.method, request.path) {
            case ("GET", "/v1/accessibility"):
                guard request.target == request.path, request.body.isEmpty, !acting else { throw CanaveralError.invalid("Inspection request is unavailable or malformed.") }
                let epoch=generation, started=clock()
                let captured=try await device.inspectAccessibility(); try captured.validate()
                let now=clock()
                guard !acting, epoch == generation, started.isFinite, now >= started, now-started < 15 else {
                    throw CanaveralError.unavailable("Inspection expired or was interrupted by guest input.")
                }
                inspections=inspections.filter { now >= $0.value.started && now-$0.value.started < 15 }
                if inspections.count >= 180, let oldest=inspections.min(by: { $0.value.started < $1.value.started }) { inspections.removeValue(forKey: oldest.key) }
                inspections[captured.snapshotId]=(captured,started)
                return try .json(captured)
            case ("POST", "/v1/accessibility/action"):
                guard request.target == request.path,
                      let object=try JSONSerialization.jsonObject(with:request.body) as? [String:Any],
                      Set(object.keys).isSubset(of:["id","snapshotId","nodeId","nativeAction","human"]) else {
                    throw CanaveralError.invalid("Invalid accessibility action fields.")
                }
                let action=try JSONDecoder().decode(GuestAccessibilityAction.self,from:request.body); try action.validate()
                let fingerprint=try fingerprint("accessibility",action)
                if let old=try replay(action.id,fingerprint:fingerprint) { return try .json(old) }
                guard !controlUncertain, (action.human == true) == userControl, !acting,
                      let saved=inspections[action.snapshotId], clock() >= saved.started, clock()-saved.started < 15,
                      let node=saved.snapshot.nodes.first(where: { $0.id == action.nodeId }),
                      node.states["enabled"] == true, node.actions.contains(action.nativeAction),
                      let bounds=node.bounds, bounds.width > 0, bounds.height > 0 else {
                    throw CanaveralError.invalid("Accessibility target or input ownership is stale. Inspect again.")
                }
                acting=true; generation=UUID(); frames.removeAll(); inspections.removeAll(); defer { acting=false }
                if let displayStream {
                    guard await !displayStream.busy(), !controlUncertain else { throw CanaveralError.unavailable("Native stream input owns this guest or control changed.") }
                    await displayStream.invalidateFrames()
                }
                receipts[action.id] = .init(id:action.id,status:"uncertain",fingerprint:fingerprint); try persist()
                try await device.performAccessibility(action,expected:saved.snapshot)
                receipts[action.id] = .init(id:action.id,status:"posted",fingerprint:fingerprint); try persist()
                return try .json(receipts[action.id]!)
            case ("GET", "/v1/desktop"), ("GET", "/v1/desktop/session"):
                guard !acting else { throw CanaveralError.unavailable("Guest input is still in progress.") }
                let epoch = generation
                let captured = try await device.capture(); try captured.validate()
                guard !acting, epoch == generation else { throw CanaveralError.unavailable("Capture was interrupted by guest input.") }
                frames = frames.filter { Date().timeIntervalSince($0.value) < 180 }
                if frames.count >= 180, let oldest = frames.min(by: { $0.value < $1.value }) { frames.removeValue(forKey: oldest.key) }
                frames[captured.id] = captured.capturedAt
                if request.path == "/v1/desktop/session" { return try .json(DesktopSession(frame: captured, userControl: userControl)) }
                return try .json(captured)
            case ("POST", "/v1/desktop/control"):
                guard request.target == request.path, !changingControl, request.body.count <= 16384,
                      let object=try JSONDecoder().decode(JSONValue.self,from:request.body).object,
                      Set(object.keys) == ["targetID","userControl"] else { throw CanaveralError.invalid("Invalid or concurrent guest control transition.") }
                let change = try JSONDecoder().decode(DesktopControlRequest.self, from: request.body)
                changingControl=true; defer { changingControl=false }
                controlUncertain=true; generation=UUID(); frames.removeAll(); inspections.removeAll()
                try markControlPending()
                let deadline=NativeLeaseClock.now()+5
                while acting {
                    guard NativeLeaseClock.now() < deadline else { throw CanaveralError.unavailable("Guest input did not stop before the control transition deadline.") }
                    try await Task.sleep(for:.milliseconds(20))
                }
                acting=true; defer { acting=false }
                if let displayStream { try await displayStream.resetOwner() }
                let next = DesktopControlState(userControl: change.userControl)
                try JSONEncoder().encode(next).write(to: controlURL, options: .atomic)
                try synchronize(controlURL)
                try FileManager.default.removeItem(at:controlPendingURL)
                try synchronizeDirectory()
                controlUncertain=false
                userControl = change.userControl; generation = UUID(); frames.removeAll(); inspections.removeAll()
                return try .json(next)
            case ("POST", "/v1/desktop/action"):
                let action = try JSONDecoder().decode(DesktopAction.self, from: request.body); try action.validate()
                let fingerprint=try fingerprint("desktop",action)
                if let old=try replay(action.id,fingerprint:fingerprint) { return try .json(old) }
                guard !controlUncertain, (action.human == true) == userControl else { throw CanaveralError.unavailable("Desktop control is owned or uncertain. Explicitly take over or return control first.") }
                guard !acting, let capturedAt = frames[action.frameID], Date().timeIntervalSince(capturedAt) < 180 else { throw CanaveralError.invalid("Capture a fresh desktop frame before acting.") }
                acting = true; generation = UUID(); inspections.removeAll(); defer { acting = false }
                if let displayStream {
                    guard await !displayStream.busy(), !controlUncertain else { throw CanaveralError.unavailable("Native stream input owns this guest or control changed.") }
                    await displayStream.invalidateFrames()
                }
                receipts[action.id] = .init(id: action.id, status: "uncertain",fingerprint:fingerprint); try persist()
                try await device.perform(action)
                // A receipt confirms posting input, not that the guest app achieved the intended result.
                receipts[action.id] = .init(id: action.id, status: "posted",fingerprint:fingerprint); frames.removeAll(); try persist()
                return try .json(receipts[action.id]!)
            default: return .error("Unknown guest endpoint.", status: 404)
            }
        } catch let refusal as GuestStreamRefusal {
            return try! .json(JSONValue.object(["message":.string(refusal.localizedDescription),"code":.string(refusal.rawValue),"state":.string(refusal.state)]),status:409)
        } catch { return .error(error.localizedDescription, status: 409) }
    }
    private func streamAction(_ request: HTTPRequest, stream: GuestDisplayStream) async throws -> HTTPResponse {
        guard request.method == "POST", request.target == request.path, request.body.count <= 16384,
              let object=try JSONDecoder().decode(JSONValue.self,from:request.body).object,
              let raw=object["streamId"]?.string, let streamID=UUID(uuidString:raw),
              let rawID=object["id"]?.string, let id=UUID(uuidString:rawID), let kind=object["action"]?.string,
              let arguments=object["arguments"]?.object else { throw CanaveralError.invalid("Invalid native semantic action envelope.") }
        let accessibility=kind == "accessibility-action"
        guard Set(object.keys) == (accessibility ? ["streamId","id","action","arguments"] : ["streamId","id","action","arguments","frameId"]) else { throw CanaveralError.invalid("Invalid native semantic action fields.") }
        var payload=object; payload.removeValue(forKey:"streamId")
        let fingerprint=try fingerprint("stream-action",JSONValue.object(payload))
        if let previous=try replay(id,fingerprint:fingerprint) { return try .json(previous) }
        let action: GuestStreamSemanticAction
        var frameID: UUID?
        if !accessibility {
            guard let raw=object["frameId"]?.string, let parsed=UUID(uuidString:raw) else { throw GuestStreamRefusal.stale }; frameID=parsed
        }
        switch kind {
        case "accessibility-action":
            guard Set(arguments.keys) == ["snapshotId","nodeId","nativeAction"],
                  let raw=arguments["snapshotId"]?.string, let snapshotID=UUID(uuidString:raw),
                  let node=arguments["nodeId"]?.string, let native=arguments["nativeAction"]?.string,
                  let saved=inspections[snapshotID], clock() >= saved.started, clock()-saved.started < 15 else { throw GuestStreamRefusal.stale }
            let request=GuestAccessibilityAction(id:id,snapshotId:snapshotID,nodeId:node,nativeAction:native)
            try request.validate()
            guard let target=saved.snapshot.nodes.first(where:{ $0.id == node }), target.states["enabled"] == true,
                  target.actions.contains(native), let bounds=target.bounds, bounds.width > 0, bounds.height > 0 else { throw GuestStreamRefusal.stale }
            action = .accessibility(request,saved.snapshot)
        case "tap":
            guard Set(arguments.keys) == ["x","y"] else { throw CanaveralError.invalid("Invalid native tap fields.") }
            action = .tap(x:try pixel(arguments["x"]),y:try pixel(arguments["y"]))
        case "text":
            guard Set(arguments.keys) == ["text"], let text=arguments["text"]?.string, !text.contains("\0"), text.utf8.count <= 16000 else { throw CanaveralError.invalid("Invalid native semantic text.") }
            action = .text(text)
        case "key":
            guard Set(arguments.keys) == ["key"], let key=arguments["key"]?.string else { throw CanaveralError.invalid("Invalid native shortcut.") }
            action = .keys(try shortcut(key))
        default: throw GuestStreamRefusal.unsupported
        }
        acting=true; generation=UUID(); frames.removeAll(); inspections.removeAll(); defer { acting=false }
        try await stream.semantic(id:streamID,frameID:frameID) { binding,expiry in
            try await self.postSemantic(action,id:id,fingerprint:fingerprint,binding:binding,expiry:expiry)
        }
        return try .json(receipts[id]!)
    }
    private func postSemantic(_ action: GuestStreamSemanticAction, id: UUID, fingerprint: String, binding: GuestStreamFrameBinding?, expiry: Double?) async throws {
        guard let device=device as? any GuestStreamDevice else { throw GuestStreamRefusal.unsupported }
        if case let .tap(x,y)=action {
            guard let binding, (0..<binding.width).contains(x), (0..<binding.height).contains(y) else { throw GuestStreamRefusal.stale }
        }
        receipts[id] = .init(id:id,status:"uncertain",fingerprint:fingerprint); try persist()
        try await device.performSemantic(action,frame:binding,expiresAt:expiry)
        receipts[id] = .init(id:id,status:"posted",fingerprint:fingerprint); try persist()
    }
    private func pixel(_ value: JSONValue?) throws -> Int {
        guard case .number(let number)=value, number.isFinite, number >= 0, number <= 32768, number.rounded(.towardZero) == number else { throw CanaveralError.invalid("Native tap coordinates require exact nonnegative pixels.") }
        return Int(number)
    }
    private func shortcut(_ text: String) throws -> [UInt32] {
        guard !text.isEmpty, text.utf8.count <= 80, !text.contains("\0") else { throw GuestStreamRefusal.unsupported }
        let components=text.lowercased().split(separator:"+",omittingEmptySubsequences:false).map(String.init)
        let modifiers: [String:UInt32]=["cmd":0xffeb,"ctrl":0xffe3,"shift":0xffe1,"alt":0xffe9]
        var result: [UInt32]=[]
        for item in components.dropLast() {
            guard let key=modifiers[item], !result.contains(key) else { throw GuestStreamRefusal.unsupported }; result.append(key)
        }
        guard let last=components.last else { throw GuestStreamRefusal.unsupported }
        let named: [String:UInt32]=["return":0xff0d,"enter":0xff0d,"tab":0xff09,"space":0x20,"escape":0xff1b,"delete":0xff08,"backspace":0xff08,"forward-delete":0xffff,"left":0xff51,"up":0xff52,"right":0xff53,"down":0xff54,"home":0xff50,"end":0xff57,"pageup":0xff55,"pagedown":0xff56]
        if let key=named[last] { result.append(key) }
        else if last.hasPrefix("f"), let number=Int(last.dropFirst()), (1...20).contains(number) { result.append(0xffbe+UInt32(number-1)) }
        else {
            let character=result.contains(0xffe1) ? last.uppercased() : last
            guard character.unicodeScalars.count == 1, let scalar=character.unicodeScalars.first, !CharacterSet.controlCharacters.contains(scalar) else { throw GuestStreamRefusal.unsupported }
            result.append(scalar.value <= 255 ? scalar.value : 0x01000000|scalar.value)
        }
        return result
    }
    public func shutdownInput() async throws {
        if shutdownWasUncertain == nil { shutdownWasUncertain=controlUncertain || changingControl }
        closing=true; controlUncertain=true; generation=UUID(); frames.removeAll(); inspections.removeAll()
        try markControlPending()
        let deadline=NativeLeaseClock.now()+5
        while acting || changingControl {
            guard NativeLeaseClock.now() < deadline else { throw CanaveralError.unavailable("Guest input shutdown is still pending.") }
            try await Task.sleep(for:.milliseconds(20))
        }
        acting=true; defer { acting=false }
        // A control transition completing during the wait may have removed its marker.
        try markControlPending()
        if let displayStream { try await displayStream.shutdown() }
        if shutdownWasUncertain == false {
            try FileManager.default.removeItem(at:controlPendingURL); try synchronizeDirectory()
        }
    }
    private func markControlPending() throws {
        try Data("{\"version\":1,\"pending\":true}".utf8).write(to:controlPendingURL,options:.atomic)
        try synchronize(controlPendingURL)
    }
    private func fingerprint<T: Encodable>(_ kind: String, _ value: T) throws -> String {
        let encoder=JSONEncoder(); encoder.outputFormatting=[.sortedKeys]
        return Secrets.hash(kind+"\n"+String(decoding:try encoder.encode(value),as:UTF8.self))
    }
    private func replay(_ id: UUID, fingerprint: String) throws -> DesktopReceipt? {
        guard let old=receipts[id] else { return nil }
        guard old.fingerprint == fingerprint else { throw CanaveralError.invalid("Input ID belongs to another request or an unbound legacy receipt.") }
        guard old.status == "posted" else { throw CanaveralError.unavailable("This input's outcome is uncertain. Inspect before acting; it will not be replayed.") }
        return old
    }
    private func persist() throws {
        try JSONEncoder().encode(receipts).write(to: journalURL, options: .atomic)
        try synchronize(journalURL)
    }
    private func synchronize(_ path: URL) throws {
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:path.path)
        let file=try FileHandle(forWritingTo:path); defer { try? file.close() }
        try file.synchronize()
        try synchronizeDirectory()
    }
    private func synchronizeDirectory() throws {
        let directory=Darwin.open(journalURL.deletingLastPathComponent().path,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW)
        guard directory >= 0 else { throw CanaveralError.unavailable("Guest input journal directory could not be opened for synchronization.") }
        defer { Darwin.close(directory) }
        guard Darwin.fsync(directory) == 0 else { throw CanaveralError.unavailable("Guest input journal publication was not synchronized.") }
    }
}
