import Foundation

public struct DesktopTarget: Codable, Identifiable, Sendable, Equatable {
    public var id = UUID()
    public var name: String
    public var userControl: Bool?
    public var url: URL
    public init(name: String, url: URL) { self.name = name; self.url = url }
    public func validate() throws {
        guard !name.isEmpty, name.count <= 100 else { throw CanaveralError.invalid("Give this desktop a name.") }
        _ = try ConnectionConfiguration.validateRemoteURL(url.absoluteString, allowedPorts: [443, 8443])
    }
}
public struct DesktopFrame: Codable, Sendable {
    public var id: UUID
    public var width: Int
    public var height: Int
    public var pngBase64: String
    public var capturedAt: Date
    public init(id: UUID = UUID(), width: Int, height: Int, pngBase64: String, capturedAt: Date = Date()) {
        self.id = id; self.width = width; self.height = height; self.pngBase64 = pngBase64; self.capturedAt = capturedAt
    }
    public func validate() throws {
        guard (1...4096).contains(width), (1...4096).contains(height), pngBase64.utf8.count <= 8_000_000,
              let bytes = Data(base64Encoded: pngBase64), bytes.count >= 24, bytes.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
              Array(bytes[12..<16]) == Array("IHDR".utf8),
              bytes[16..<20].reduce(0, { ($0 << 8) | Int($1) }) == width,
              bytes[20..<24].reduce(0, { ($0 << 8) | Int($1) }) == height else { throw CanaveralError.invalid("Invalid guest desktop image.") }
    }
    public var summary: String { "Guest desktop frame \(id), \(width) × \(height), captured \(capturedAt). Coordinates are normalized from 0 to 1 with origin at the top left." }
}
public struct DesktopAction: Codable, Sendable {
    public enum Kind: String, Codable, Sendable { case click, typeText, key, scroll }
    public var id: UUID
    public var frameID: UUID
    public var kind: Kind
    public var x: Double?
    public var y: Double?
    public var text: String?
    public var key: String?
    public var delta: Int?
    public var human: Bool?
    public init(id: UUID = UUID(), frameID: UUID, kind: Kind, x: Double? = nil, y: Double? = nil, text: String? = nil, key: String? = nil, delta: Int? = nil, human: Bool? = nil) {
        self.id = id; self.frameID = frameID; self.kind = kind; self.x = x; self.y = y; self.text = text; self.key = key; self.delta = delta; self.human = human
    }
    public func validate() throws {
        switch kind {
        case .click:
            guard let x, let y, x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else { throw CanaveralError.invalid("Click coordinates must be between 0 and 1.") }
        case .typeText:
            guard let text, !text.isEmpty, text.utf16.count <= 2000 else { throw CanaveralError.invalid("Type between 1 and 2,000 characters.") }
        case .key:
            guard let key, key.count <= 80, !key.isEmpty else { throw CanaveralError.invalid("Enter a supported key or shortcut.") }
        case .scroll:
            guard let delta, (-20...20).contains(delta), delta != 0 else { throw CanaveralError.invalid("Scroll between -20 and 20 lines.") }
        }
    }
}
public struct DesktopReceipt: Codable, Sendable {
    public var id: UUID
    public var status: String
    public var fingerprint: String?
    public init(id: UUID, status: String, fingerprint: String? = nil) { self.id = id; self.status = status; self.fingerprint=fingerprint }
}
public struct DesktopSession: Codable, Sendable {
    public var frame: DesktopFrame
    public var userControl: Bool
    public init(frame: DesktopFrame, userControl: Bool) { self.frame = frame; self.userControl = userControl }
}
public struct DesktopControlRequest: Codable, Sendable {
    public var targetID: UUID
    public var userControl: Bool
    public init(targetID: UUID, userControl: Bool) { self.targetID = targetID; self.userControl = userControl }
}
public struct ManualDesktopRequest: Codable, Sendable {
    public var targetID: UUID
    public var action: DesktopAction
    public init(targetID: UUID, action: DesktopAction) { self.targetID = targetID; self.action = action }
}
public struct DesktopControlState: Codable, Sendable {
    public var userControl: Bool
    public init(userControl: Bool) { self.userControl = userControl }
}
public struct DesktopClient: Sendable {
    public var target: DesktopTarget
    public var token: String
    public init(target: DesktopTarget, token: String) { self.target = target; self.token = token }
    public func session() async throws -> DesktopSession {
        let session: DesktopSession = try await request("/v1/desktop/session")
        try session.frame.validate(); return session
    }
    public func control(_ human: Bool) async throws -> DesktopControlState {
        try await request("/v1/desktop/control", body: JSONEncoder().encode(DesktopControlRequest(targetID: target.id, userControl: human)))
    }
    public func capture() async throws -> DesktopFrame {
        let frame: DesktopFrame = try await request("/v1/desktop")
        try frame.validate(); return frame
    }
    public func perform(_ action: DesktopAction) async throws -> DesktopReceipt {
        try action.validate(); return try await request("/v1/desktop/action", body: JSONEncoder().encode(action))
    }
    public func accessibility() async throws -> GuestAccessibilitySnapshot {
        let snapshot: GuestAccessibilitySnapshot = try await request("/v1/accessibility")
        try snapshot.validate(); return snapshot
    }
    public func performAccessibility(_ action: GuestAccessibilityAction) async throws -> DesktopReceipt {
        try action.validate(); return try await request("/v1/accessibility/action",body:JSONEncoder().encode(action))
    }
    private func request<T: Decodable>(_ path: String, body: Data? = nil) async throws -> T {
        try target.validate()
        var request = URLRequest(url: URL(string: path, relativeTo: target.url)!.absoluteURL)
        request.httpMethod = body == nil ? "GET" : "POST"; request.httpBody = body; request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let config = URLSessionConfiguration.ephemeral
        // Credential-bearing desktop requests must never follow a redirect to another machine.
        let session = URLSession(configuration: config, delegate: NoDesktopRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw CanaveralError.unavailable("Guest desktop request failed. Inspect the current desktop before retrying an input action.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
private final class NoDesktopRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
