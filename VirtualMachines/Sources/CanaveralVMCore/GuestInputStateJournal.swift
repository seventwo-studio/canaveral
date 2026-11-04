import Foundation
import Darwin

/// Bounded private held-input state. Callers enforce native guest authorization before constructing it.
@MainActor public final class GuestInputStateJournal {
    private struct Record: Codable { var version=1; var state: GuestInputState }
    private let directory: Int32
    public init(_ url: URL) throws {
        try FileManager.default.createDirectory(at:url,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let fd=Darwin.open(url.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
        guard fd >= 0 else { throw CanaveralError.unavailable("Native held-input journal is unavailable.") }
        guard fchmod(fd,mode_t(0o700)) == 0 else { Darwin.close(fd); throw CanaveralError.unavailable("Native held-input journal could not be made private.") }
        directory=fd
    }
    deinit { Darwin.close(directory) }
    public func read() throws -> GuestInputState? {
        let fd=openat(directory,"held.json",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)
        if fd < 0 { if errno == ENOENT { return nil }; throw CanaveralError.unavailable("Native held-input state cannot be inspected.") }
        defer { Darwin.close(fd) }
        var metadata=stat(), data=Data(), bytes=[UInt8](repeating:0,count:4096)
        guard fstat(fd,&metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, (0...65536).contains(metadata.st_size) else { throw CanaveralError.unavailable("Native held-input state is not a bounded regular file.") }
        while data.count <= 65536 {
            let count=Darwin.read(fd,&bytes,min(bytes.count,65537-data.count))
            if count > 0 { data.append(contentsOf:bytes.prefix(count)) }
            else if count == 0 { break }
            else if errno != EINTR { throw CanaveralError.unavailable("Native held-input state read failed.") }
        }
        guard data.count <= 65536 else { throw CanaveralError.unavailable("Native held-input state exceeds its envelope.") }
        let value=try JSONDecoder().decode(Record.self,from:data)
        guard value.version == 1 else { throw CanaveralError.unavailable("Unknown native held-input state version.") }
        try value.state.validate(); return value.state
    }
    public func save(_ state: GuestInputState) throws {
        try state.validate()
        let data=try JSONEncoder().encode(Record(state:state)), name=".held-"+UUID().uuidString.lowercased()
        guard data.count <= 65536 else { throw CanaveralError.invalid("Native held-input state exceeds its envelope.") }
        let fd=openat(directory,name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,mode_t(0o600))
        guard fd >= 0 else { throw CanaveralError.unavailable("Native held-input state creation failed.") }
        defer { Darwin.close(fd); unlinkat(directory,name,0) }
        try data.withUnsafeBytes { raw in
            var offset=0
            while offset < raw.count {
                let count=Darwin.write(fd,raw.baseAddress!.advanced(by:offset),raw.count-offset)
                if count > 0 { offset+=count } else if count < 0 && errno == EINTR { continue }
                else { throw CanaveralError.unavailable("Native held-input state write failed.") }
            }
        }
        guard fsync(fd) == 0, renameat(directory,name,directory,"held.json") == 0, fsync(directory) == 0 else { throw CanaveralError.unavailable("Native held-input state publication is uncertain.") }
    }
}
