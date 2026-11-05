import Foundation
import CanaveralVMCore
#if os(macOS)
import Darwin
#endif

public enum MachineEnvironment {
    public static var isVirtualGuest: Bool {
        #if os(macOS)
        var value: Int32 = 0; var length = MemoryLayout<Int32>.size
        return sysctlbyname("kern.hv_vmm_present", &value, &length, nil, 0) == 0 && value == 1
        #else
        return false
        #endif
    }
}

public enum GuestOS: String, Codable, CaseIterable, Sendable { case macOS, linux }
public enum MachineMode: String, Codable, CaseIterable, Sendable { case desktop, server }
public enum InstallationState: String, Codable, Sendable { case pending, installing, ready, needsReview }
public struct Machine: Codable, Identifiable, Sendable, Equatable {
    public var id = UUID()
    public var name: String
    public var os: GuestOS
    public var mode: MachineMode
    public var cpuCount: Int
    public var memoryGiB: Int
    public var diskGiB: Int
    public var installerPath: String?
    public var installation: InstallationState = .pending
    public var macAddress: String
    public var directBoot: DirectBoot?
    public var executionLeaseID: UUID?
    public init(name: String, os: GuestOS, cpuCount: Int? = nil, memoryGiB: Int? = nil, diskGiB: Int? = nil, installerPath: String? = nil, mode: MachineMode = .desktop) {
        self.name = name; self.os = os; self.mode = mode
        self.cpuCount = cpuCount ?? (mode == .server ? 2 : 4)
        self.memoryGiB = memoryGiB ?? (mode == .server ? 1 : 8)
        self.diskGiB = diskGiB ?? (mode == .server ? 8 : 64); self.installerPath = installerPath
        let bytes = Array(id.uuidString.replacingOccurrences(of: "-", with: "").prefix(10))
        macAddress = "02:" + stride(from: 0, to: 10, by: 2).map { String(bytes[$0...$0+1]) }.joined(separator: ":")
    }
    private enum CodingKeys: String, CodingKey { case id, name, os, mode, cpuCount, memoryGiB, diskGiB, installerPath, installation, macAddress, executionLeaseID, directBoot }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id); name = try c.decode(String.self, forKey: .name)
        os = try c.decode(GuestOS.self, forKey: .os); mode = try c.decodeIfPresent(MachineMode.self, forKey: .mode) ?? .desktop
        cpuCount = try c.decode(Int.self, forKey: .cpuCount); memoryGiB = try c.decode(Int.self, forKey: .memoryGiB)
        diskGiB = try c.decode(Int.self, forKey: .diskGiB); installerPath = try c.decodeIfPresent(String.self, forKey: .installerPath)
        installation = try c.decode(InstallationState.self, forKey: .installation); macAddress = try c.decode(String.self, forKey: .macAddress)
        directBoot = try c.decodeIfPresent(DirectBoot.self, forKey: .directBoot)
        executionLeaseID = try c.decodeIfPresent(UUID.self, forKey: .executionLeaseID)
    }
    public func validate() throws {
        let small = mode == .server && os == .linux
        guard mode != .server || os == .linux else { throw CanaveralError.invalid("Server mode currently supports Linux. Use Desktop for macOS.") }
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 100,
              ((small ? 1 : 2)...64).contains(cpuCount), ((small ? 1 : 4)...128).contains(memoryGiB), ((small ? 4 : 32)...1024).contains(diskGiB) else {
            throw CanaveralError.invalid(small ? "Choose a name, 1–64 CPUs, 1–128 GB memory, and 4–1024 GB storage." : "Choose a name, 2–64 CPUs, 4–128 GB memory, and 32–1024 GB storage.")
        }
        if let directBoot { try directBoot.validateShape(machine: self) }
        if directBoot == nil, let installerPath {
            let ext = URL(fileURLWithPath: installerPath).pathExtension.lowercased()
            let formats = os == .linux ? ["iso", "img", "raw", "qcow2"] : ["ipsw"]
            guard formats.contains(ext) else { throw CanaveralError.invalid(small ? "Choose a Linux server ISO or a standalone IMG, RAW, or QCOW2 disk." : "Choose a macOS IPSW or a Linux ISO for this machine.") }
        }
    }
}
public struct MachineStatus: Codable, Sendable {
    public var pid: Int32; public var phase: String; public var detail: String; public var updatedAt: Date
    public var runnerProtocol: Int?; public var runtimeState: Int?; public var stopReason: String?
    public init(pid: Int32, phase: String, detail: String = "", updatedAt: Date = Date(), runnerProtocol: Int? = nil, runtimeState: Int? = nil, stopReason: String? = nil) { self.pid = pid; self.phase = phase; self.detail = detail; self.updatedAt = updatedAt; self.runnerProtocol = runnerProtocol; self.runtimeState = runtimeState; self.stopReason = stopReason }
    public var fresh: Bool { Date().timeIntervalSince(updatedAt) < 8 }
}
public struct MachineStore: Sendable {
    public let root: URL
    public init(root: URL) { self.root = root }
    public func directory(_ id: UUID) -> URL { root.appendingPathComponent(id.uuidString) }
    public func list() throws -> [Machine] {
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .filter { UUID(uuidString: $0.lastPathComponent) != nil }
            .map { try Self.load(directory: $0) }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    public static func load(directory: URL) throws -> Machine {
        let machine = try JSONDecoder().decode(Machine.self, from: Data(contentsOf: directory.appendingPathComponent("machine.json")))
        guard directory.lastPathComponent == machine.id.uuidString else { throw CanaveralError.invalid("Machine identity does not match its storage directory.") }
        try machine.validate(); return machine
    }
    public static func save(_ machine: Machine, directory: URL) throws {
        try machine.validate()
        try JSONEncoder().encode(machine).write(to: directory.appendingPathComponent("machine.json"), options: .atomic)
    }
    public func prepare(_ machine: Machine) throws -> URL {
        try machine.validate()
        if let boot = machine.directBoot {
            try boot.validate(machine: machine)
            let folder = directory(machine.id)
            guard !FileManager.default.fileExists(atPath: folder.path) else { throw CanaveralError.invalid("This machine already exists.") }
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            do {
                var prepared = machine; prepared.installation = .ready; prepared.installerPath = nil
                try Self.save(prepared, directory: folder); return folder
            } catch { try? FileManager.default.removeItem(at: folder); throw error }
        }
        guard let image = machine.installerPath, FileManager.default.isReadableFile(atPath: image) else { throw CanaveralError.invalid("Choose a readable installation image.") }
        let folder = directory(machine.id)
        guard !FileManager.default.fileExists(atPath: folder.path) else { throw CanaveralError.invalid("This machine already exists.") }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        do {
            let disk = folder.appendingPathComponent("disk.img")
            var prepared = machine
            if machine.os == .linux, URL(fileURLWithPath: image).pathExtension.lowercased() != "iso" {
                #if os(macOS)
                try CloudDisk.convert(URL(fileURLWithPath: image), to: disk)
                #else
                throw CanaveralError.unavailable("Server disk import requires macOS.")
                #endif
                let size = try FileManager.default.attributesOfItem(atPath: disk.path)[.size] as? NSNumber
                guard (size?.uint64Value ?? UInt64.max) <= UInt64(machine.diskGiB) * 1073741824 else { throw CanaveralError.invalid("Choose storage at least as large as the imported disk. The source disk was not changed.") }
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: disk.path)
                prepared.installation = .ready; prepared.installerPath = nil
            } else {
                guard FileManager.default.createFile(atPath: disk.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CanaveralError.unavailable("Could not create the guest disk.") }
                // Keep manually chosen installation media with its machine instead of an external path.
                let source = URL(fileURLWithPath: image)
                if !CanaveralStorage.contains(source, in: root.deletingLastPathComponent()) {
                    let imported = folder.appendingPathComponent("installer").appendingPathExtension(source.pathExtension)
                    try FileManager.default.copyItem(at: source, to: imported); prepared.installerPath = imported.path
                }
            }
            let file = try FileHandle(forWritingTo: disk); defer { try? file.close() }
            try file.truncate(atOffset: UInt64(machine.diskGiB) * 1024 * 1024 * 1024)
            try Self.save(prepared, directory: folder); return folder
        } catch { try? FileManager.default.removeItem(at: folder); throw error }
    }
    public func status(_ id: UUID) -> MachineStatus? {
        guard let data = try? Data(contentsOf: directory(id).appendingPathComponent("status.json")), let status = try? JSONDecoder().decode(MachineStatus.self, from: data), status.fresh else { return nil }
        return status
    }
}
