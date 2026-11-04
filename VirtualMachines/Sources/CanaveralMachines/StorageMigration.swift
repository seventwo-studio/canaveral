#if os(macOS)
import Foundation
import Darwin
import CanaveralVMCore

public enum StorageMigration {
    /// Caller stops the gateway/agent first. Old data is retained until the user removes it.
    public static func copy(from source: StorageLocation, to parent: URL,
                            progress: @Sendable (String) -> Void = { _ in }) throws -> StorageLocation {
        try source.checkAvailable()
        let fm = FileManager.default
        let target = parent.appendingPathComponent("Canaveral", isDirectory: true)
        let targetVolume = try parent.resourceValues(forKeys: [.volumeURLKey]).volume?.standardizedFileURL.path
        guard let targetVolume else { throw CanaveralError.unavailable("Cannot identify the selected storage volume.") }
        let checkDestination: @Sendable () throws -> Void = {
            guard try parent.resourceValues(forKeys: [.volumeURLKey]).volume?.standardizedFileURL.path == targetVolume else {
                throw CanaveralError.unavailable("The destination drive or share disconnected during the move. Original data is unchanged.")
            }
        }
        guard parent.isFileURL, fm.isWritableFile(atPath: parent.path),
              !CanaveralStorage.contains(target, in: source.root), !CanaveralStorage.contains(source.root, in: target),
              !CanaveralStorage.contains(target, in: source.machines), !CanaveralStorage.contains(source.machines, in: target),
              !fm.fileExists(atPath: target.path) else {
            throw CanaveralError.invalid("Choose a writable folder outside the current storage, without an existing Canaveral folder. Existing data is never overwritten.")
        }
        let rootLease = try StorageLease(root: source.root, exclusive: true)
        let ownerLease = try StorageLease(root: source.root, owner: true)
        let machineLease = source.legacyMachinesRoot.flatMap { fm.fileExists(atPath: $0.path) ? $0 : nil }
        let legacyLease = try machineLease.map { try StorageLease(root: $0, exclusive: true) }
        // Older machine helpers do not know about the root lease. Hold their own locks too.
        let folders = (try? fm.contentsOfDirectory(at: source.machines, includingPropertiesForKeys: nil)) ?? []
        let agentFolders = [source.agent] + folders.filter { UUID(uuidString: $0.lastPathComponent) != nil }
        let diskLocks = try agentFolders.filter { fm.fileExists(atPath: $0.path) }.map { try RuntimeDiskLease(directory: $0) }
        defer { withExtendedLifetime((rootLease, ownerLease, legacyLease, diskLocks)) {} }
        let staged = parent.appendingPathComponent(".Canaveral-moving-\(UUID())", isDirectory: true)
        try fm.createDirectory(at: staged, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        var published = false
        defer { if !published { try? fm.removeItem(at: staged) } }
        progress("Copying assistant data and machine disks…")
        try copyContents(source.root, staged, progress: progress, checkDestination: checkDestination)
        if let old = source.legacyMachinesRoot, fm.fileExists(atPath: old.path) {
            let destination = staged.appendingPathComponent("Machines")
            guard !fm.fileExists(atPath: destination.path) else { throw CanaveralError.invalid("Both legacy and current machine folders exist. Review them before moving storage.") }
            try fm.createDirectory(at: destination, withIntermediateDirectories: false)
            try copyContents(old, destination, progress: progress, checkDestination: checkDestination)
        }
        // Rebase owned installer references; import old externally selected installers as well.
        let newMachines = staged.appendingPathComponent("Machines")
        for folder in (try? fm.contentsOfDirectory(at: newMachines, includingPropertiesForKeys: nil)) ?? [] where UUID(uuidString: folder.lastPathComponent) != nil {
            var machine = try MachineStore.load(directory: folder)
            let link = folder.appendingPathComponent("desktop-helper.txt")
            if !fm.fileExists(atPath: link.path), let legacy = UserDefaults(suiteName: "app.canaveral.machine-host")?.string(forKey: "guest-link-\(machine.id)"), UUID(uuidString: legacy) != nil {
                try Data(legacy.utf8).write(to: link, options: .atomic)
            }
            if let path = machine.installerPath {
                let old = URL(fileURLWithPath: path)
                if CanaveralStorage.contains(old, in: source.root) {
                    machine.installerPath = target.path + String(old.resolvingSymlinksInPath().path.dropFirst(source.root.resolvingSymlinksInPath().path.count))
                } else if CanaveralStorage.contains(old, in: source.machines) {
                    machine.installerPath = target.appendingPathComponent("Machines").path + String(old.resolvingSymlinksInPath().path.dropFirst(source.machines.resolvingSymlinksInPath().path.count))
                } else {
                    let imported = folder.appendingPathComponent("installer").appendingPathExtension(old.pathExtension)
                    try copyFile(old, imported, progress: progress, checkDestination: checkDestination)
                    machine.installerPath = target.appendingPathComponent("Machines/\(machine.id)/\(imported.lastPathComponent)").path
                }
                try MachineStore.save(machine, directory: folder)
            }
        }
        try Task.checkCancellation(); try source.checkAvailable(); try checkDestination()
        progress("Finishing storage copy…")
        try fm.moveItem(at: staged, to: target); published = true
        let location = StorageLocation(root: target, id: source.id)
        try location.checkAvailable(); return location
    }
    private static func copyContents(_ source: URL, _ target: URL, progress: @Sendable (String) -> Void, checkDestination: @Sendable () throws -> Void) throws {
        for item in try FileManager.default.contentsOfDirectory(at: source, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) {
            try Task.checkCancellation(); try checkDestination()
            if ["runtime.lock", "status.json", ".canaveral-move.lock", ".canaveral-owner.lock"].contains(item.lastPathComponent) { continue }
            let destination = target.appendingPathComponent(item.lastPathComponent)
            let values = try item.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            if values.isSymbolicLink == true { try FileManager.default.copyItem(at: item, to: destination) }
            else if values.isDirectory == true {
                try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                try copyContents(item, destination, progress: progress, checkDestination: checkDestination)
            } else { try copyFile(item, destination, progress: progress, checkDestination: checkDestination) }
        }
    }
    private static func copyFile(_ source: URL, _ target: URL, progress: @Sendable (String) -> Void, checkDestination: @Sendable () throws -> Void) throws {
        try Task.checkCancellation(); try checkDestination(); progress("Copying \(source.lastPathComponent)…")
        // APFS clone avoids expanding sparse VM disks or copying their full logical size.
        if clonefile(source.path, target.path, 0) == 0 { return }
        let fm = FileManager.default
        guard fm.createFile(atPath: target.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CanaveralError.unavailable("Could not copy \(source.lastPathComponent) to the selected storage.") }
        let input = try FileHandle(forReadingFrom: source), output = try FileHandle(forWritingTo: target)
        defer { try? input.close(); try? output.close() }
        var position: UInt64 = 0
        var lastProgress: UInt64 = 0
        while let data = try input.read(upToCount: 4 * 1024 * 1024), !data.isEmpty {
            try Task.checkCancellation()
            // Preserve zero-filled holes on another drive; do not buffer a VM disk in memory.
            if data.contains(where: { $0 != 0 }) { try output.seek(toOffset: position); try output.write(contentsOf: data) }
            position += UInt64(data.count)
            if position - lastProgress >= 64 * 1048576 {
                try checkDestination(); lastProgress = position
                progress("Copying \(source.lastPathComponent): \(ByteCountFormatter.string(fromByteCount: Int64(position), countStyle: .file))")
            }
        }
        try output.truncate(atOffset: position); try output.synchronize()
        let size = (try fm.attributesOfItem(atPath: source.path)[.size] as? NSNumber)?.uint64Value
        guard size == position else { throw CanaveralError.invalid("A source file changed during the move. The original storage is still intact.") }
    }
}
private final class RuntimeDiskLease {
    let fd: Int32
    init(directory: URL) throws {
        fd = open(directory.appendingPathComponent("runtime.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw CanaveralError.unavailable("Could not lock a machine disk before moving it.") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw CanaveralError.unavailable("A machine process still owns its disk. Shut down and quit it before moving storage.") }
    }
    deinit { flock(fd, LOCK_UN); close(fd) }
}
#endif
