#if os(macOS)
import Foundation
import Darwin
import CryptoKit
import CanaveralVMCore
public struct LaunchMediaPin: Codable, Sendable, Equatable {
    public var path: String
    public var sha256: String
    public var size: UInt64
    public var uid: UInt32
    public var mode: UInt32
    public var nlink: UInt32
    public var dev: String
    public var ino: String
    public var version: Int
    public var machineId: String
    public var leaseId: String
    public var fingerprint: String
    public var launchId: String
    public static func load(directory: URL) throws -> LaunchMediaPin {
        let path = directory.appendingPathComponent("guest-launch-pin.json").path
        let canonical = realpath(path, nil)
        guard let canonical else { throw CanaveralError.invalid("Launch pin is unavailable.") }
        defer { free(canonical) }
        guard String(cString: canonical) == path else { throw CanaveralError.invalid("Launch pin path differs.") }
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw CanaveralError.invalid("Launch pin is unavailable.") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? handle.close() }
        var before = stat(), after = stat(), named = stat()
        guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
              before.st_uid == getuid(), before.st_mode & 0o7777 == 0o600, before.st_nlink == 1,
              before.st_size > 0, before.st_size <= 8192,
              let bytes = try handle.read(upToCount: 8193), bytes.count == before.st_size,
              fstat(fd, &after) == 0, before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              lstat(path, &named) == 0, before.st_dev == named.st_dev, before.st_ino == named.st_ino else {
            throw CanaveralError.invalid("Launch pin identity changed.")
        }
        return try JSONDecoder().decode(LaunchMediaPin.self, from: bytes)
    }
    public func validate(machine: Machine, directory: URL, launch: String) throws {
        guard machine.os == .macOS, machine.executionLeaseID?.uuidString.lowercased() == leaseId,
              machine.id.uuidString.lowercased() == machineId, launch == launchId, version == 2,
              GuestAssignmentContext.canonicalUUID(launchId), mode == 256, nlink == 1,
              path == directory.deletingLastPathComponent().appendingPathComponent("guest-bootstrap/launch.iso").path else {
            throw CanaveralError.invalid("Launch media assignment differs.")
        }
        _ = try GuestAssignmentContext(machineId: machineId, leaseId: leaseId, fingerprint: fingerprint, launchId: launchId)
        try verify()
    }
    /// The provider pins private files and controls every mutable path ancestor.
    /// Reject symlinks, writable files and foreign writable directories before VZ opens them.
    public func verify() throws {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard version == 2, components.count > 1, components.first == "", !path.utf8.contains(0),
              components.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              DirectBoot.digestIsValid(sha256), size > 0 else { throw CanaveralError.invalid("Invalid pinned artifact.") }
        #if os(macOS)
        // Preserve /private spelling. Walk relative to pinned directory descriptors;
        // O_NOFOLLOW on the final open alone would still follow ancestor symlinks.
        var directory = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw CanaveralError.invalid("Cannot open artifact root.") }
        defer { close(directory) }
        var fd: Int32 = -1
        for (index, component) in components.dropFirst().enumerated() {
            let leaf = index == components.count - 2
            let name = String(component)
            var walked = stat(), opened = stat()
            guard fstatat(directory, name, &walked, AT_SYMLINK_NOFOLLOW) == 0,
                  walked.st_mode & S_IFMT == (leaf ? S_IFREG : S_IFDIR) else { throw CanaveralError.invalid("Cannot inspect artifact path.") }
            let next = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (leaf ? 0 : O_DIRECTORY))
            guard next >= 0 else { throw CanaveralError.invalid("Unsafe artifact path.") }
            guard fstat(next, &opened) == 0, opened.st_dev == walked.st_dev, opened.st_ino == walked.st_ino,
                  opened.st_uid == 0 || opened.st_uid == getuid() else {
                close(next); throw CanaveralError.invalid("Artifact path changed or has unsafe ownership.")
            }
            if leaf {
                guard opened.st_mode & S_IFMT == S_IFREG, opened.st_mode & 0o7777 == 0o400,
                      opened.st_nlink == 1, opened.st_size > 0, UInt64(opened.st_size) == size,
                      opened.st_flags & UInt32(UF_IMMUTABLE | SF_IMMUTABLE) == 0,
                      opened.st_uid == uid, opened.st_uid == getuid(), String(opened.st_dev) == dev, String(opened.st_ino) == ino else {
                    close(next); throw CanaveralError.invalid("Artifact must be private, mode 0400 and size-pinned.")
                }
                fd = next
            } else {
                guard opened.st_mode & S_IFMT == S_IFDIR,
                      opened.st_mode & 0o022 == 0 || (opened.st_uid == 0 && opened.st_mode & S_ISVTX != 0) else {
                    close(next); throw CanaveralError.invalid("Unsafe artifact ancestor.")
                }
                close(directory); directory = next
            }
        }
        var beforeHash = stat()
        guard fstat(fd, &beforeHash) == 0 else { close(fd); throw CanaveralError.invalid("Launch media unavailable.") }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? file.close() }
        var hash = SHA256(); var total: UInt64 = 0
        while let bytes = try file.read(upToCount: 65536), !bytes.isEmpty {
            total += UInt64(bytes.count); guard total <= size else { throw CanaveralError.invalid("Artifact size changed.") }; hash.update(data: bytes)
        }
        var afterHash = stat(), namedAfterHash = stat()
        guard fstat(fd, &afterHash) == 0, beforeHash.st_ctimespec.tv_sec == afterHash.st_ctimespec.tv_sec, beforeHash.st_ctimespec.tv_nsec == afterHash.st_ctimespec.tv_nsec, beforeHash.st_mtimespec.tv_sec == afterHash.st_mtimespec.tv_sec, beforeHash.st_mtimespec.tv_nsec == afterHash.st_mtimespec.tv_nsec,
              fstatat(directory, String(components.last!), &namedAfterHash, AT_SYMLINK_NOFOLLOW) == 0,
              namedAfterHash.st_dev == afterHash.st_dev, namedAfterHash.st_ino == afterHash.st_ino,
              total == size, hash.finalize().map({ String(format: "%02x", $0) }).joined() == sha256 else { throw CanaveralError.invalid("Artifact pin mismatch.") }
        #else
        throw CanaveralError.unavailable("Direct boot inventory requires macOS.")
        #endif
    }
}

public struct ValidatedLaunchMedia {
    let pin: LaunchMediaPin
    public init(pin: LaunchMediaPin, machine: Machine, directory: URL, launch: String) throws {
        try pin.validate(machine: machine, directory: directory, launch: launch)
        self.pin = pin
    }
    public func consume(directory: URL) throws {
        let file = directory.appendingPathComponent("guest-attempt-" + pin.launchId)
        let fd = open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw CanaveralError.invalid("Assigned launch attempt already consumed or unavailable.") }
        defer { close(fd) }
        let parent = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw CanaveralError.invalid("Assigned launch directory unavailable.") }
        defer { close(parent) }
        guard fsync(fd) == 0, fsync(parent) == 0, fcntl(fd, F_FULLFSYNC) == 0 else { throw CanaveralError.invalid("Assigned launch attempt durability is uncertain.") }
    }
}
#endif
