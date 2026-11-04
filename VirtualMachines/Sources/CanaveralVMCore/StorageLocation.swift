#if os(macOS)
import Foundation
import Darwin

/// Only the location bookmark lives on the Mac. User data belongs to this root.
public struct StorageLocation: Sendable, Equatable {
    public let root: URL
    public let id: UUID
    public let legacyMachinesRoot: URL?
    public var machines: URL { legacyMachinesRoot ?? root.appendingPathComponent("Machines") }
    public var agent: URL { root.appendingPathComponent("AgentVM") }
    public var restores: URL { root.appendingPathComponent("RestoreImages") }
    public var marker: URL { root.appendingPathComponent(".canaveral-storage-id") }
    public init(root: URL, id: UUID, legacyMachinesRoot: URL? = nil) {
        self.root = root.standardizedFileURL; self.id = id; self.legacyMachinesRoot = legacyMachinesRoot
    }
    public func checkAvailable() throws {
        guard let saved = try? String(contentsOf: marker, encoding: .utf8), saved == id.uuidString,
              FileManager.default.isWritableFile(atPath: root.path) else {
            throw CanaveralError.unavailable("Canaveral storage is unavailable or has changed. Reconnect the drive or mount the network share, then retry in Settings → Storage. No replacement storage was created.")
        }
    }
    public var isNetwork: Bool { (try? root.resourceValues(forKeys: [.volumeIsLocalKey]).volumeIsLocal) != true }
    public func saveBookmark(to profileURL: URL = CanaveralStorage.profileURL) throws {
        try checkAvailable()
        #if os(macOS)
        let bookmark = try root.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
        #else
        let bookmark = Data()
        #endif
        let profile = StorageProfile(id: id, path: root.path, bookmark: bookmark, legacyMachinesPath: legacyMachinesRoot?.path)
        try FileManager.default.createDirectory(at: profileURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(profile).write(to: profileURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: profileURL.path)
    }
}
private struct StorageProfile: Codable {
    var id: UUID
    var path: String
    var bookmark: Data
    var legacyMachinesPath: String?
}
public enum CanaveralStorage {
    public static var defaultRoot: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Canaveral Machines") }
    public static var profileURL: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Canaveral Machines Bootstrap/storage.json") }
    public static func resolve(profileURL: URL = profileURL, defaultRoot: URL = defaultRoot, legacyMachinesRoot: URL? = nil) throws -> StorageLocation {
        if FileManager.default.fileExists(atPath: profileURL.path) {
            let profile = try JSONDecoder().decode(StorageProfile.self, from: Data(contentsOf: profileURL))
            var root = URL(fileURLWithPath: profile.path)
            #if os(macOS)
            if !profile.bookmark.isEmpty {
                var stale = false
                // Never mount an absent share implicitly or present a dialog during background startup.
                root = try URL(resolvingBookmarkData: profile.bookmark, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale)
            }
            #endif
            let location = StorageLocation(root: root, id: profile.id, legacyMachinesRoot: profile.legacyMachinesPath.map { URL(fileURLWithPath: $0) })
            try location.checkAvailable(); return location
        }
        // Existing installations keep their layout until an explicit move.
        let oldMachines = legacyMachinesRoot
        let location = try initialize(root: defaultRoot, legacyMachinesRoot: oldMachines)
        try location.saveBookmark(to: profileURL); return location
    }
    public static func initialize(root: URL, legacyMachinesRoot: URL? = nil) throws -> StorageLocation {
        guard root.isFileURL else { throw CanaveralError.invalid("Choose a folder on a mounted drive or network share.") }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let marker = root.appendingPathComponent(".canaveral-storage-id")
        let id: UUID
        if FileManager.default.fileExists(atPath: marker.path) {
            guard let saved = UUID(uuidString: try String(contentsOf: marker, encoding: .utf8)) else { throw CanaveralError.invalid("Invalid Canaveral storage identity.") }
            id = saved
        } else {
            id = UUID(); try Data(id.uuidString.utf8).write(to: marker, options: .withoutOverwriting)
        }
        let location = StorageLocation(root: root, id: id, legacyMachinesRoot: legacyMachinesRoot)
        try location.checkAvailable(); return location
    }
    public static func contains(_ child: URL, in parent: URL) -> Bool {
        let child = child.resolvingSymlinksInPath().standardizedFileURL.path
        let parent = parent.resolvingSymlinksInPath().standardizedFileURL.path
        return child == parent || child.hasPrefix(parent + "/")
    }
}

#if os(macOS)
/// One Mac owns a storage root. Migration takes an exclusive lock; runtimes hold shared locks.
public final class StorageLease: @unchecked Sendable {
    private let fd: Int32
    public init(root: URL, exclusive: Bool = false, owner: Bool = false) throws {
        fd = open(root.appendingPathComponent(owner ? ".canaveral-owner.lock" : ".canaveral-move.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw CanaveralError.unavailable("Cannot lock Canaveral storage.") }
        guard flock(fd, (exclusive || owner ? LOCK_EX : LOCK_SH) | LOCK_NB) == 0 else {
            close(fd); throw CanaveralError.unavailable("Canaveral storage is in use. Shut down and quit the machine processes before moving it.")
        }
    }
    deinit { flock(fd, LOCK_UN); close(fd) }
}
#endif
#endif
