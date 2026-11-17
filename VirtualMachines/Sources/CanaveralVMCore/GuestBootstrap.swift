import Foundation
import Darwin

/// Launch files convey a secret, not authenticated host provenance. The host checks
/// the v2 challenge using its independently retained private receipt.
public struct GuestBootstrap: Sendable {
    public let assignment: GuestAssignmentContext
    public let credential: String
    public let pkcs12: Data
    public init(data: Data) throws {
        guard data.count <= 4096, Self.uniqueKeys(data),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["version", "assignment", "credential", "tls"],
              let version = object["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 2,
              let assignment = object["assignment"] as? [String: Any],
              let credential = object["credential"] as? String, GuestAssignmentContext.canonical32(credential) else {
            throw CanaveralError.invalid("Assignment media is invalid.")
        }
        self.assignment = try GuestAssignmentContext(data: JSONSerialization.data(withJSONObject: assignment))
        guard let tls = object["tls"] as? [String: Any], Set(tls.keys) == ["pkcs12"],
              let encoded = tls["pkcs12"] as? String, encoded.utf8.count <= 3734,
              encoded.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
              let decoded = Data(base64Encoded: encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - encoded.count % 4) % 4)),
              decoded.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == encoded else { throw CanaveralError.invalid("TLS bootstrap is invalid.") }
        self.pkcs12 = decoded
        self.credential = credential
    }

    // JSONSerialization keeps the last duplicate key. Reject duplicates, including
    // escaped spellings, before interpreting the exact assignment schema.
    private static func uniqueKeys(_ data: Data) -> Bool {
        let bytes = Array(data); var index = 0; var objects: [Set<String>] = []
        while index < bytes.count {
            let byte = bytes[index]
            if byte == 123 { objects.append([]); index += 1; continue }
            if byte == 125 { guard !objects.isEmpty else { return false }; objects.removeLast(); index += 1; continue }
            if byte != 34 { index += 1; continue }
            let start = index; index += 1
            while index < bytes.count {
                if bytes[index] == 92 { index += 2; continue }
                if bytes[index] == 34 { break }
                index += 1
            }
            guard index < bytes.count else { return false }
            index += 1
            let end = index
            while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 }
            if index < bytes.count && bytes[index] == 58 {
                guard !objects.isEmpty,
                      let key = try? JSONDecoder().decode(String.self, from: Data(bytes[start..<end])),
                      objects[objects.count - 1].insert(key).inserted else { return false }
            }
        }
        return objects.isEmpty
    }
}

public struct GuestBootstrapMount: Sendable, Equatable {
    public let path: String, filesystem: String, label: String
    public let readOnly: Bool
    public let identity: String
    public init(path: String, filesystem: String, label: String, readOnly: Bool, identity: String = "") {
        self.path = path; self.filesystem = filesystem; self.label = label; self.readOnly = readOnly; self.identity = identity
    }
}

