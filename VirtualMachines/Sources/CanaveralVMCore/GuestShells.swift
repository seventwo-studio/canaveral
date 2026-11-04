import Foundation
import Darwin
import CanaveralGuestPTYSupport

public struct GuestPTYOutput: Sendable {
    public var data: Data, offset: Int64, truncated: Bool, exited: Bool, exitCode: Int?
    public init(data: Data, offset: Int64, truncated: Bool, exited: Bool, exitCode: Int?) {
        self.data=data; self.offset=offset; self.truncated=truncated; self.exited=exited; self.exitCode=exitCode
    }
}
public protocol GuestPTY: Sendable {
    func output(offset: Int64) throws -> GuestPTYOutput
    func write(_ data: Data) throws
    func resize(columns: UInt16, rows: UInt16) throws
    /// True confirms the direct child was reaped and the PTY closed, not detached guest execution fencing.
    func stop() throws -> Bool
}

private final class GuestPTYDescriptorClosure: @unchecked Sendable {
    private let lock=NSLock()
    private var closed=false
    func complete(_ result: Bool) { lock.lock(); closed=result; lock.unlock() }
    func confirmed() -> Bool { lock.lock(); defer { lock.unlock() }; return closed }
}

/// Owned direct child and PTY. Production supplies the native virtual-guest guard.
public final class GuestNativePTY: GuestPTY, @unchecked Sendable {
    private let lock=NSLock()
    private var descriptor: Int32, child: pid_t
    private var source: (any DispatchSourceRead)?
    private var buffer=Data(), base: Int64=0
    private var ended=false, stopping=false, closed=false, ownershipLost=false
    private var readFailed=false, reaped=false
    private let descriptorClosure=GuestPTYDescriptorClosure()
    public init(directory: URL, argv: [String], environment: [String:String], columns: UInt16, rows: UInt16,
                permitted: @Sendable () -> Bool) throws {
        guard permitted() else { throw CanaveralError.unavailable("Native PTYs are unavailable outside an authorized virtual guest.") }
        guard let executable=argv.first, executable.hasPrefix("/"), !argv.contains(where: { $0.contains("\0") }),
              !environment.contains(where: { $0.key.contains("=") || $0.key.contains("\0") || $0.value.contains("\0") }) else {
            throw CanaveralError.invalid("Invalid native PTY configuration.")
        }
        var master: Int32 = -1, slave: Int32 = -1, size=winsize(ws_row:rows,ws_col:columns,ws_xpixel:0,ws_ypixel:0)
        guard openpty(&master,&slave,nil,nil,&size) == 0 else { throw CanaveralError.unavailable("Guest PTY allocation failed.") }
        var keep=false
        defer { Darwin.close(slave); if !keep { Darwin.close(master) } }
        guard fcntl(master,F_SETFD,FD_CLOEXEC) == 0, fcntl(slave,F_SETFD,FD_CLOEXEC) == 0,
              fcntl(master,F_SETFL,O_NONBLOCK) == 0 else { throw CanaveralError.unavailable("Guest PTY descriptor configuration failed.") }
        var name=[CChar](repeating:0,count:1024)
        guard ttyname_r(slave,&name,name.count) == 0 else { throw CanaveralError.unavailable("Guest PTY identity is unavailable.") }
        let terminal=String(decoding:name.prefix { $0 != 0 }.map { UInt8(bitPattern:$0) },as:UTF8.self)
        var actions: posix_spawn_file_actions_t?, attributes: posix_spawnattr_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw CanaveralError.unavailable("Guest PTY spawn setup failed.") }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawnattr_init(&attributes) == 0 else { throw CanaveralError.unavailable("Guest PTY attributes failed.") }
        defer { posix_spawnattr_destroy(&attributes) }
        // Open the slave in the new session, rather than inheriting a host terminal.
        var defaults=sigset_t(), mask=sigset_t(); sigfillset(&defaults); sigemptyset(&mask)
        sigdelset(&defaults,SIGKILL); sigdelset(&defaults,SIGSTOP)
        guard posix_spawn_file_actions_addopen(&actions,STDIN_FILENO,terminal,O_RDWR,0) == 0,
              posix_spawn_file_actions_adddup2(&actions,STDIN_FILENO,STDOUT_FILENO) == 0,
              posix_spawn_file_actions_adddup2(&actions,STDIN_FILENO,STDERR_FILENO) == 0,
              posix_spawn_file_actions_addchdir(&actions,directory.path) == 0,
              posix_spawnattr_setflags(&attributes,Int16(POSIX_SPAWN_SETSID|POSIX_SPAWN_CLOEXEC_DEFAULT|POSIX_SPAWN_SETSIGDEF|POSIX_SPAWN_SETSIGMASK)) == 0,
              posix_spawnattr_setsigdefault(&attributes,&defaults) == 0, posix_spawnattr_setsigmask(&attributes,&mask) == 0 else {
            throw CanaveralError.unavailable("Guest PTY session setup failed.")
        }
        let arguments=argv.map { strdup($0) }+[nil], variables=environment.map { strdup($0.key+"="+$0.value) }+[nil]
        defer { for pointer in arguments+variables { free(pointer) } }
        var pid: pid_t=0
        let result=arguments.withUnsafeBufferPointer { a in variables.withUnsafeBufferPointer { e in
            posix_spawn(&pid,executable,&actions,&attributes,UnsafeMutablePointer(mutating:a.baseAddress!),UnsafeMutablePointer(mutating:e.baseAddress!))
        } }
        guard result == 0, pid > 0 else { throw CanaveralError.unavailable("Guest shell launch failed (\(result)).") }
        descriptor=master; child=pid; keep=true
        let events=DispatchSource.makeReadSource(fileDescriptor:master,queue:DispatchQueue.global(qos:.userInitiated))
        source=events; events.setEventHandler { [weak self] in self?.receive() }
        let terminalDescriptor=master
        let closure=descriptorClosure
        events.setCancelHandler { let result=Darwin.close(terminalDescriptor); closure.complete(result == 0) }; events.activate()
    }
    deinit {
        // No recovered PID is signalled. An unreaped direct child still pins its identity.
        source?.cancel()
        if !closed, !reaped, !ownershipLost {
            var info=siginfo_t()
            if waitid(P_PID,id_t(child),&info,WEXITED|WNOHANG|WNOWAIT) == 0 {
                _=Darwin.kill(-child,SIGKILL)
                let pid=child
                DispatchQueue.global().async { var status: Int32=0; while waitpid(pid,&status,0) == -1 && errno == EINTR {} }
            }
        }
    }
    private func receive() { lock.lock(); defer { lock.unlock() }; drain() }
    private func drain() {
        guard !closed, !ended else { return }
        var data=[UInt8](repeating:0,count:16384), remaining=65536
        while remaining > 0 {
            let count=Darwin.read(descriptor,&data,min(data.count,remaining))
            if count > 0 {
                buffer.append(contentsOf:data.prefix(count)); remaining-=count
                let excess=max(0,buffer.count-65536)
                if excess > 0 { buffer.removeFirst(excess); base+=Int64(excess) }
            } else if count == 0 || (count < 0 && errno == EIO) { ended=true; source?.cancel(); source=nil; return }
            else if errno == EINTR { continue }
            else if errno == EAGAIN || errno == EWOULDBLOCK { return }
            else { ended=true; readFailed=true; source?.cancel(); source=nil; return }
        }
    }
    private func exitState() throws -> Int? {
        guard !ownershipLost else { throw CanaveralError.unavailable("Guest shell child ownership is uncertain.") }
        var info=siginfo_t()
        guard waitid(P_PID,id_t(child),&info,WEXITED|WNOHANG|WNOWAIT) == 0 else {
            if errno == ECHILD { ownershipLost=true }
            throw CanaveralError.unavailable("Guest shell exit could not be observed without reaping it.")
        }
        guard info.si_pid == child else { return nil }
        return info.si_code == CLD_EXITED ? Int(info.si_status) : 128+Int(info.si_status)
    }
    public func output(offset: Int64) throws -> GuestPTYOutput {
        lock.lock(); defer { lock.unlock() }
        guard !closed, !reaped else { throw CanaveralError.unavailable("Guest PTY is closed.") }
        drain()
        guard !readFailed else { throw CanaveralError.unavailable("Guest terminal output failed; its completion is unknown.") }
        let end=base+Int64(buffer.count)
        guard end <= 9007199254740991, offset >= 0, offset <= end else { throw CanaveralError.invalid("Guest terminal cursor is ahead of output.") }
        let actual=max(base,offset), exit=try exitState()
        return .init(data:Data(buffer.dropFirst(Int(actual-base))),offset:end,truncated:offset < base,exited:ended && exit != nil,exitCode:exit)
    }
    public func write(_ data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard !closed, !stopping, !ended, try exitState() == nil else { throw CanaveralError.unavailable("Guest shell is not accepting input.") }
        try data.withUnsafeBytes { raw in
            var offset=0
            while offset < raw.count {
                let count=Darwin.write(descriptor,raw.baseAddress!.advanced(by:offset),raw.count-offset)
                if count > 0 { offset+=count }
                else if count < 0 && errno == EINTR { continue }
                else { throw CanaveralError.unavailable("Guest terminal input stopped after \(offset) bytes; inspect before sending it again.") }
            }
        }
    }
    public func resize(columns: UInt16, rows: UInt16) throws {
        lock.lock(); defer { lock.unlock() }
        guard !closed, !stopping, !ended else { throw CanaveralError.unavailable("Guest PTY is closing.") }
        var size=winsize(ws_row:rows,ws_col:columns,ws_xpixel:0,ws_ypixel:0)
        guard ioctl(descriptor,TIOCSWINSZ,&size) == 0 else { throw CanaveralError.unavailable("Guest terminal resize was not confirmed.") }
    }
    private func groupHasOnlyZombies() throws -> Bool {
        // Only inspect the owned process group while its unreaped leader pins the ID.
        var mib: [Int32]=[CTL_KERN,KERN_PROC,KERN_PROC_PGRP,child], size=0
        guard sysctl(&mib,u_int(mib.count),nil,&size,nil,0) == 0,
              size > 0, size <= 16*1024*1024 else { throw CanaveralError.unavailable("Owned PTY group observation is unavailable.") }
        let stride=MemoryLayout<kinfo_proc>.stride
        var members=[kinfo_proc](repeating:kinfo_proc(),count:size/stride+16)
        size=members.count*stride
        let result=members.withUnsafeMutableBytes { sysctl(&mib,u_int(mib.count),$0.baseAddress,&size,nil,0) }
        guard result == 0, size > 0, size % stride == 0, size/stride <= members.count else {
            throw CanaveralError.unavailable("Owned PTY group changed during observation.")
        }
        let observed=members.prefix(size/stride)
        guard observed.contains(where:{ $0.kp_proc.p_pid == child && $0.kp_proc.p_stat == SZOMB }),
              observed.allSatisfy({ $0.kp_eproc.e_pgid == child }) else {
            throw CanaveralError.unavailable("Owned PTY group leader could not be verified.")
        }
        return observed.allSatisfy { $0.kp_proc.p_stat == SZOMB }
    }
    public func stop() throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        if closed { return true }
        if reaped { closed=descriptorClosure.confirmed(); return closed }
        _=try exitState() // Prove direct-child ownership before any group signal.
        if !stopping {
            // The kernel selects this held PTY's current foreground group. Never
            // signal a separately observed foreground PGID that could be reused.
            if !ended {
                guard canaveral_pty_signal(descriptor,SIGKILL) == 0 else {
                    throw CanaveralError.unavailable("Guest foreground terminal stop was not confirmed.")
                }
            }
            let result=Darwin.kill(-child,SIGKILL), failure=errno
            if result != 0, failure != ESRCH {
                guard failure == EPERM, try exitState() != nil, try groupHasOnlyZombies() else {
                    throw CanaveralError.unavailable("Guest shell group signal was not confirmed (errno \(failure)).")
                }
            }
            stopping=true
        }
        guard try exitState() != nil, try groupHasOnlyZombies() else { return false }
        var status: Int32=0, result: pid_t
        repeat { result=waitpid(child,&status,WNOHANG) } while result == -1 && errno == EINTR
        guard result >= 0 else { ownershipLost=true; throw CanaveralError.unavailable("Guest shell reap is uncertain.") }
        if result == 0 { return false }
        reaped=true; source?.cancel(); source=nil
        closed=descriptorClosure.confirmed(); return closed
    }
}

