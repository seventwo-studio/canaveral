#if os(macOS)
import Foundation
import Virtualization
import Observation
import Darwin
import CanaveralVMCore

@MainActor @Observable public final class MachineRuntime: NSObject, @preconcurrency VZVirtualMachineDelegate {
    public var machine: Machine?
    public var virtualMachine: VZVirtualMachine?
    public var serialConsole: SerialConsole?
    public var phase = "Preparing"
    public var detail = ""
    public var busy = false
    private let directory: URL
    private let storage: StorageLocation?
    private var storageLease: StorageLease?
    private var lockFD: Int32 = -1
    private var ownsLock = false
    private var heartbeat: Task<Void, Never>?
    private var shutdownRequested = false
    private var directRelay: DirectBootRelay?
    private var stopReason: String?
    @ObservationIgnored private var installer: VZMacOSInstaller?
    public init(directory: URL, storage: StorageLocation? = nil) { self.directory = directory; self.storage = storage; super.init(); machine = try? MachineStore.load(directory: directory) }
    public func boot(leaseAuthorized: (@MainActor () -> Bool)? = nil) async {
        guard virtualMachine == nil, !busy else { return }; busy = true; defer { busy = false }
        do {
            if let storage { try storage.checkAvailable(); storageLease = try StorageLease(root: storage.root) }
            var m = try MachineStore.load(directory: directory)
            guard m.executionLeaseID == nil || leaseAuthorized?() == true else {
                throw CanaveralError.unavailable("Leased machines require their execution supervisor.")
            }
            lockFD = open(directory.appendingPathComponent("runtime.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
            guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { throw CanaveralError.unavailable("This machine is already running in another process.") }
            ownsLock = true
            guard m.installation != .needsReview, !(m.os == .macOS && m.installation == .installing) else { throw CanaveralError.unavailable("Installation was interrupted. Review the guest disk before retrying installation.") }
            machine = m
            if m.mode == .server { serialConsole = SerialConsole() }
            let vm = VZVirtualMachine(configuration: try MachineConfiguration.build(machine: m, directory: directory, serialAttachment: serialConsole?.attachment))
            virtualMachine = vm; vm.delegate = self
            heartbeat = Task { while !Task.isCancelled {
                if let storage {
                    do { try await Task.detached { try storage.checkAvailable() }.value }
                    catch {
                        self.phase = "Storage disconnected"; self.detail = error.localizedDescription
                        if vm.canStop { try? await vm.stop() }
                        return
                    }
                }
                self.serialConsole?.refresh()
                if let installer = self.installer { self.detail = "\(Int(installer.progress.fractionCompleted * 100))% installed" }
                self.writeStatus(); try? await Task.sleep(for: .seconds(2))
            } }
            if m.os == .macOS, m.installation == .pending {
                #if arch(arm64)
                guard let image = m.installerPath else { throw CanaveralError.invalid("Restore image missing.") }
                phase = "Installing macOS"; m.installation = .installing; machine = m; try MachineStore.save(m, directory: directory)
                let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: URL(fileURLWithPath: image))
                self.installer = installer
                defer { self.installer = nil }
                try await installer.install()
                m.installation = .ready; m.installerPath = nil; machine = m; detail = ""; try MachineStore.save(m, directory: directory)
                #endif
            } else if m.os == .linux, m.installation == .pending {
                m.installation = .installing; machine = m; try MachineStore.save(m, directory: directory)
            }
            shutdownRequested = false; stopReason = nil
            guard m.executionLeaseID == nil || leaseAuthorized?() == true else {
                throw CanaveralError.unavailable("Lease authorization ended before VM start.")
            }
            if let boot = m.directBoot {
                try DirectBootAttempt.consume(directory: directory, attempt: boot.bootAttempt)
                // Media flush can block; recheck authority after persisting intent.
                guard leaseAuthorized?() == true else { throw CanaveralError.unavailable("Lease authorization ended while persisting direct attempt.") }
            }
            phase = "Starting"; try await vm.start()
            if let boot = m.directBoot {
                directRelay = try DirectBootRelay(vm: vm)
                let event: [String: Any] = ["event": "started", "version": 1, "continuous": NativeLeaseClock.now(), "memberID": m.id.uuidString, "leaseID": boot.leaseID.uuidString, "bootSessionID": boot.bootSessionID.uuidString, "bootAttempt": boot.bootAttempt.uuidString, "agentSocket": directRelay!.socketPath]
                let data = try JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
                try data.write(to: directory.appendingPathComponent("direct-started.json"), options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: directory.appendingPathComponent("direct-started.json").path)
            }
            phase = "Running"; writeStatus()
        } catch { directRelay?.stop(); directRelay = nil; if let vm = virtualMachine, vm.canStop { try? await vm.stop() }; phase = "Unavailable"; detail = error.localizedDescription; serialConsole?.close(); writeStatus() }
    }
    public func pauseOrResume() async {
        guard let vm = virtualMachine, !busy else { return }; busy = true; defer { busy = false }
        do { if vm.canPause { try await vm.pause(); phase = "Paused" } else if vm.canResume { try await vm.resume(); phase = "Running" }; writeStatus() }
        catch { detail = error.localizedDescription }
    }
    public func restart() async {
        guard ownsLock, !busy, virtualMachine?.state == .stopped else { return }; busy = true; defer { busy = false }
        do {
            try storage?.checkAvailable()
            let m = try MachineStore.load(directory: directory)
            guard m.executionLeaseID == nil else { throw CanaveralError.unavailable("Leased machines cannot restart outside their execution supervisor.") }
            guard m.os == .linux || m.installation == .ready else { throw CanaveralError.invalid("Review the interrupted installation before restarting.") }
            serialConsole?.close(); serialConsole = m.mode == .server ? SerialConsole() : nil
            let vm = VZVirtualMachine(configuration: try MachineConfiguration.build(machine: m, directory: directory, serialAttachment: serialConsole?.attachment))
            vm.delegate = self; virtualMachine = vm; machine = m; phase = "Starting"; shutdownRequested = false; stopReason = nil
            try await vm.start(); phase = "Running"; detail = ""; writeStatus()
        } catch { detail = error.localizedDescription; writeStatus() }
    }
    public func requestShutdown() {
        guard let vm = virtualMachine, !busy, !shutdownRequested else { return }
        do { try vm.requestStop(); shutdownRequested = true; phase = "Stopping"; detail = "Graceful guest shutdown requested."; writeStatus() } catch { detail = error.localizedDescription; writeStatus() }
    }
    public func powerOff() async throws {
        guard let vm = virtualMachine, vm.canStop else { throw CanaveralError.unavailable("Native VM cannot be powered off in its current state.") }
        stopReason = "forced"
        try await vm.stop()
        directRelay?.stop(); directRelay = nil
        phase = "Stopped"; detail = "Explicit power-off completed; disk state is crash-consistent."; writeStatus()
    }
    public func guestDidStop(_ virtualMachine: VZVirtualMachine) { directRelay?.stop(); directRelay = nil; phase = "Stopped"; stopReason = stopReason ?? "guest"; serialConsole?.close(); writeStatus() }
    public func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: any Error) { directRelay?.stop(); directRelay = nil; phase = "Stopped"; stopReason = "error"; detail = error.localizedDescription; serialConsole?.close(); writeStatus() }
    public func finishLinuxInstallation() throws {
        try storage?.checkAvailable()
        guard let vm = virtualMachine, vm.state == .stopped, var m = machine, m.os == .linux else { throw CanaveralError.invalid("Shut down the installed Linux guest first.") }
        m.installation = .ready; m.installerPath = nil; try MachineStore.save(m, directory: directory); machine = m
        detail = "Installation media removed. Start the guest to boot from its installed disk."; writeStatus()
    }
    public func linkedDesktopID() throws -> String? {
        try storage?.checkAvailable()
        let file = directory.appendingPathComponent("desktop-helper.txt")
        if FileManager.default.fileExists(atPath: file.path) { return try String(contentsOf: file, encoding: .utf8) }
        if let id = machine?.id, let legacy = UserDefaults.standard.string(forKey: "guest-link-\(id)") {
            try setLinkedDesktopID(legacy); return legacy
        }
        return nil
    }
    public func setLinkedDesktopID(_ value: String?) throws {
        try storage?.checkAvailable()
        let file = directory.appendingPathComponent("desktop-helper.txt")
        if let value, !value.isEmpty {
            guard UUID(uuidString: value) != nil else { throw CanaveralError.invalid("Invalid guest helper identity.") }
            try Data(value.utf8).write(to: file, options: .atomic)
        } else if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        if let id = machine?.id { UserDefaults.standard.removeObject(forKey: "guest-link-\(id)") }
    }
    public func releaseWhenStopped() -> Bool {
        guard !busy else { detail = "Wait for the current machine operation to finish."; return false }
        guard virtualMachine == nil || virtualMachine?.state == .stopped || virtualMachine?.state == .error else { detail = "Shut down the guest before quitting its machine process."; return false }
        directRelay?.stop(); directRelay = nil
        phase = "Stopped"; stopReason = stopReason ?? (virtualMachine?.state == .error ? "error" : "guest"); writeStatus()
        heartbeat?.cancel(); heartbeat = nil
        serialConsole?.close()
        if lockFD >= 0 { close(lockFD); lockFD = -1 }; ownsLock = false; storageLease = nil; return true
    }
    private func writeStatus() {
        guard ownsLock else { return }
        try? JSONEncoder().encode(MachineStatus(pid: getpid(), phase: phase, detail: detail, runnerProtocol: 1, runtimeState: virtualMachine?.state.rawValue, stopReason: stopReason)).write(to: directory.appendingPathComponent("status.json"), options: .atomic)
    }
}
#endif
