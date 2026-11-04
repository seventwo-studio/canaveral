import Foundation
@preconcurrency import Network

public struct HTTPRequest: Sendable {
    public var method: String; public var target: String; public var headers: [String: String]; public var body: Data
    public init(method: String, target: String, headers: [String: String], body: Data) { self.method = method; self.target = target; self.headers = headers; self.body = body }
    public var path: String { String(target.split(separator: "?", maxSplits: 1).first ?? "") }
    public var query: [String: String] { Dictionary((URLComponents(string: "http://127.0.0.1\(target)")?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _, last in last }) }
    public var bearer: String { headers["authorization"].flatMap { $0.hasPrefix("Bearer ") ? String($0.dropFirst(7)) : nil } ?? "" }
}
public struct HTTPResponse: Sendable {
    public var status: Int; public var type: String; public var body: Data
    public init(status: Int = 200, type: String = "application/json", body: Data) { self.status = status; self.type = type; self.body = body }
    public static func json<T: Encodable>(_ value: T, status: Int = 200) throws -> Self { .init(status: status, body: try JSONEncoder().encode(value)) }
    public static func error(_ message: String, status: Int) -> Self { try! .json(APIError(message), status: status) }
}
public enum HTTPParser {
    public static func parse(_ data: Data) throws -> HTTPRequest? {
        guard data.count <= 1_100_000 else { throw CanaveralError.invalid("Request too large.") }
        guard let split = data.range(of: Data("\r\n\r\n".utf8)) else {
            guard data.count < 16384 else { throw CanaveralError.invalid("Headers too large.") }; return nil
        }
        guard split.lowerBound < 16384, let header = String(data: data[..<split.lowerBound], encoding: .utf8) else { throw CanaveralError.invalid("Invalid headers.") }
        let lines = header.components(separatedBy: "\r\n"); let first = lines[0].split(separator: " ")
        guard first.count == 3, ["GET", "POST"].contains(String(first[0])), first[1].hasPrefix("/"), first[2] == "HTTP/1.1" else { throw CanaveralError.invalid("Invalid request line.") }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { throw CanaveralError.invalid("Invalid header.") }
            let key = parts[0].lowercased(); guard headers[key] == nil else { throw CanaveralError.invalid("Duplicate headers are not supported.") }
            headers[key] = parts[1].trimmingCharacters(in: .whitespaces)
        }
        guard headers["transfer-encoding"] == nil else { throw CanaveralError.invalid("Chunked requests are not supported.") }
        let length = headers["content-length"].flatMap(Int.init) ?? 0
        guard length >= 0, length <= 1_000_000, headers["content-length"] == nil || Int(headers["content-length"]!) != nil else { throw CanaveralError.invalid("Invalid body length.") }
        if data.count < split.upperBound + length { return nil }
        guard data.count == split.upperBound + length else { throw CanaveralError.invalid("Pipelined requests are not supported.") }
        return HTTPRequest(method: String(first[0]), target: String(first[1]), headers: headers, body: Data(data[split.upperBound...]))
    }
}
public final class LoopbackServer: @unchecked Sendable {
    private let listener: NWListener
    private let handler: @Sendable (HTTPRequest) async -> HTTPResponse
    public init(port: UInt16 = 8765, handler: @escaping @Sendable (HTTPRequest) async -> HTTPResponse) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        self.listener = try NWListener(using: parameters); self.handler = handler
    }
    public func run(onReady: @escaping @Sendable () -> Void = {}) async throws {
        let listener = listener, handler = handler
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let completion = ListenerCompletion(continuation)
                listener.stateUpdateHandler = { state in
                    switch state { case .ready: onReady(); case .failed(let error): completion.finish(error); case .cancelled: completion.finish(nil); default: break }
                }
                listener.newConnectionHandler = { connection in
                    let peer = HTTPPeer(connection: connection, handler: handler)
                    connection.start(queue: .global())
                    Task { await peer.start() }
                }
                listener.start(queue: .global())
            }
        } onCancel: { listener.cancel() }
    }
    public func stop() { listener.cancel() }
}
private final class ListenerCompletion: @unchecked Sendable {
    private let lock = NSLock(); private var continuation: CheckedContinuation<Void, any Error>?
    init(_ continuation: CheckedContinuation<Void, any Error>) { self.continuation = continuation }
    func finish(_ error: (any Error)?) {
        lock.lock(); let c = continuation; continuation = nil; lock.unlock()
        if let error { c?.resume(throwing: error) } else { c?.resume() }
    }
}
private actor HTTPPeer {
    private let connection: NWConnection
    private let handler: @Sendable (HTTPRequest) async -> HTTPResponse
    private var buffer = Data(); private var finished = false; private var work: Task<Void, Never>?
    init(connection: NWConnection, handler: @escaping @Sendable (HTTPRequest) async -> HTTPResponse) { self.connection = connection; self.handler = handler }
    func start() {
        receive()
        Task { try? await Task.sleep(for: .seconds(30)); self.close() }
    }
    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
            Task { await self.received(data, complete: complete, failed: error != nil) }
        }
    }
    private func received(_ data: Data?, complete: Bool, failed: Bool) {
        guard !finished else { return }
        if let data { buffer.append(data) }
        do {
            if let request = try HTTPParser.parse(buffer) {
                work = Task {
                    let response = await handler(request)
                    self.send(response)
                }
            } else if complete || failed { close() } else { receive() }
        } catch { send(.error(error.localizedDescription, status: 400)) }
    }
    private func send(_ response: HTTPResponse) {
        guard !finished else { return }; finished = true
        let header = "HTTP/1.1 \(response.status) \(response.status == 200 ? "OK" : "Error")\r\nContent-Type: \(response.type)\r\nContent-Length: \(response.body.count)\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n"
        connection.send(content: Data(header.utf8) + response.body, completion: .contentProcessed { _ in self.connection.cancel() })
    }
    private func close() { finished = true; work?.cancel(); connection.cancel() }
}