private struct GuestShellRecord: Codable {
    var version=1
    var id: UUID, columns: UInt16, rows: UInt16, state: String
}
private struct GuestShellEntry {
    let terminal: any GuestPTY
    var record: GuestShellRecord
}

/// Session UUIDs are never resumed as processes after helper restart.
public actor GuestShells: GuestWorkspaceService {
    public typealias Factory = @Sendable (UInt16,UInt16) throws -> any GuestPTY
    private let permitted: @Sendable () -> Bool, factory: Factory
    private let state: Int32
    private var sessions: [UUID:GuestShellEntry]=[:]
    private var fenced=false
    public init(state: URL, permitted: @escaping @Sendable () -> Bool, factory: @escaping Factory) throws {
        guard permitted() else { throw CanaveralError.unavailable("Guest shells are unavailable outside an authorized virtual guest.") }
        try FileManager.default.createDirectory(at:state,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let descriptor=open(state.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
        guard descriptor >= 0 else { throw CanaveralError.unavailable("Guest shell journal is unavailable.") }
        guard fchmod(descriptor,mode_t(0o700)) == 0 else { Darwin.close(descriptor); throw CanaveralError.unavailable("Guest shell journal could not be made private.") }
        self.state=descriptor; self.permitted=permitted; self.factory=factory
    }
    deinit { Darwin.close(state) }
    private func name(_ id: UUID) -> String { id.uuidString.lowercased()+".json" }
    private func load(_ id: UUID) throws -> GuestShellRecord? {
        let descriptor=openat(state,name(id),O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)
        if descriptor < 0 { if errno == ENOENT { return nil }; throw CanaveralError.unavailable("Guest shell receipt cannot be inspected.") }
        defer { Darwin.close(descriptor) }
        var metadata=stat(), bytes=[UInt8](repeating:0,count:4097)
        guard fstat(descriptor,&metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, metadata.st_size <= 4096 else { throw CanaveralError.unavailable("Guest shell receipt is not a bounded regular file.") }
        let count=Darwin.read(descriptor,&bytes,bytes.count)
        guard count == metadata.st_size else { throw CanaveralError.unavailable("Guest shell receipt read was not confirmed.") }
        let value=try JSONDecoder().decode(GuestShellRecord.self,from:Data(bytes.prefix(count)))
        guard value.version == 1, value.id == id, (1...500).contains(value.columns), (1...500).contains(value.rows),
              ["starting","open","closing","closed"].contains(value.state) else { throw CanaveralError.unavailable("Guest shell receipt identity differs.") }
        return value
    }
    private func persist(_ record: GuestShellRecord) throws {
        let temporary=".shell-"+UUID().uuidString.lowercased(), data=try JSONEncoder().encode(record)
        let descriptor=openat(state,temporary,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,mode_t(0o600))
        guard descriptor >= 0 else { throw CanaveralError.unavailable("Guest shell receipt creation failed.") }
        defer { Darwin.close(descriptor); unlinkat(state,temporary,0) }
        try data.withUnsafeBytes { raw in
            var offset=0
            while offset < raw.count {
                let count=Darwin.write(descriptor,raw.baseAddress!.advanced(by:offset),raw.count-offset)
                if count > 0 { offset+=count } else if count < 0 && errno == EINTR { continue }
                else { throw CanaveralError.unavailable("Guest shell receipt write failed.") }
            }
        }
        guard fsync(descriptor) == 0, renameat(state,temporary,state,name(record.id)) == 0, fsync(state) == 0 else {
            throw CanaveralError.unavailable("Guest shell receipt synchronization is uncertain.")
        }
    }
    public func handle(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard !fenced, permitted() else { throw CanaveralError.unavailable("Guest shell authorization ended.") }
        guard request.method == "POST", request.path == request.target, request.body.count <= 16384,
              let value=try JSONDecoder().decode(JSONValue.self,from:request.body).object,
              let raw=value["session"]?.string, let id=UUID(uuidString:raw) else { throw CanaveralError.invalid("Invalid guest terminal envelope.") }
        let route=request.path
        let fields: Set<String>
        switch route {
        case "/v1/shell/open", "/v1/shell/resize": fields=["session","cols","rows"]
        case "/v1/shell/read": fields=["session","offset"]
        case "/v1/shell/write": fields=["session","text"]
        case "/v1/shell/close": fields=["session"]
        default: return .error("Unknown guest terminal endpoint.",status:404)
        }
        guard Set(value.keys) == fields else { throw CanaveralError.invalid("Invalid guest terminal fields.") }
        if route == "/v1/shell/open" {
            let columns=try dimension(value,"cols"), rows=try dimension(value,"rows")
            if let record=try load(id) {
                guard record.columns == columns, record.rows == rows else { throw CanaveralError.invalid("Guest shell UUID belongs to another open request.") }
                guard record.state == "open", sessions[id]?.record.state == "open" else {
                    throw CanaveralError.unavailable("Guest shell was closed, interrupted or restarted; it will not be reopened.")
                }
                return try .json(["session":id.uuidString])
            }
            var record=GuestShellRecord(id:id,columns:columns,rows:rows,state:"starting")
            try persist(record) // No process launch before a durable request identity.
            let terminal=try factory(columns,rows)
            sessions[id]=GuestShellEntry(terminal:terminal,record:record)
            record.state="open"
            try persist(record); sessions[id]?.record=record
            return try .json(["session":id.uuidString])
        }
        if route == "/v1/shell/close" {
            if sessions[id] != nil { return try .json(["closed":try await close(id)]) }
            guard let record=try load(id) else { throw CanaveralError.invalid("Unknown guest terminal.") }
            if record.state == "closed" { return try .json(["closed":true]) }
            throw CanaveralError.unavailable("Guest terminal ownership was lost at restart; cleanup needs an execution fence.")
        }
        guard let entry=sessions[id], entry.record.state == "open" else { throw CanaveralError.unavailable("Guest terminal is closed or its helper restarted.") }
        if route == "/v1/shell/write" {
            guard let text=value["text"]?.string, !text.contains("\0"), text.count <= 16000, let bytes=text.data(using:.utf8) else { throw CanaveralError.invalid("Invalid guest terminal input.") }
            try entry.terminal.write(bytes)
            return try .json(["written":bytes.count])
        }
        if route == "/v1/shell/resize" {
            try entry.terminal.resize(columns:dimension(value,"cols"),rows:dimension(value,"rows"))
            return try .json(["resized":true])
        }
        guard case .number(let rawOffset)=value["offset"], rawOffset.isFinite, rawOffset >= 0, rawOffset <= 9007199254740991,
              rawOffset.rounded(.towardZero) == rawOffset else { throw CanaveralError.invalid("Invalid guest terminal cursor.") }
        let output=try entry.terminal.output(offset:Int64(rawOffset))
        return try .json(JSONValue.object(["session":.string(id.uuidString),"data":.string(output.data.base64EncodedString()),"offset":.number(Double(output.offset)),
            "truncated":.bool(output.truncated),"exited":.bool(output.exited),"exitCode":output.exitCode.map { .number(Double($0)) } ?? .null]))
    }
    private func dimension(_ values: [String:JSONValue], _ key: String) throws -> UInt16 {
        guard case .number(let value)=values[key], value.isFinite, value.rounded(.towardZero) == value, (1...500).contains(value) else { throw CanaveralError.invalid("Terminal dimensions must be integers from 1 through 500.") }
        return UInt16(value)
    }
    private func close(_ id: UUID) async throws -> Bool {
        guard var entry=sessions[id] else { return false }
        entry.record.state="closing"; sessions[id]=entry
        // A journal failure must not prevent stopping a still-owned process.
        // Only a synchronized final closed receipt can acknowledge completion.
        try? persist(entry.record)
        let deadline=NativeLeaseClock.now()+1
        repeat {
            if try entry.terminal.stop() {
                var receipt=entry.record; receipt.state="closed"; try persist(receipt)
                sessions.removeValue(forKey:id); return true
            }
            try await Task.sleep(for:.milliseconds(10))
        } while NativeLeaseClock.now() < deadline
        throw CanaveralError.unavailable("Guest terminal stop is unconfirmed; it remains tracked for cleanup.")
    }
    public func revoke() async -> Bool {
        fenced=true
        let ids=Array(sessions.keys)
        var failures=Set<UUID>(), waiting=Set<UUID>()
        // Fence all input and signal the whole batch before waiting on one child.
        for id in ids {
            guard var entry=sessions[id] else { continue }
            entry.record.state="closing"; sessions[id]=entry
            try? persist(entry.record)
            do { _=try entry.terminal.stop(); waiting.insert(id) }
            catch { failures.insert(id) }
        }
        let deadline=NativeLeaseClock.now()+1
        repeat {
            for id in Array(waiting) {
                guard let entry=sessions[id] else { waiting.remove(id); continue }
                do {
                    if try entry.terminal.stop() {
                        var receipt=entry.record; receipt.state="closed"; try persist(receipt)
                        sessions.removeValue(forKey:id); waiting.remove(id)
                    }
                } catch { failures.insert(id); waiting.remove(id) }
            }
            if waiting.isEmpty { break }
            do { try await Task.sleep(for:.milliseconds(10)) } catch { return false }
        } while NativeLeaseClock.now() < deadline
        return waiting.isEmpty && failures.isEmpty
    }
}

public struct GuestWorkspace: GuestWorkspaceService {
    public let files: any GuestWorkspaceService, shells: any GuestWorkspaceService
    public init(files: any GuestWorkspaceService, shells: any GuestWorkspaceService) { self.files=files; self.shells=shells }
    public func handle(_ request: HTTPRequest) async throws -> HTTPResponse {
        if request.path.hasPrefix("/v1/files/") { return try await files.handle(request) }
        if request.path.hasPrefix("/v1/shell/") { return try await shells.handle(request) }
        return .error("Unknown guest workspace endpoint.",status:404)
    }
}
