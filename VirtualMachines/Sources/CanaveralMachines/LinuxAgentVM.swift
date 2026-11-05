#if os(macOS)
import SwiftUI
import Virtualization
import CanaveralVMCore
import Darwin
import CryptoKit

@MainActor @Observable public final class LinuxAgentVM: NSObject, AgentTransport, @preconcurrency VZVirtualMachineDelegate, @preconcurrency VZVirtioSocketListenerDelegate {
    public var phase = "Set up execution computer"
    public var detail = "2 CPUs · 2 GB memory · 16 GB storage"
    public private(set) var virtualMachine: VZVirtualMachine?
    public var busy = false
    public let directory: URL
    public var relay: (@Sendable (JSONValue) async -> AsyncThrowingStream<JSONValue, any Error>)?
    private var listener: VZVirtioSocketListener?
    private var lease: Int32 = -1
    private var expectedRuntime: String?
    public var configured: Bool { FileManager.default.fileExists(atPath: directory.appendingPathComponent("disk.img").path) }
    public init(directory: URL) { self.directory = directory; super.init() }
    public func prepare(rawImage: URL, script: Data, unit: Data) async throws {
        guard !configured, virtualMachine == nil, !busy else { throw CanaveralError.invalid("This agent VM already has a disk. Its existing memory and projects are preserved.") }
        busy = true; defer { busy = false }
        let size = (try FileManager.default.attributesOfItem(atPath: rawImage.path)[.size] as? NSNumber)?.uint64Value ?? 0
        guard size >= 512, size <= 16 * 1073741824 else { throw CanaveralError.invalid("Choose a UEFI cloud disk, up to 16 GB, matching this Mac's CPU architecture.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let disk = directory.appendingPathComponent("disk.img")
        do {
            phase = "Preparing Linux disk"
            try await Task.detached { try CloudDisk.convert(rawImage, to: disk) }.value
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: disk.path)
            let file = try FileHandle(forWritingTo: disk); try file.truncate(atOffset: 16 * 1073741824); try file.close()
            try await stageRuntime(script: script, unit: unit)
        } catch { try? FileManager.default.removeItem(at: disk); throw error }
    }
    // Update only provisioning media. Guest memory, projects, disk identity and EFI persist.
    public func updateRuntime(script: Data, unit: Data) async throws {
        guard configured, virtualMachine == nil, !busy else { throw CanaveralError.invalid("Stop the Linux agent before updating its runtime.") }
        try acquireLease(); busy = true; defer { busy = false }
        try await stageRuntime(script: script, unit: unit)
    }
    private func stageRuntime(script: Data, unit: Data) async throws {
        expectedRuntime = SHA256.hash(data: script).map { String(format: "%02x", $0) }.joined()
        let version = SHA256.hash(data: script + unit + Data("seed-v3-local".utf8)).map { String(format: "%02x", $0) }.joined()
        if (try? String(contentsOf: directory.appendingPathComponent("runtime.sha256"), encoding: .utf8)) == version { return }
        let seed = directory.appendingPathComponent("seed-\(UUID())")
        try FileManager.default.createDirectory(at: seed, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: seed) }
        let userData = """
        #cloud-config
        hostname: seven-agent
        package_update: false
        package_upgrade: false
        # Provision before optional network-dependent cloud-config/final services.
        cloud_init_modules: [seed_random, write_files, growpart, resizefs, set_hostname, users_groups, bootcmd]
        users:
          - name: seven
            lock_passwd: true
            shell: /usr/sbin/nologin
        write_files:
          - path: /opt/seven/seven_agent.py
            owner: root:root
            permissions: '0644'
            encoding: b64
            content: \(script.base64EncodedString())
          - path: /etc/systemd/system/seven-agent.service
            owner: root:root
            permissions: '0644'
            encoding: b64
            content: \(unit.base64EncodedString())
        bootcmd:
          - [modprobe, vmw_vsock_virtio_transport]
          - [systemctl, daemon-reload]
          - [systemctl, enable, seven-agent.service]
          - [systemctl, --no-block, restart, seven-agent.service]
        """
        try Data(userData.utf8).write(to: seed.appendingPathComponent("user-data"))
        try Data("instance-id: seven-\(UUID())\nlocal-hostname: seven-agent\ndsmode: local\n".utf8).write(to: seed.appendingPathComponent("meta-data"))
        try Data("version: 2\nethernets: {}\n".utf8).write(to: seed.appendingPathComponent("network-config"))
        let staged = directory.appendingPathComponent("seed-\(UUID()).iso")
        defer { try? FileManager.default.removeItem(at: staged) }
        let seedPath = seed.path, isoPath = staged.path
        try await Task.detached {
            let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
            process.arguments = ["makehybrid", "-iso", "-joliet", "-default-volume-name", "cidata", "-o", isoPath, seedPath]
            process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            try process.run(); process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw CanaveralError.unavailable("Could not create the native cloud-init seed image.") }
        }.value
        let target = directory.appendingPathComponent("seed.iso")
        guard rename(staged.path, target.path) == 0 else { throw CanaveralError.unavailable("Could not atomically replace the agent runtime seed.") }
        try Data(version.utf8).write(to: directory.appendingPathComponent("runtime.sha256"), options: .atomic)
    }
    private func acquireLease() throws {
        guard lease < 0 else { return }
        let fd = open(directory.appendingPathComponent("runtime.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw CanaveralError.unavailable("Cannot open agent VM lock.") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw CanaveralError.unavailable("Another Canaveral process owns the agent VM.") }
        lease = fd
    }
    public static func configuration(directory: URL) throws -> VZVirtualMachineConfiguration {
        let config = VZVirtualMachineConfiguration()
        config.cpuCount = 2; config.memorySize = 2 * 1073741824
        let platform = VZGenericPlatformConfiguration()
        let identity = directory.appendingPathComponent("identity.bin")
        if let bytes = try? Data(contentsOf: identity), let saved = VZGenericMachineIdentifier(dataRepresentation: bytes) { platform.machineIdentifier = saved }
        else { let id = VZGenericMachineIdentifier(); platform.machineIdentifier = id; try id.dataRepresentation.write(to: identity) }
        config.platform = platform
        let boot = VZEFIBootLoader(), variables = directory.appendingPathComponent("efi.bin")
        boot.variableStore = FileManager.default.fileExists(atPath: variables.path) ? VZEFIVariableStore(url: variables) : try VZEFIVariableStore(creatingVariableStoreAt: variables)
        config.bootLoader = boot
        config.storageDevices = try [VZVirtioBlockDeviceConfiguration(attachment: VZDiskImageStorageDeviceAttachment(url: directory.appendingPathComponent("disk.img"), readOnly: false, cachingMode: .uncached, synchronizationMode: .full)), VZVirtioBlockDeviceConfiguration(attachment: VZDiskImageStorageDeviceAttachment(url: directory.appendingPathComponent("seed.iso"), readOnly: true))]
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        // Ubuntu's EFI boot path needs a firmware display even when no app window renders it.
        // This is a boot framebuffer, not a graphical desktop or host capture permission.
        let graphics = VZVirtioGraphicsDeviceConfiguration()
        graphics.scanouts = [VZVirtioGraphicsScanoutConfiguration(widthInPixels: 1024, heightInPixels: 768)]
        config.graphicsDevices = [graphics]
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        serial.attachment = try VZFileSerialPortAttachment(url: directory.appendingPathComponent("boot.log"), append: true)
        config.serialPorts = [serial]
        // No guest Ethernet, host folders, clipboard, audio, or input devices. No display window is required.
        try config.validate(); return config
    }
    public func boot() async throws {
        guard configured else { phase = "Set up the Linux agent"; return }
        guard virtualMachine == nil, !busy else { return }; busy = true; defer { busy = false }
        try acquireLease()
        do {
            phase = "Starting Linux"
            let vm = VZVirtualMachine(configuration: try Self.configuration(directory: directory)); virtualMachine = vm; vm.delegate = self
            let listener = VZVirtioSocketListener(); listener.delegate = self; self.listener = listener
            (vm.socketDevices.first as? VZVirtioSocketDevice)?.setSocketListener(listener, forPort: 7778)
            try await vm.start(); phase = "Linux is booting"; detail = "Waiting for the private agent connection…"
        } catch { phase = "Agent VM unavailable"; detail = error.localizedDescription; virtualMachine = nil; throw error }
    }
    public func request(_ payload: JSONValue) async throws -> JSONValue {
        guard let vm = virtualMachine, vm.state == .running, let socket = vm.socketDevices.first as? VZVirtioSocketDevice else { throw CanaveralError.unavailable("Set up and start the Linux agent VM in Canaveral.") }
        let box = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<AgentConnectionBox, any Error>) in
            let completion = AgentConnectionCompletion(continuation)
            let timeout = Task { @MainActor in try? await Task.sleep(for: .seconds(5)); if !Task.isCancelled { completion.finish(.failure(CanaveralError.unavailable("The Linux agent is still starting or unreachable."))) } }
            socket.connect(toPort: 7777) { result in timeout.cancel(); completion.finish(result) }
        }
        defer { box.connection.close() }
        let output = try await AgentSocket(duplicating: box.connection.fileDescriptor).exchange(payload)
        if payload.object?["method"]?.string != "shutdown", let expectedRuntime, output.object?["runtimeVersion"]?.string != expectedRuntime {
            throw CanaveralError.unavailable("The Linux agent runtime is updating. Wait for provisioning to finish.")
        }
        return output
    }
    public func stop() async {
        guard let vm = virtualMachine else { if lease >= 0 { close(lease); lease = -1 }; return }
        _ = try? await request(.object(["method": .string("shutdown")]))
        try? await vm.stop(); virtualMachine = nil; listener = nil
        if lease >= 0 { flock(lease, LOCK_UN); close(lease); lease = -1 }; phase = "Stopped"
    }
    public func guestDidStop(_ virtualMachine: VZVirtualMachine) { phase = "Stopped"; self.virtualMachine = nil }
    public func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: any Error) { phase = "Agent VM stopped"; detail = error.localizedDescription; self.virtualMachine = nil }
    public func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection, from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard let relay, connection.destinationPort == 7778, socketDevice === virtualMachine?.socketDevices.first else { return false }
        do {
            let channel = try AgentSocket(duplicating: connection.fileDescriptor)
            Task { @MainActor in
                defer { connection.close() }
                do {
                    let request = try await Task.detached { try channel.read(deadline: Date().addingTimeInterval(20)) }.value
                    let work = Task { @MainActor in
                        for try await packet in await relay(request) { try await Task.detached { try channel.write(packet, deadline: Date().addingTimeInterval(20)) }.value }
                    }
                    let monitor = Task { @MainActor in
                        while !Task.isCancelled {
                            if channel.peerClosed() { work.cancel(); return }
                            try? await Task.sleep(for: .milliseconds(100))
                        }
                    }
                    defer { monitor.cancel() }
                    try await work.value
                } catch { try? await Task.detached { try channel.write(.object(["error": .string(error.localizedDescription)]), deadline: Date().addingTimeInterval(2)) }.value }
            }
            return true
        } catch { return false }
    }
}
// Only this main-actor box crosses a continuation. The native connection never leaves its VM queue.
@MainActor private final class AgentConnectionBox: Sendable {
    let connection: VZVirtioSocketConnection
    init(_ connection: VZVirtioSocketConnection) { self.connection = connection }
}
@MainActor private final class AgentConnectionCompletion {
    private var continuation: CheckedContinuation<AgentConnectionBox, any Error>?
    init(_ continuation: CheckedContinuation<AgentConnectionBox, any Error>) { self.continuation = continuation }
    func finish(_ result: Result<VZVirtioSocketConnection, any Error>) {
        guard let continuation else { if case .success(let late) = result { late.close() }; return }
        self.continuation = nil
        switch result {
        case .success(let connection): continuation.resume(returning: AgentConnectionBox(connection))
        case .failure(let error): continuation.resume(throwing: error)
        }
    }
}
#endif
