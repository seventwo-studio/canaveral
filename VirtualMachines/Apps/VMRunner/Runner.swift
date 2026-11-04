import Foundation
import Virtualization
import Darwin
import CanaveralVMCore
import CanaveralMachines

private struct Preparation: Decodable {
    var id: UUID
    var name: String
    var os: String
    var mode: String
    var cpu: Int
    var memoryMiB: Int
    var diskGiB: Int
    var image: String
    var directory: String
    var seedISO: String?
    var baseDisk: String?
    var auxiliaryStorage: String?
    var hardwareModel: String?
    var leaseID: UUID?
}
private struct PowerOffRequest: Decodable { var id: UUID; var boot: Double }
private struct NativeLaunch: Decodable { var attemptedAt: Double }

@MainActor private final class NativeLeaseWatch {
    let directory: URL, leaseID: UUID, machineID: UUID
    let boot: Double, bootSessionID: UUID
    var state: LeaseExecutionGuard
    init(directory: URL, machine: Machine, launch: NativeLaunch) throws {
        guard let leaseID = machine.executionLeaseID else { throw CanaveralError.invalid("This machine has no execution lease.") }
        self.directory = directory; self.leaseID = leaseID; machineID = machine.id; boot = launch.attemptedAt
        bootSessionID = try NativeLeaseClock.bootSession()
        state = LeaseExecutionGuard(machineID: machine.id, leaseID: leaseID, boot: boot, bootSessionID: bootSessionID)
    }
    func authorization() -> NativeLeaseAuthorization? {
        let path = directory.appendingPathComponent("lease-authorization.json")
        let descriptor = open(path.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { return nil }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_size > 0, metadata.st_size <= 4096,
              let data = try? handle.read(upToCount: 4097), data.count <= 4096 else { return nil }
        return try? JSONDecoder().decode(NativeLeaseAuthorization.self, from: data)
    }
    func authorized() -> Bool {
        let fence = directory.appendingPathComponent("lease-fenced.json")
        if !FileManager.default.fileExists(atPath: fence.path), state.observe(authorization(), now: NativeLeaseClock.now()) { return true }
        if !FileManager.default.fileExists(atPath: fence.path) {
            let record: [String: Any] = ["machineID": machineID.uuidString, "leaseID": leaseID.uuidString,
                "boot": boot, "bootSessionID": bootSessionID.uuidString, "revision": state.revision,
                "pid": getpid(), "fencedAt": NativeLeaseClock.now(), "reason": "lease-authorization-ended"]
            do {
                let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
                try data.write(to: fence, options: .atomic)
                let handle = try FileHandle(forWritingTo: fence); try handle.synchronize(); try handle.close()
                let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
                guard descriptor >= 0 else { throw CanaveralError.unavailable("Cannot persist lease fence.") }
                defer { close(descriptor) }
                guard fsync(descriptor) == 0 else { throw CanaveralError.unavailable("Cannot sync lease fence.") }
            } catch { FileHandle.standardError.write(Data("Lease fence receipt requires inspection.\n".utf8)) }
        }
        // This is an intentional power cut for a destroy-on-expiry environment.
        // Reclamation still requires process/lock/disk-handle confirmation.
        FileHandle.standardError.write(Data("Lease execution authorization ended.\n".utf8))
        _exit(70)
    }
    func start() -> Task<Void, Never> {
        Task { while !Task.isCancelled {
            _ = authorized()
            try? await Task.sleep(for: .milliseconds(100))
        } }
    }
}

@main struct CanaveralVMRunner {
    // The native restore object stays on the nonisolated executor.
    private nonisolated static func printRestoreImage() async throws {
        #if arch(arm64)
        let restore = try await VZMacOSRestoreImage.latestSupported
        guard restore.isSupported, let requirements = restore.mostFeaturefulSupportedConfiguration else {
            throw CanaveralError.unavailable("No supported macOS restore image is available for this Mac.")
        }
        let version = restore.operatingSystemVersion
        let result: [String: Any] = ["url": restore.url.absoluteString,
            "version": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
            "build": restore.buildVersion, "cpu": requirements.minimumSupportedCPUCount,
            "memoryMiB": requirements.minimumSupportedMemorySize / 1048576]
        let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
        #else
        throw CanaveralError.unavailable("macOS restore images require an Apple silicon host.")
        #endif
    }
    @MainActor static func main() async {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard let action = arguments.first else { throw CanaveralError.invalid("Use check, prepare, inspect DIRECTORY, or run DIRECTORY.") }
            switch action {
            case "lease-clock":
                let result: [String: Any] = ["version": 1, "bootSessionID": try NativeLeaseClock.bootSession().uuidString,
                                            "continuous": NativeLeaseClock.now()]
                print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self))
            case "check":
                guard VZVirtualMachine.isSupported else { throw CanaveralError.unavailable("Hardware virtualization is unavailable.") }
                print("Apple virtualization available")
            case "restore-image":
                try await printRestoreImage()
            case "prepare":
                let input = FileHandle.standardInput.readDataToEndOfFile()
                guard input.count <= 65536 else { throw CanaveralError.invalid("Preparation request too large.") }
                let request = try JSONDecoder().decode(Preparation.self, from: input)
                guard request.memoryMiB > 0, request.memoryMiB % 1024 == 0,
                      request.os == "linux" || request.os == "macos",
                      request.mode == "headless" || request.mode == "desktop" else {
                    throw CanaveralError.invalid("Use whole GiB memory and a supported guest system/mode.")
                }
                let store = MachineStore(root: URL(fileURLWithPath: request.directory))
                var machine = Machine(name: request.name, os: request.os == "macos" ? .macOS : .linux,
                                      cpuCount: request.cpu, memoryGiB: request.memoryMiB / 1024,
                                      diskGiB: request.diskGiB, installerPath: request.image,
                                      mode: request.mode == "headless" ? .server : .desktop)
                machine.id = request.id
                machine.executionLeaseID = request.leaseID
                // Generate the interface identity from the assigned UUID, not the initializer's UUID.
                let hex = request.id.uuidString.replacingOccurrences(of: "-", with: "").lowercased()
                machine.macAddress = "02:" + stride(from: 0, to: 10, by: 2).map { offset in
                    let start = hex.index(hex.startIndex, offsetBy: offset)
                    return String(hex[start..<hex.index(start, offsetBy: 2)])
                }.joined(separator: ":")
                let directory = try store.prepare(machine)
                machine = try MachineStore.load(directory: directory)
                if let seed = request.seedISO {
                    guard request.os == "linux" else { throw CanaveralError.invalid("Cloud-init seed media requires a Linux guest.") }
                    try FileManager.default.copyItem(at: URL(fileURLWithPath: seed), to: directory.appendingPathComponent("cloud-init.iso"))
                }
                try await MachineConfiguration.preparePlatform(machine: &machine, directory: directory)
                guard machine.cpuCount == request.cpu, machine.memoryGiB * 1024 == request.memoryMiB else {
                    throw CanaveralError.invalid("Restore image requires more CPU or memory than reserved. Increase the template minimum and review this partial preparation.")
                }
                if let base = request.baseDisk {
                    guard request.os == "macos", URL(fileURLWithPath: base).pathExtension.lowercased() == "raw", let auxiliary = request.auxiliaryStorage, let hardware = request.hardwareModel else {
                        throw CanaveralError.invalid("macOS clones require a standalone raw disk, auxiliary storage and matching restore image.")
                    }
                    let attributes = try FileManager.default.attributesOfItem(atPath: base)
                    guard let size = attributes[.size] as? NSNumber, size.uint64Value <= UInt64(request.diskGiB) * 1073741824 else {
                        throw CanaveralError.invalid("Requested storage is smaller than the macOS base disk.")
                    }
                    machine.installation = .needsReview
                    try MachineStore.save(machine, directory: directory)
                    let imported = directory.appendingPathComponent("imported-system.img")
                    try FileManager.default.copyItem(at: URL(fileURLWithPath: base), to: imported)
                    let disk = directory.appendingPathComponent("disk.img")
                    try FileManager.default.removeItem(at: disk)
                    try FileManager.default.moveItem(at: imported, to: disk)
                    let handle = try FileHandle(forWritingTo: disk)
                    try handle.truncate(atOffset: UInt64(request.diskGiB) * 1073741824)
                    try handle.close()
                    let importedAuxiliary = directory.appendingPathComponent("imported-auxiliary.bin")
                    try FileManager.default.copyItem(at: URL(fileURLWithPath: auxiliary), to: importedAuxiliary)
                    let auxiliaryTarget = directory.appendingPathComponent("auxiliary.bin")
                    try FileManager.default.removeItem(at: auxiliaryTarget)
                    try FileManager.default.moveItem(at: importedAuxiliary, to: auxiliaryTarget)
                    let hardwareData = try Data(contentsOf: URL(fileURLWithPath: hardware))
                    guard let model = VZMacHardwareModel(dataRepresentation: hardwareData), model.isSupported else {
                        throw CanaveralError.invalid("The macOS template hardware model is not supported on this host.")
                    }
                    try hardwareData.write(to: directory.appendingPathComponent("hardware.bin"), options: .atomic)
                    machine.installation = .ready; machine.installerPath = nil
                    try MachineStore.save(machine, directory: directory)
                }
                _ = try MachineConfiguration.build(machine: machine, directory: directory)
                try Data("prepared\n".utf8).write(to: directory.appendingPathComponent("native-prepared"), options: .atomic)
                print("Prepared \(machine.id)")
            case "inspect":
                guard arguments.count == 2 else { throw CanaveralError.invalid("inspect requires a machine directory.") }
                let file = URL(fileURLWithPath: arguments[1]).appendingPathComponent("runtime.lock")
                let fd = open(file.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
                guard fd >= 0 else { throw CanaveralError.unavailable("Cannot inspect the runtime lock.") }
                defer { close(fd) }
                let locked = flock(fd, LOCK_EX | LOCK_NB) != 0
                print(locked ? "{\"locked\":true}" : "{\"locked\":false}")
            case "run", "lease-watch":
                guard arguments.count == 2 else { throw CanaveralError.invalid("run requires a machine directory.") }
                let directory = URL(fileURLWithPath: arguments[1])
                let runtime = MachineRuntime(directory: directory)
                let launchFile = directory.appendingPathComponent("runner-launch.json")
                let launch = try? JSONDecoder().decode(NativeLaunch.self, from: Data(contentsOf: launchFile))
                let machine = try MachineStore.load(directory: directory)
                var watch: NativeLeaseWatch?
                if machine.executionLeaseID != nil {
                    guard let launch else { throw CanaveralError.invalid("Leased machine launch identity is missing.") }
                    watch = try NativeLeaseWatch(directory: directory, machine: machine, launch: launch)
                }
                if action == "lease-watch" {
                    guard let watch else { throw CanaveralError.invalid("lease-watch requires a leased machine.") }
                    _ = watch.authorized()
                    FileHandle.standardOutput.write(Data("{\"ready\":true}\n".utf8))
                    while true { _ = watch.authorized(); try await Task.sleep(for: .milliseconds(100)) }
                }
                let leaseTask = watch?.start()
                defer { leaseTask?.cancel() }
                await runtime.boot(leaseAuthorized: { watch?.authorized() ?? true })
                guard runtime.virtualMachine != nil, runtime.phase != "Unavailable" else { throw CanaveralError.unavailable(runtime.detail) }
                let shutdown = directory.appendingPathComponent("shutdown.request")
                let consoleLog = directory.appendingPathComponent("console.log")
                var previousConsole = ""
                while let vm = runtime.virtualMachine, vm.state != .stopped, vm.state != .error {
                    if let output = runtime.serialConsole?.output, output != previousConsole {
                        // SerialConsole retains only its bounded tail, including in a headless process.
                        do {
                            try Data(output.utf8).write(to: consoleLog, options: .atomic)
                            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: consoleLog.path)
                        } catch {
                            // A diagnostic write failure must not terminate a running guest.
                            FileHandle.standardError.write(Data("Cannot save the guest console log.\n".utf8))
                        }
                        previousConsole = output
                    }
                    let powerFile = directory.appendingPathComponent("power-off.request")
                    if let data = try? Data(contentsOf: powerFile), data.count < 1024,
                       let request = try? JSONDecoder().decode(PowerOffRequest.self, from: data),
                       request.boot == launch?.attemptedAt {
                        do { try await runtime.powerOff() }
                        catch { FileHandle.standardError.write(Data("Native power-off is not yet available in the current VM state.\n".utf8)) }
                    } else if FileManager.default.fileExists(atPath: shutdown.path) { runtime.requestShutdown() }
                    try await Task.sleep(for: .seconds(1))
                }
                guard runtime.releaseWhenStopped() else { throw CanaveralError.unavailable("Guest has not stopped.") }
            default: throw CanaveralError.invalid("Unknown runner command.")
            }
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }
}
