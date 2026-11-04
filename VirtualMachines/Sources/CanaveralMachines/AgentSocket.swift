#if os(macOS)
import Foundation
import Darwin
import CanaveralVMCore

/// Bounded newline JSON over a private virtio socket. All file I/O runs off the VM queue.
public final class AgentSocket: @unchecked Sendable {
    private let descriptor: Int32
    private let lock = NSLock()
    private var canceled = false
    private var buffer = Data()
    public init(duplicating descriptor: Int32) throws {
        let fd = dup(descriptor)
        guard fd >= 0 else { throw CanaveralError.unavailable("Cannot duplicate the agent socket.") }
        self.descriptor = fd
        var yes: Int32 = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    }
    deinit { close(descriptor) }
    public func cancel() { lock.lock(); canceled = true; lock.unlock() }
    public func peerClosed() -> Bool {
        var byte: UInt8 = 0
        let count = recv(descriptor, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
        return count == 0 || (count < 0 && errno != EAGAIN && errno != EINTR)
    }
    private func check(_ deadline: Date) throws {
        lock.lock(); let stopped = canceled; lock.unlock()
        if stopped || Date() >= deadline { throw CanaveralError.interrupted }
    }
    public func write(_ value: JSONValue, deadline: Date) throws {
        var bytes = try JSONEncoder().encode(value); bytes.append(10)
        guard bytes.count <= 10_000_000 else { throw CanaveralError.invalid("Agent message is too large.") }
        var position = 0
        while position < bytes.count {
            try check(deadline)
            var fd = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
            guard poll(&fd, 1, 100) > 0 else { continue }
            let count = bytes.withUnsafeBytes { raw in Darwin.write(descriptor, raw.baseAddress!.advanced(by: position), bytes.count - position) }
            if count > 0 { position += count }
            else if count < 0, errno == EAGAIN || errno == EINTR { continue }
            else { throw CanaveralError.interrupted }
        }
    }
    public func read(deadline: Date) throws -> JSONValue {
        while true {
            try check(deadline)
            if let end = buffer.firstIndex(of: 10) {
                let data = Data(buffer[..<end]); buffer.removeSubrange(...end)
                return try JSONDecoder().decode(JSONValue.self, from: data)
            }
            guard buffer.count <= 10_000_000 else { throw CanaveralError.invalid("Agent message is too large.") }
            var fd = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            guard poll(&fd, 1, 100) > 0 else { continue }
            var bytes = [UInt8](repeating: 0, count: 8192)
            let count = Darwin.read(descriptor, &bytes, bytes.count)
            if count > 0 { buffer.append(contentsOf: bytes.prefix(count)) }
            else if count < 0, errno == EAGAIN || errno == EINTR { continue }
            else { throw CanaveralError.interrupted }
        }
    }
    public func exchange(_ request: JSONValue) async throws -> JSONValue {
        try await withTaskCancellationHandler {
            try await Task.detached { [self] in
                let deadline = Date().addingTimeInterval(request.object?["method"]?.string == "workerTool" ? 70 : 25)
                try write(request, deadline: deadline)
                let response = try read(deadline: deadline)
                if let error = response.object?["error"]?.string { throw CanaveralError.unavailable(error) }
                guard let output = response.object?["output"] else { throw CanaveralError.interrupted }; return output
            }.value
        } onCancel: { self.cancel() }
    }
}
#endif
