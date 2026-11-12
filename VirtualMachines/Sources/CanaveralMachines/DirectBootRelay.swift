#if os(macOS)
import Foundation
import Virtualization
import Darwin
import CanaveralVMCore

/// Independent, single-use control and data channels share only directory lifetime.
@MainActor final class DirectBootRelay {
    let directory: URL
    var socketPath: String { directory.appendingPathComponent("agent.sock").path }
    var dataSocketPath: String { directory.appendingPathComponent("data.sock").path }
    private var control: DirectBootChannel?
    private var data: DirectBootChannel?
    init(vm: VZVirtualMachine, version: Int = 1) throws {
        directory = URL(fileURLWithPath: "/private/tmp/canaveral-" + UUID().uuidString.lowercased())
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        do {
            guard let device = vm.socketDevices.first as? VZVirtioSocketDevice else { throw CanaveralError.unavailable("Missing vsock device.") }
            control = try DirectBootChannel(socketPath: socketPath, port: 1024, device: device)
if version == 2 {
    do { data = try DirectBootChannel(socketPath: dataSocketPath, port: 1025, device: device) }
    catch { NSLog("Canaveral data relay unavailable; control and VM remain active.") }
}
        } catch { stop(); throw error }
    }
    static func authorizedPeer(_ fd: Int32) -> Bool { DirectBootChannel.authorizedPeer(fd) }
    func stop() {
        control?.stop(); control = nil
        data?.stop(); data = nil
        try? FileManager.default.removeItem(at: directory)
    }
}

@MainActor final class DirectBootChannel {
    private let socketPath: String
    private let port: UInt32
    private var listener: Int32 = -1
    private var task: Task<Void, Never>?
    private var channel: DirectBootPump?
    private var connection: VZVirtioSocketConnection?
    private var stopped = false
/// Connector injection exercises the real Unix accept/authentication lifecycle without a VM.
init(socketPath: String, port: UInt32, device: VZVirtioSocketDevice? = nil,
     connector: ((UInt32, DirectBootPump) -> Void)? = nil) throws {

        self.socketPath = socketPath; self.port = port
        do {
            listener = socket(AF_UNIX, SOCK_STREAM, 0)
            guard listener >= 0 else { throw CanaveralError.unavailable("Cannot create agent listener.") }
            _ = fcntl(listener, F_SETFD, FD_CLOEXEC)
            _ = fcntl(listener, F_SETFL, O_NONBLOCK)
            var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
            let bytes = Array(socketPath.utf8) + [0]
            guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw CanaveralError.invalid("Agent socket path too long.") }
            withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
            let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            guard result == 0, chmod(socketPath, 0o600) == 0, listen(listener, 1) == 0 else { throw CanaveralError.unavailable("Cannot bind private agent transport.") }
            task = Task { [weak self] in
                while let self, !Task.isCancelled, !self.stopped {
                    let fd = accept(self.listener, nil, nil)
                    if fd >= 0 {
                        guard Self.authorizedPeer(fd) else { close(fd); continue }
                        close(self.listener); self.listener = -1
                        let pump = DirectBootPump(local: fd); self.channel = pump
                        if let connector { connector(self.port, pump) }
                        else if let device { self.connectGuest(device, pump: pump, until: ContinuousClock.now + Self.guestConnectWindow) }
                        else { pump.stop() }
                        return
                    }
                    if errno != EAGAIN && errno != EINTR { self.stop(); return }
                    try? await Task.sleep(for: .milliseconds(50))
                }
            }
        } catch { stop(); throw error }
    }
    /// The guest agent listens only after PID1 boot and its tool probes. Bytes from the
    /// accepted local stream wait in its socket buffer; the window bounds that wait.
    static let guestConnectWindow: Duration = .seconds(60)
    private func connectGuest(_ device: VZVirtioSocketDevice, pump: DirectBootPump, until deadline: ContinuousClock.Instant) {
        device.connect(toPort: port) { [weak self] result in
            guard let self, !self.stopped else { if case .success(let c) = result { c.close() }; pump.stop(); return }
            switch result {
            case .success(let c):
                self.connection = c
                pump.start(remote: c.fileDescriptor) { [weak self] in
                    Task { @MainActor in self?.connection?.close(); self?.connection = nil }
                }
            case .failure:
                guard ContinuousClock.now < deadline else { pump.stop(); return }
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(250))
                    guard let self, !self.stopped else { pump.stop(); return }
                    self.connectGuest(device, pump: pump, until: deadline)
                }
            }
        }
    }
    static func authorizedPeer(_ fd: Int32) -> Bool {
        var uid: uid_t = 0, gid: gid_t = 0
        return getpeereid(fd, &uid, &gid) == 0 && uid == getuid()
    }
    func stop() {
        guard !stopped else { return }; stopped = true
        task?.cancel(); task = nil
        if listener >= 0 { close(listener); listener = -1 }
        channel?.stop(); channel = nil
        connection?.close(); connection = nil
        unlink(socketPath)
    }
}

