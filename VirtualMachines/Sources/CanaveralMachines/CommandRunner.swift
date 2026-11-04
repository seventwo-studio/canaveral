import Foundation
import CanaveralVMCore
public enum CommandRunner {
    public static func run(_ command: String, directory: URL, network: Bool) async throws -> String {
        let process = ProcessHandle(command: command, directory: directory, network: network)
        return try await withTaskCancellationHandler { try Task.checkCancellation(); return try await process.run() } onCancel: { process.cancel() }
    }
}
private final class ProcessHandle: @unchecked Sendable {
    private let lock = NSLock(); private var canceled = false; private var pid: pid_t = 0
    private let command: String; private let directory: URL; private let network: Bool
    init(command: String, directory: URL, network: Bool) { self.command = command; self.directory = directory; self.network = network }
    func run() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                var pipes: [Int32] = [0, 0]
                guard pipe(&pipes) == 0 else { continuation.resume(throwing: CanaveralError.unavailable("Could not create command output pipe.")); return }
                defer { close(pipes[0]) }
                var actions: posix_spawn_file_actions_t?
                var attributes: posix_spawnattr_t?
                posix_spawn_file_actions_init(&actions); posix_spawnattr_init(&attributes)
                defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes) }
                posix_spawn_file_actions_adddup2(&actions, pipes[1], STDOUT_FILENO)
                posix_spawn_file_actions_adddup2(&actions, pipes[1], STDERR_FILENO)
                posix_spawn_file_actions_addclose(&actions, pipes[0])
                posix_spawn_file_actions_addclose(&actions, pipes[1])
                posix_spawn_file_actions_addchdir(&actions, self.directory.path)
                posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
                posix_spawnattr_setpgroup(&attributes, 0)
                // The service handles signals through DispatchSource. Do not inherit its ignored signals.
                var defaults = sigset_t(); sigfillset(&defaults)
                sigdelset(&defaults, SIGKILL); sigdelset(&defaults, SIGSTOP)
                var mask = sigset_t(); sigemptyset(&mask)
                posix_spawnattr_setsigdefault(&attributes, &defaults)
                posix_spawnattr_setsigmask(&attributes, &mask)
                let home = FileManager.default.homeDirectoryForCurrentUser.path
                let escaped = home.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
                let policy = "(version 1)(allow default)(deny file-read* file-write* (subpath \"\(escaped)/Library/Keychains\"))(deny file-read* file-write* (subpath \"\(escaped)/Library/Application Support/Seven\"))(allow file-read* file-write* (subpath \"\(escaped)/Library/Application Support/Seven/Projects\"))" + (self.network ? "" : "(deny network*)")
                let arguments = ["/usr/bin/sandbox-exec", "-p", policy, "/bin/zsh", "-c", self.command]
                let environment = ["PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", "HOME=\(home)", "TMPDIR=\(NSTemporaryDirectory())", "LANG=en_US.UTF-8"]
                let argv = arguments.map { strdup($0) } + [nil]
                let envp = environment.map { strdup($0) } + [nil]
                defer { for p in argv + envp { free(p) } }
                self.lock.lock()
                if self.canceled { self.lock.unlock(); close(pipes[1]); continuation.resume(throwing: CancellationError()); return }
                var child: pid_t = 0
                let result = argv.withUnsafeBufferPointer { a in envp.withUnsafeBufferPointer { e in
                    posix_spawn(&child, arguments[0], &actions, &attributes, UnsafeMutablePointer(mutating: a.baseAddress!), UnsafeMutablePointer(mutating: e.baseAddress!))
                } }
                if result == 0 { self.pid = child }
                self.lock.unlock(); close(pipes[1])
                guard result == 0 else { continuation.resume(throwing: CanaveralError.unavailable("Command launch failed (\(result)).")); return }
                let end = Date().addingTimeInterval(60)
                var output = Data(); var buffer = [UInt8](repeating: 0, count: 8192)
                while true {
                    if Date() > end { self.cancel() }
                    var descriptor = pollfd(fd: pipes[0], events: Int16(POLLIN | POLLHUP), revents: 0)
                    let ready = poll(&descriptor, 1, 100)
                    if ready > 0 {
                        let count = read(pipes[0], &buffer, buffer.count)
                        if count <= 0 { break }
                        if output.count < 65536 { output.append(contentsOf: buffer.prefix(min(count, 65536-output.count))) }
                    }
                }
                var status: Int32 = 0
                var waited: pid_t
                repeat { waited = waitpid(child, &status, 0) } while waited == -1 && errno == EINTR
                // Remove descendants that retained the output pipe or outlived their shell.
                kill(-child, SIGKILL)
                self.lock.lock(); self.pid = 0; let wasCanceled = self.canceled; self.lock.unlock()
                if wasCanceled { continuation.resume(throwing: CancellationError()) }
                else if waited != child { continuation.resume(throwing: CanaveralError.unavailable("Could not confirm the command's exit status.")) }
                else {
                    let exit = status & 0x7f == 0 ? "Exit \((status >> 8) & 255)" : "Terminated by signal \(status & 0x7f)"
                    continuation.resume(returning: exit + "\n" + String(decoding: output, as: UTF8.self))
                }
            }
        }
    }
    func cancel() {
        lock.lock(); canceled = true; let child = pid; lock.unlock()
        if child > 0 {
            kill(-child, SIGTERM)
            DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
                self.lock.lock(); let stillRunning = self.pid == child; self.lock.unlock()
                if stillRunning { kill(-child, SIGKILL) }
            }
        }
    }
}
