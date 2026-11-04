import Foundation
import CanaveralVMCore
import CanaveralMachines
import Virtualization

// Apple requires the virtualization entitlement even for configuration validation.
// This separate signed command-line check avoids altering Apple's XCTest runner.
@main struct VMConfigurationCheck {
    @MainActor static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralVMCheck-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let image = root.appendingPathComponent("fixture.iso")
        try Data(repeating: 0, count: 512).write(to: image)
        let store = MachineStore(root: root.appendingPathComponent("machines"))
        var m = Machine(name: "Configuration check", os: .linux, cpuCount: 2, memoryGiB: 4, diskGiB: 32, installerPath: image.path)
        let folder = try store.prepare(m)
        try await MachineConfiguration.preparePlatform(machine: &m, directory: folder)
        let config = try MachineConfiguration.build(machine: m, directory: folder)
        guard config.graphicsDevices.count == 1, config.directorySharingDevices.isEmpty,
              config.networkDevices[0].attachment is VZNATNetworkDeviceAttachment,
              config.storageDevices.count == 2, config.keyboards.count == 1,
              config.pointingDevices.count == 1, config.audioDevices.isEmpty else { throw CanaveralError.invalid("Guest isolation configuration check failed.") }
        m.installation = .ready
        let installed = try MachineConfiguration.build(machine: m, directory: folder)
        guard installed.storageDevices.count == 1 else { throw CanaveralError.invalid("Installer media was not detached.") }
        try await checkServerConfiguration(root: root, image: image)
        print("VM configuration checks passed: desktop graphics/NAT and small Linux server with serial I/O. No VM was booted.")
    }
}
