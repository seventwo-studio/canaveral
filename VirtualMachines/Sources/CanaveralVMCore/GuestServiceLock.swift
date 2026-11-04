import Foundation
import Darwin

/// One helper process per guest state directory. Native callers check the virtual-guest boundary first.
public final class GuestServiceLock: @unchecked Sendable {
    private let descriptor: Int32
    public init(state: URL) throws {
        try FileManager.default.createDirectory(at:state,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let directory=Darwin.open(state.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
        guard directory >= 0 else { throw CanaveralError.unavailable("Guest helper state directory is unavailable.") }
        defer { Darwin.close(directory) }
        let fd=openat(directory,"guest-helper.lock",O_RDWR|O_CREAT|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC,mode_t(0o600))
        guard fd >= 0 else { throw CanaveralError.unavailable("Guest helper lock is unavailable.") }
        var metadata=stat()
        guard fstat(fd,&metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, metadata.st_uid == geteuid(), metadata.st_nlink == 1 else {
            Darwin.close(fd); throw CanaveralError.unavailable("Guest helper lock identity is unavailable.")
        }
        guard flock(fd,LOCK_EX|LOCK_NB) == 0 else { Darwin.close(fd); throw CanaveralError.unavailable("Another guest helper owns this state directory.") }
        guard fchmod(fd,mode_t(0o600)) == 0 else { Darwin.close(fd); throw CanaveralError.unavailable("Guest helper lock could not be made private.") }
        descriptor=fd
    }
    deinit { Darwin.close(descriptor) }
}
