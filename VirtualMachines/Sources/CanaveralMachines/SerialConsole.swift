#if os(macOS)
import Foundation
import Observation
import Virtualization
import CanaveralVMCore
import Darwin

// The reader drains even when no window exists. Bounded storage avoids queued
// UI work or a full pipe blocking a noisy server's boot.
private final class SerialBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    private var active = true
    func receive(_ fd: Int32) {
        lock.lock(); defer { lock.unlock() }
        guard active else { return }
        var chunk = [UInt8](repeating: 0, count: 8192)
        let count = Darwin.read(fd, &chunk, chunk.count)
        if count > 0 { bytes.append(contentsOf: chunk.prefix(count)) }
        if bytes.count > 65536 { bytes = Data(bytes.suffix(65536)) }
    }
    func stop() { lock.lock(); active = false; lock.unlock() }
    func drain() -> Data {
        lock.lock(); defer { lock.unlock() }
        let result = bytes; bytes.removeAll(keepingCapacity: true); return result
    }
}

@MainActor @Observable public final class SerialConsole {
    public private(set) var output = ""
    public private(set) var closed = false
    public let attachment: VZFileHandleSerialPortAttachment
    private let input: Pipe, received: Pipe
    private let buffer = SerialBuffer()
    public init() {
        let input = Pipe(), received = Pipe(); self.input = input; self.received = received
        attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: input.fileHandleForReading, fileHandleForWriting: received.fileHandleForWriting)
        let reading = received.fileHandleForReading.fileDescriptor, writing = input.fileHandleForWriting.fileDescriptor
        _ = fcntl(reading, F_SETFL, fcntl(reading, F_GETFL) | O_NONBLOCK)
        _ = fcntl(writing, F_SETFL, fcntl(writing, F_GETFL) | O_NONBLOCK)
        _ = fcntl(writing, F_SETNOSIGPIPE, 1)
        let buffer = buffer
        received.fileHandleForReading.readabilityHandler = { _ in buffer.receive(reading) }
    }
    public func refresh() {
        let bytes = buffer.drain(); guard !bytes.isEmpty else { return }
        // This is a plain serial transcript, not a terminal emulator. Remove
        // complete ANSI control sequences before presenting native readable text.
        let text = String(decoding: bytes, as: UTF8.self)
            .replacingOccurrences(of: "\u{1B}\\[[0-?]*[ -/]*[@-~]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\r", with: "")
        output = String((output + text).suffix(65536))
    }
    public func sendLine(_ text: String) throws {
        guard !closed, text.utf8.count <= 4096, !text.contains("\n"), !text.contains("\r") else { throw CanaveralError.invalid("Send a single console line, up to 4 KB, while the server is running.") }
        try input.fileHandleForWriting.write(contentsOf: Data((text + "\r").utf8))
    }
    public func interrupt() throws {
        guard !closed else { throw CanaveralError.invalid("The serial console is closed.") }
        try input.fileHandleForWriting.write(contentsOf: Data([3]))
    }
    public func close() {
        guard !closed else { return }; closed = true
        received.fileHandleForReading.readabilityHandler = nil; buffer.stop(); refresh()
        for handle in [input.fileHandleForReading, input.fileHandleForWriting, received.fileHandleForReading, received.fileHandleForWriting] { try? handle.close() }
    }
}
#endif
