import Foundation
@preconcurrency import Network
import Security
import Darwin

/// Owns every delivered peer. NWListener's connectionLimit is a lifetime delivery
/// limit, not a concurrent-peer semaphore, so admission is counted here instead.
public final class BoundTLSServer: @unchecked Sendable {
    public struct Limits: Sendable {
        public var total = 32, unauthenticated = 8
        public var handshake: Double = 5, head: Double = 5, body: Double = 15, work: Double = 30, write: Double = 15
        public init() {}
    }
    private let listener: NWListener
    private let queue = DispatchQueue(label: "canaveral.bound-tls")
    private let limits: Limits
    private let authenticate: @Sendable (HTTPRequest) async -> Bool
    private let handler: @Sendable (HTTPRequest) async -> HTTPResponse
    private var peers: [UUID: BoundPeer] = [:]
    private var stopped = false
    private var peakTotal = 0, peakUnauthenticated = 0, peakPreauthBytes = 0
    func statistics() async -> (active: Int, total: Int, unauthenticated: Int, preauthBytes: Int) {
        await withCheckedContinuation { continuation in queue.async { continuation.resume(returning: (self.peers.count, self.peakTotal, self.peakUnauthenticated, self.peakPreauthBytes)) } }
    }
    public init(address: String, port: UInt16, identity: GuestTLSIdentity, limits: Limits = .init(), authenticate: @escaping @Sendable (HTTPRequest) async -> Bool, handler: @escaping @Sendable (HTTPRequest) async -> HTTPResponse) throws {
        var literal = in_addr()
        guard inet_pton(AF_INET, address, &literal) == 1, address != "0.0.0.0" else { throw CanaveralError.invalid("TLS listener requires a literal interface address.") }
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv13)
        guard let local = sec_identity_create(identity.identity), limits.total > 0, limits.unauthenticated > 0 else { throw CanaveralError.invalid("TLS listener configuration is invalid.") }
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, local)
        let parameters = NWParameters(tls: tls)
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(address), port: NWEndpoint.Port(rawValue: port)!)
        listener = try NWListener(using: parameters)
        self.limits = limits; self.authenticate = authenticate; self.handler = handler
    }
    public var port: UInt16? { listener.port?.rawValue }
    public func run(onReady: @escaping @Sendable () -> Void = {}) async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                queue.async {
                    guard !self.stopped else { continuation.resume(); return }
                    self.listener.stateUpdateHandler = { state in
                        switch state {
                        case .ready: onReady()
                        case .failed(let error): self.shutdown(); continuation.resume(throwing: error); self.listener.stateUpdateHandler = nil
                        case .cancelled: self.shutdown(); continuation.resume(); self.listener.stateUpdateHandler = nil
                        default: break
                        }
                    }
                    self.listener.newConnectionHandler = { connection in
                        guard !self.stopped, self.peers.count < self.limits.total,
                              self.peers.values.filter({ !$0.authenticated }).count < self.limits.unauthenticated else { connection.cancel(); return }
                        let id = UUID()
                        let peer = BoundPeer(connection, queue: self.queue, limits: self.limits, authenticate: self.authenticate, handler: self.handler, observed: { self.peakPreauthBytes = max(self.peakPreauthBytes, $0) }) { self.peers.removeValue(forKey: id) }
                        self.peers[id] = peer
                        self.peakTotal = max(self.peakTotal, self.peers.count)
                        self.peakUnauthenticated = max(self.peakUnauthenticated, self.peers.values.filter { !$0.authenticated }.count)
                        peer.start()
                    }
                    self.listener.start(queue: self.queue)
                }
            }
        } onCancel: { self.stop() }
    }
    private func shutdown() { stopped = true; let owned = Array(peers.values); for peer in owned { peer.close() }; listener.cancel() }
    public func stop() { queue.async { self.shutdown() } }
}
private final class BoundPeer: @unchecked Sendable {
    let connection: NWConnection, queue: DispatchQueue, limits: BoundTLSServer.Limits
    let authenticate: @Sendable (HTTPRequest) async -> Bool, handler: @Sendable (HTTPRequest) async -> HTTPResponse, removed: @Sendable () -> Void
    let observed: @Sendable (Int) -> Void
    var authenticated = false, closed = false, buffer = Data(), epoch = 0
    var task: Task<Void, Never>?
    init(_ connection: NWConnection, queue: DispatchQueue, limits: BoundTLSServer.Limits, authenticate: @escaping @Sendable (HTTPRequest) async -> Bool, handler: @escaping @Sendable (HTTPRequest) async -> HTTPResponse, observed: @escaping @Sendable (Int) -> Void, removed: @escaping @Sendable () -> Void) {
        self.connection = connection; self.queue = queue; self.limits = limits; self.authenticate = authenticate; self.handler = handler; self.removed = removed; self.observed = observed
    }
    func deadline(_ seconds: Double) { epoch += 1; let current = epoch; queue.asyncAfter(deadline: .now() + seconds) { if self.epoch == current { self.close() } } }
    func start() {
        deadline(limits.handshake)
        connection.stateUpdateHandler = { state in
            switch state { case .ready: self.deadline(self.limits.head); self.receive()
            case .failed, .cancelled: self.close()
            default: break }
        }
        connection.start(queue: queue)
    }
    func close() { guard !closed else { return }; closed = true; epoch += 1; task?.cancel(); buffer.removeAll(); connection.stateUpdateHandler = nil; connection.cancel(); removed() }
    func receive() {
        guard !closed else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: authenticated ? 65536 : max(1, 4096 - buffer.count)) { bytes, _, end, error in
            guard !self.closed else { return }
            if let bytes { self.buffer.append(bytes) }; if !self.authenticated { self.observed(self.buffer.count) }
            if !self.authenticated {
                guard let split = self.buffer.range(of: Data("\r\n\r\n".utf8)) else {
                    if self.buffer.count >= 4096 || end || error != nil { self.close() } else { self.receive() }; return
                }
                guard split.upperBound <= 4096, let raw = String(data: self.buffer[..<split.lowerBound], encoding: .utf8) else { self.close(); return }
                // Parse the actual bounded head without fabricating a POST dispatch.
                let lines = raw.components(separatedBy: "\r\n"), first = lines[0].split(separator: " ")
                guard first.count == 3, ["GET", "POST"].contains(String(first[0])), first[2] == "HTTP/1.1" else { self.close(); return }
                var headers: [String: String] = [:]
                for line in lines.dropFirst() {
                    let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
                    guard parts.count == 2, headers[parts[0].lowercased()] == nil else { self.close(); return }
                    headers[parts[0].lowercased()] = parts[1].trimmingCharacters(in: .whitespaces)
                }
                guard headers["transfer-encoding"] == nil,
                      headers["content-length"] == nil || headers["content-length"]!.range(of: "^[0-9]{1,7}$", options: .regularExpression) != nil,
                      let length = Int(headers["content-length"] ?? "0"), length <= 1_000_000 else { self.close(); return }
                let head = HTTPRequest(method: String(first[0]), target: String(first[1]), headers: headers, body: Data())
                if head.path == "/v1/identity" && (length != 0 || head.method != "GET" || head.target != head.path) { self.close(); return }
                self.task = Task {
                    let allowed = await self.authenticate(head)
                    self.queue.async {
                        guard !self.closed else { return }
                        guard allowed else { self.send(.error("Guest credential rejected.", status: 401)); return }
                        self.authenticated = true; self.deadline(self.limits.body); self.process(end: end || error != nil)
                    }
                }
                return
            }
            self.process(end: end || error != nil)
        }
    }
    func process(end: Bool) {
        do {
            if let request = try HTTPParser.parse(buffer) {
                buffer.removeAll(); deadline(limits.work)
                task = Task { let response = await handler(request); queue.async { if !self.closed { self.send(response) } } }
            } else if end { close() } else { receive() }
        } catch { close() }
    }
    func send(_ response: HTTPResponse) {
        guard !closed else { return }; deadline(limits.write)
        let head = "HTTP/1.1 \(response.status) Response\r\nContent-Type: \(response.type)\r\nContent-Length: \(response.body.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + response.body, completion: .contentProcessed { _ in self.close() })
    }
}
