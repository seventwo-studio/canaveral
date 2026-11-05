import Foundation
import CryptoKit
import CanaveralVMCore
#if os(macOS)
import Darwin
#endif

/// Operator-resolved inventory entry. Never expose these paths as consumer inputs.
public struct DirectBoot: Codable, Sendable, Equatable {
    public var version: Int
    public var kernel: PinnedBootFile
    public var initrd: PinnedBootFile?
    public var rootfs: PinnedBootFile
    public var launchMedium: PinnedBootFile
    public var revision: UInt64
    public var launchFilesystemUUID: UUID
    public var bundleDigest: String
    public var commandLine: String
    public var leaseID: UUID
    public var memberID: UUID
    public var bootSessionID: UUID
    public var bootAttempt: UUID
    public var workspaceBytes: UInt64
    /// Digest-pinned launch medium is prepared by the trusted image builder for this tuple.
    public var serial: String { String(bootAttempt.uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(20)) }
    public var effectiveCommandLine: String { commandLine + " canaveral.launch=" + bootAttempt.uuidString.lowercased() }
    public func validateShape(machine: Machine) throws {
        guard version == 1, revision > 0, revision <= 9007199254740991, machine.os == .linux, machine.mode == .server, machine.memoryGiB > 0,
              machine.executionLeaseID == leaseID, machine.id == memberID,
              workspaceBytes >= 16 * 1024 * 1024, workspaceBytes <= 1024 * 1024 * 1024,
              workspaceBytes + 64 * 1024 * 1024 <= UInt64(machine.memoryGiB) * 1073741824,
              Self.digestIsValid(bundleDigest), !commandLine.isEmpty, commandLine.utf8.count <= 1993,
              commandLine.utf8.allSatisfy({ (32...126).contains($0) }),
              !commandLine.contains("\""), !commandLine.contains("'"),
              !commandLine.split(separator: " ").contains("--"),
              !commandLine.split(separator: " ").contains(where: { $0.hasPrefix("canaveral.launch=") }),
              commandLine.split(separator: " ").contains("root=/dev/vda"),
              commandLine.split(separator: " ").contains("rootfstype=erofs"),
              commandLine.split(separator: " ").contains("ro"),
              !commandLine.split(separator: " ").contains("rw"),
              commandLine.split(separator: " ").filter({ $0.hasPrefix("root=") }).count == 1,
              commandLine.split(separator: " ").filter({ $0.hasPrefix("rootfstype=") }).count == 1 else {
            throw CanaveralError.invalid("Invalid direct boot v1 inventory or launch binding.")
        }
        // v1 requires an audited bootstrap initrd to establish the separate launch mount.
        guard initrd != nil else { throw CanaveralError.invalid("Direct boot v1 without a bootstrap initrd is unsupported.") }
    }
    public func validate(machine: Machine) throws {
        try validateShape(machine: machine)
        for file in [kernel, rootfs, launchMedium] + (initrd.map { [$0] } ?? []) { try file.verify() }
        #if os(macOS)
        let kernelHeader = try Self.header(kernel.path, count: 64)
        guard kernelHeader.count >= 64, Array(kernelHeader[56..<60]) == [0x41, 0x52, 0x4d, 0x64] else { throw CanaveralError.invalid("Kernel must be an uncompressed arm64 Image.") }
        for file in [rootfs, launchMedium] {
            let header = try Self.header(file.path, count: 1028)
            guard header.count == 1028, Array(header[1024..<1028]) == [0xe2, 0xe1, 0xf5, 0xe0] else { throw CanaveralError.invalid("Direct root and launch medium must be EROFS.") }
        }
        guard bootSessionID == (try NativeLeaseClock.bootSession()) else { throw CanaveralError.invalid("Direct boot belongs to another host boot session.") }
        #endif
    }
    private static func header(_ path: String, count: Int) throws -> Data {
        let file = try FileHandle(forReadingFrom: URL(fileURLWithPath: path)); defer { try? file.close() }
        return try file.read(upToCount: count) ?? Data()
    }
    static func digestIsValid(_ value: String) -> Bool { value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
}

public struct PinnedBootFile: Codable, Sendable, Equatable {
    public var path: String
    public var sha256: String
    public var size: UInt64
    /// The trusted operator owns immutable files and all mutable path ancestors.
    /// Reject symlinks, writable files and foreign writable directories before VZ opens them.
    public func verify() throws {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard components.count > 1, components.first == "", !path.utf8.contains(0),
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
                      opened.st_flags & UInt32(UF_IMMUTABLE | SF_IMMUTABLE) != 0 else {
                    close(next); throw CanaveralError.invalid("Artifact must be private, immutable, mode 0400 and size-pinned.")
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
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? file.close() }
        var hash = SHA256(); var total: UInt64 = 0
        while let bytes = try file.read(upToCount: 65536), !bytes.isEmpty {
            total += UInt64(bytes.count); guard total <= size else { throw CanaveralError.invalid("Artifact size changed.") }; hash.update(data: bytes)
        }
        guard total == size, hash.finalize().map({ String(format: "%02x", $0) }).joined() == sha256 else { throw CanaveralError.invalid("Artifact pin mismatch.") }
        #else
        throw CanaveralError.unavailable("Direct boot inventory requires macOS.")
        #endif
    }
}

#if os(macOS)
/// A fail-closed, per-directory receipt. The parent must retain its own attempt journal.
enum DirectBootAttempt {
    static func consume(directory: URL, attempt: UUID,
                        sync: (Int32, Bool) -> Int32 = { fd, full in full ? fcntl(fd, F_FULLFSYNC) : fsync(fd) }) throws {
        let parent = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw CanaveralError.unavailable("Cannot open attempt directory.") }
        defer { close(parent) }
        let fd = openat(parent, "direct-attempt-" + attempt.uuidString.lowercased(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw CanaveralError.invalid("Direct boot attempt consumed or unavailable.") }
        defer { close(fd) }
        // Darwin F_FULLFSYNC is fsync plus drive-cache flush (sys/fcntl.h).
        // Sync directory metadata with fsync, then flush media through the file.
        guard sync(fd, false) == 0, sync(parent, false) == 0, sync(fd, true) == 0 else {
            // Keep an uncertain receipt; failure must never authorize a start.
            throw CanaveralError.unavailable("Cannot durably persist direct attempt.")
        }
    }
}
#endif