public enum GuestBootstrapSelector {
    public static func select(mounts: () throws -> [GuestBootstrapMount], read: (GuestBootstrapMount) throws -> Data = read) throws -> GuestBootstrap {
        let before = try mounts(), candidates = before.filter { $0.filesystem == "cd9660" }
        guard candidates.count == 1, let candidate = candidates.first, candidate.readOnly, candidate.label == "CANAVERAL_BOOT" else {
            throw CanaveralError.invalid("Assignment media is unavailable or ambiguous.")
        }
        let result = try GuestBootstrap(data: read(candidate))
        guard try mounts() == before else { throw CanaveralError.invalid("Assignment media changed.") }
        return result
    }
    public static func read(_ mount: GuestBootstrapMount) throws -> Data {
        let url = URL(fileURLWithPath: mount.path)
        guard url.path == mount.path, url.resolvingSymlinksInPath().path == mount.path,
              try FileManager.default.contentsOfDirectory(atPath: mount.path) == ["assignment.json"] else {
            throw CanaveralError.invalid("Assignment media contents differ.")
        }
        let directory = open(mount.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw CanaveralError.invalid("Assignment media unavailable.") }
        defer { close(directory) }
        if !mount.identity.isEmpty { try verifyMount(directory, mount: mount) }
        var named = stat(), parent = stat()
        guard fstat(directory, &parent) == 0 else { throw CanaveralError.invalid("Assignment media unavailable.") }
        let fd = openat(directory, "assignment.json", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw CanaveralError.invalid("Assignment file unavailable.") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var before = stat(), after = stat()
        guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_size > 0, before.st_size <= 4096,
              before.st_dev == parent.st_dev, before.st_nlink == 1,
              let data = try handle.read(upToCount: 4097), data.count == before.st_size,
              fstat(fd, &after) == 0, before.st_ino == after.st_ino, before.st_size == after.st_size,
              fstatat(directory, "assignment.json", &named, AT_SYMLINK_NOFOLLOW) == 0,
              named.st_dev == before.st_dev, named.st_ino == before.st_ino,
              lstat(mount.path, &named) == 0, named.st_dev == parent.st_dev, named.st_ino == parent.st_ino,
              try FileManager.default.contentsOfDirectory(atPath: mount.path) == ["assignment.json"] else {
            throw CanaveralError.invalid("Assignment media was substituted.")
        }
        if !mount.identity.isEmpty { try verifyMount(directory, mount: mount) }
        return data
    }
    private static func mountIdentity(_ entry: statfs) -> String {
        String(entry.f_fsid.val.0) + ":" + String(entry.f_fsid.val.1)
    }
    private static func verifyMount(_ fd: Int32, mount: GuestBootstrapMount) throws {
        var entry = statfs()
        guard fstatfs(fd, &entry) == 0, entry.f_flags & UInt32(MNT_RDONLY) != 0, mountIdentity(entry) == mount.identity else { throw CanaveralError.invalid("Assignment mount changed.") }
        let filesystem = withUnsafePointer(to: &entry.f_fstypename) { String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self)) }
        guard filesystem == "cd9660" else { throw CanaveralError.invalid("Assignment filesystem differs.") }
    }
    public static func systemMounts() throws -> [GuestBootstrapMount] {
        var entries: UnsafeMutablePointer<statfs>?
        let count = getmntinfo(&entries, MNT_NOWAIT)
        guard count > 0, let entries else { throw CanaveralError.unavailable("Mount table unavailable.") }
        return try (0..<Int(count)).compactMap { index in
            var entry = entries[index]
            let filesystem = withUnsafePointer(to: &entry.f_fstypename) { String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self)) }
            guard filesystem == "cd9660" else { return nil }
            let path = withUnsafePointer(to: &entry.f_mntonname) { String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self)) }
            let label = try URL(fileURLWithPath: path).resourceValues(forKeys: [.volumeNameKey]).volumeName ?? ""
            return GuestBootstrapMount(path: path, filesystem: filesystem, label: label, readOnly: entry.f_flags & UInt32(MNT_RDONLY) != 0, identity: mountIdentity(entry))
        }
    }
}

/// No listener or legacy-mode callback is invoked before complete selection.
@MainActor public enum AssignedGuestStartup {
    public static func start<T>(isVirtualGuest: Bool, mounts: () throws -> [GuestBootstrapMount], read: (GuestBootstrapMount) throws -> Data = GuestBootstrapSelector.read,
                                compose: (GuestBootstrap) throws -> T) throws -> T {
        guard isVirtualGuest else { throw CanaveralError.unavailable("Assigned helper requires a virtual guest.") }
        return try compose(GuestBootstrapSelector.select(mounts: mounts, read: read))
    }
}

/// A consumed/uncertain assigned startup is never replayed after helper restart.
public enum GuestAssignedLaunchAttempt {
    public static func consume(state: URL) throws {
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let parent = open(state.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw CanaveralError.invalid("Assigned state is unavailable.") }
        defer { close(parent) }
        var metadata = stat()
        guard fstat(parent, &metadata) == 0, metadata.st_uid == getuid(), metadata.st_mode & 0o7777 == 0o700 else { throw CanaveralError.invalid("Assigned state ownership differs.") }
        let fd = openat(parent, "startup-attempt", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw CanaveralError.invalid("Assigned startup already attempted or unavailable.") }
        defer { close(fd) }
        guard fsync(fd) == 0, fsync(parent) == 0, fcntl(fd, F_FULLFSYNC) == 0 else { throw CanaveralError.invalid("Assigned startup durability is uncertain.") }
    }
}
