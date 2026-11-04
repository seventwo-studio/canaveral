import Foundation
import CanaveralVMCore
import CanaveralMachines
import Virtualization

extension VMConfigurationCheck {
    @MainActor static func checkServerConfiguration(root: URL, image: URL) async throws {
        let store = MachineStore(root: root.appendingPathComponent("servers"))
        var machine = Machine(name: "Small server", os: .linux, installerPath: image.path, mode: .server)
        let folder = try store.prepare(machine)
        try await MachineConfiguration.preparePlatform(machine: &machine, directory: folder)
        let console = SerialConsole(); defer { console.close() }
        let config = try MachineConfiguration.build(machine: machine, directory: folder, serialAttachment: console.attachment)
        guard config.memorySize == 1073741824, config.cpuCount == 2, config.keyboards.isEmpty,
              config.pointingDevices.isEmpty, config.serialPorts.count == 1, config.directorySharingDevices.isEmpty,
              config.audioDevices.isEmpty, config.storageDevices.count == 2,
              config.networkDevices.first?.attachment is VZNATNetworkDeviceAttachment else { throw CanaveralError.invalid("Server configuration failed.") }
        try console.sendLine("console-input")
        guard try console.attachment.fileHandleForReading?.read(upToCount: Data("console-input\r".utf8).count) == Data("console-input\r".utf8) else { throw CanaveralError.invalid("Serial input pipe failed.") }
        try console.attachment.fileHandleForWriting?.write(contentsOf: Data("console-output\r\n".utf8))
        for _ in 0..<20 {
            try await Task.sleep(for: .milliseconds(20)); console.refresh()
            if console.output.contains("console-output") { break }
        }
        guard console.output.contains("console-output") else { throw CanaveralError.invalid("Serial output pipe failed.") }
        try FileManager.default.copyItem(at: image, to: folder.appendingPathComponent("cloud-init.iso"))
        let seeded = try MachineConfiguration.build(machine: machine, directory: folder)
        guard seeded.storageDevices.count == 3,
              seeded.storageDevices[1] is VZVirtioBlockDeviceConfiguration,
              let graphics = seeded.graphicsDevices.first as? VZVirtioGraphicsDeviceConfiguration,
              graphics.scanouts.first?.widthInPixels == 1024,
              graphics.scanouts.first?.heightInPixels == 768 else {
            throw CanaveralError.invalid("Headless cloud-init needs virtio seed storage and the EFI boot framebuffer.")
        }
    }

}