/// Exactly 64 KiB of user-space relay storage, one writer per direction, no message parsing.
final class DirectBootPump: @unchecked Sendable {
    private let lock = NSLock()
    private let worker = DispatchGroup()
    private var local: Int32
    private var remote: Int32 = -1
    private var stopped = false
    private var started = false
    var descriptorsClosed: Bool { lock.lock(); defer { lock.unlock() }; return local < 0 && remote < 0 }
    init(local: Int32) { self.local = local; _ = fcntl(local, F_SETFD, FD_CLOEXEC) }
    func stop() {
        lock.lock()
        stopped = true
        if local >= 0 { shutdown(local, SHUT_RDWR) }
        if remote >= 0 { shutdown(remote, SHUT_RDWR) }
        if remote < 0, local >= 0 { close(local); local = -1 }
        lock.unlock()
        // Poll wakes within 100ms; do not release native stop proof with duplicated fds held.
        worker.wait()
    }
    func start(remote source: Int32, finished: @escaping @Sendable () -> Void) {
        lock.lock()
        guard !started else { lock.unlock(); return }; started = true
        guard !stopped else { lock.unlock(); finished(); return }
        remote = dup(source)
        guard remote >= 0 else { lock.unlock(); stop(); finished(); return }
        let a = local, b = remote
        for fd in [a, b] {
            _ = fcntl(fd, F_SETFD, FD_CLOEXEC); _ = fcntl(fd, F_SETFL, O_NONBLOCK)
            var yes: Int32 = 1; _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
        }
        worker.enter()
        lock.unlock()
        DispatchQueue.global().async { [self] in
            defer {
                lock.lock(); close(local); close(remote); local = -1; remote = -1; stopped = true; lock.unlock(); worker.leave(); finished()
            }
            var buffers = [[UInt8](repeating: 0, count: 32768), [UInt8](repeating: 0, count: 32768)]
            var count = [0, 0], offset = [0, 0], eof = [false, false], halfClosed = [false, false]
            let fds = [a, b]
            while true {
                lock.lock(); let done = stopped; lock.unlock(); if done { return }
                for i in 0..<2 where eof[i] && count[i] == 0 && !halfClosed[i] { shutdown(fds[1-i], SHUT_WR); halfClosed[i] = true }
                if halfClosed.allSatisfy({ $0 }) { return }
                var polls = (0..<2).map { i in pollfd(fd: fds[i], events: (count[i] == 0 && !eof[i] ? Int16(POLLIN) : 0) | (count[1-i] > 0 ? Int16(POLLOUT) : 0), revents: 0) }
                let n = poll(&polls, 2, 100)
                if n < 0 { if errno == EINTR { continue }; return }
                for i in 0..<2 {
                    if polls[i].revents & Int16(POLLERR | POLLNVAL) != 0 { return }
                    if count[i] == 0 && !eof[i] && polls[i].revents & Int16(POLLIN | POLLHUP) != 0 {
                        let n = Darwin.read(fds[i], &buffers[i], 32768)
                        if n > 0 { count[i] = n; offset[i] = 0 }
                        else if n == 0 { eof[i] = true }
                        else if errno != EAGAIN && errno != EINTR { return }
                    }
                    let j = 1-i
                    if count[j] > 0 && polls[i].revents & Int16(POLLOUT) != 0 {
                        let n = buffers[j].withUnsafeBytes { Darwin.write(fds[i], $0.baseAddress!.advanced(by: offset[j]), count[j]) }
                        if n > 0 { offset[j] += n; count[j] -= n }
                        else if n == 0 || (errno != EAGAIN && errno != EINTR) { return }
                    }
                }
            }
        }
    }
}
#endif
