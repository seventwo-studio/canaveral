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
    public var workspaceBytes: UInt64?
    public var workspace: DirectBootWorkspace?
private enum CodingKeys: String, CodingKey, CaseIterable {
    case version, kernel, initrd, rootfs, launchMedium, revision, launchFilesystemUUID
    case bundleDigest, commandLine, leaseID, memberID, bootSessionID, bootAttempt, workspaceBytes, workspace
}
public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    version = try c.decode(Int.self, forKey: .version)
    if version == 2 {
        let keys = try decoder.container(keyedBy: DirectBootKey.self).allKeys.map(\.stringValue)
        let allowed = Set(CodingKeys.allCases.filter { $0 != .workspaceBytes }.map(\.rawValue))
        guard keys.allSatisfy({ allowed.contains($0) }) else { throw CanaveralError.invalid("Unknown v2 direct boot field.") }
    }
    kernel = try c.decode(PinnedBootFile.self, forKey: .kernel)
    initrd = try c.decodeIfPresent(PinnedBootFile.self, forKey: .initrd)
    rootfs = try c.decode(PinnedBootFile.self, forKey: .rootfs)
    launchMedium = try c.decode(PinnedBootFile.self, forKey: .launchMedium)
    revision = try c.decode(UInt64.self, forKey: .revision)
    launchFilesystemUUID = try c.decode(UUID.self, forKey: .launchFilesystemUUID)
    bundleDigest = try c.decode(String.self, forKey: .bundleDigest)
    commandLine = try c.decode(String.self, forKey: .commandLine)
    leaseID = try c.decode(UUID.self, forKey: .leaseID)
    memberID = try c.decode(UUID.self, forKey: .memberID)
    bootSessionID = try c.decode(UUID.self, forKey: .bootSessionID)
    bootAttempt = try c.decode(UUID.self, forKey: .bootAttempt)
    workspaceBytes = try c.decodeIfPresent(UInt64.self, forKey: .workspaceBytes)
    workspace = try c.decodeIfPresent(DirectBootWorkspace.self, forKey: .workspace)
}
    /// Digest-pinned launch medium is prepared by the trusted image builder for this tuple.
    public var serial: String { String(bootAttempt.uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(20)) }
    public var effectiveCommandLine: String { commandLine + " canaveral.launch=" + bootAttempt.uuidString.lowercased() }
    public func validateShape(machine: Machine) throws {
        guard (version == 1 || version == 2), revision > 0, revision <= 9007199254740991, machine.os == .linux, machine.mode == .server, machine.memoryGiB > 0,
              machine.executionLeaseID == leaseID, machine.id == memberID,
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
            throw CanaveralError.invalid("Invalid direct boot inventory or launch binding.")
        }
        if version == 1 {
            guard workspace == nil, let bytes = workspaceBytes,
                  bytes >= 16 * 1024 * 1024, bytes <= 1024 * 1024 * 1024,
                  bytes + 64 * 1024 * 1024 <= UInt64(machine.memoryGiB) * 1073741824 else {
                throw CanaveralError.invalid("Invalid v1 tmpfs workspace.")
            }
        } else {
            guard workspaceBytes == nil, let workspace else { throw CanaveralError.invalid("Direct boot v2 requires a disk workspace.") }
            try workspace.validateShape(launchSerial: serial)
        }
        // v1 requires an audited bootstrap initrd to establish the separate launch mount.
        guard initrd != nil else { throw CanaveralError.invalid("Direct boot v1 without a bootstrap initrd is unsupported.") }
    }
    public func validate(machine: Machine) throws {
        try validateShape(machine: machine)
        try workspace?.verify()
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

private struct DirectBootKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// Satellite-owned writable media. The helper only validates and attaches it.
public struct DirectBootWorkspace: Codable, Sendable, Equatable {
    public var path: String
    public var serial: String
    public var bytes: UInt64
private enum CodingKeys: String, CodingKey { case path, serial, bytes }
public init(path: String, serial: String, bytes: UInt64) { self.path = path; self.serial = serial; self.bytes = bytes }
public init(from decoder: Decoder) throws {
    let keys = try decoder.container(keyedBy: DirectBootKey.self).allKeys.map(\.stringValue)
    guard Set(keys) == Set(["path", "serial", "bytes"]) else { throw CanaveralError.invalid("Invalid workspace fields.") }
    let c = try decoder.container(keyedBy: CodingKeys.self)
    path = try c.decode(String.self, forKey: .path)
    serial = try c.decode(String.self, forKey: .serial)
    bytes = try c.decode(UInt64.self, forKey: .bytes)
}
    func validateShape(launchSerial: String) throws {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count > 1, parts.first == "", !path.utf8.contains(0),
              parts.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              serial.utf8.count == 20, serial.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              serial != launchSerial, bytes >= 16777216, bytes <= 9007199254740991, bytes % 4096 == 0 else {
            throw CanaveralError.invalid("Invalid workspace disk identity or size.")
        }
    }
    func verify(identity: (Int64, UInt64)) throws {
        let current = try verify()
        guard current == identity else { throw CanaveralError.invalid("Workspace identity changed during attachment.") }
    }
    @discardableResult func verify() throws -> (Int64, UInt64) {
        try validateShape(launchSerial: "")
        #if os(macOS)
        var directory = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw CanaveralError.invalid("Cannot open workspace root.") }
        defer { close(directory) }
        let parts = path.split(separator: "/")
        for (index, part) in parts.enumerated() {
            let leaf = index == parts.count - 1
            let fd = openat(directory, String(part), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (leaf ? 0 : O_DIRECTORY))
            guard fd >= 0 else { throw CanaveralError.invalid("Unsafe workspace path.") }
            var info = stat()
            guard fstat(fd, &info) == 0 else { close(fd); throw CanaveralError.invalid("Cannot inspect workspace.") }
            if leaf {
                defer { close(fd) }
                guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
                      info.st_mode & 0o7777 == 0o600, info.st_nlink == 1,
                      info.st_size >= 0, UInt64(info.st_size) == bytes else {
                    throw CanaveralError.invalid("Workspace must be owned, mode 0600, single-link and exact size.")
                }
                return (Int64(info.st_dev), UInt64(info.st_ino))
            } else {
                guard (info.st_uid == 0 || info.st_uid == getuid()),
                      info.st_mode & 0o022 == 0 || (info.st_uid == 0 && info.st_mode & S_ISVTX != 0) else {
                    close(fd); throw CanaveralError.invalid("Unsafe workspace ancestor.")
                }
                close(directory); directory = fd
            }
        }
        throw CanaveralError.invalid("Missing workspace disk.")
        #else
        throw CanaveralError.unavailable("Workspace disks require macOS.")
        #endif
    }
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
