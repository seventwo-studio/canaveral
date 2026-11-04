#if os(macOS)
import Foundation
import Virtualization
import CanaveralVMCore

@MainActor public enum MachineConfiguration {
    public static func preparePlatform(machine: inout Machine, directory: URL) async throws {
        guard VZVirtualMachine.isSupported else { throw CanaveralError.unavailable("Hardware virtualization is unavailable on this Mac.") }
        if machine.os == .macOS {
            #if arch(arm64)
            guard let path = machine.installerPath else { throw CanaveralError.invalid("Choose a macOS restore image.") }
            let image = try await VZMacOSRestoreImage.image(from: URL(fileURLWithPath: path))
            guard let requirements = image.mostFeaturefulSupportedConfiguration else { throw CanaveralError.unavailable("This restore image is unsupported on this Mac.") }
            machine.cpuCount = max(machine.cpuCount, requirements.minimumSupportedCPUCount)
            machine.memoryGiB = max(machine.memoryGiB, Int((requirements.minimumSupportedMemorySize + 1073741823) / 1073741824))
            try requirements.hardwareModel.dataRepresentation.write(to: directory.appendingPathComponent("hardware.bin"), options: .atomic)
            try VZMacMachineIdentifier().dataRepresentation.write(to: directory.appendingPathComponent("identity.bin"), options: .atomic)
            _ = try VZMacAuxiliaryStorage(creatingStorageAt: directory.appendingPathComponent("auxiliary.bin"), hardwareModel: requirements.hardwareModel, options: [])
            #else
            throw CanaveralError.unavailable("macOS guests require Apple silicon.")
            #endif
        } else {
            _ = try VZEFIVariableStore(creatingVariableStoreAt: directory.appendingPathComponent("efi.bin"))
            try VZGenericMachineIdentifier().dataRepresentation.write(to: directory.appendingPathComponent("identity.bin"), options: .atomic)
        }
        try MachineStore.save(machine, directory: directory)
        _ = try build(machine: machine, directory: directory)
    }
    public static func build(machine: Machine, directory: URL, serialAttachment: VZSerialPortAttachment? = nil) throws -> VZVirtualMachineConfiguration {
        try machine.validate()
        let c = VZVirtualMachineConfiguration()
        guard (VZVirtualMachineConfiguration.minimumAllowedCPUCount...VZVirtualMachineConfiguration.maximumAllowedCPUCount).contains(machine.cpuCount) else { throw CanaveralError.invalid("The CPU count exceeds this host's virtualization limits.") }
        c.cpuCount = machine.cpuCount; c.memorySize = UInt64(machine.memoryGiB) * 1073741824
        let disk = VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: directory.appendingPathComponent("disk.img"), readOnly: false, cachingMode: .uncached, synchronizationMode: .full))
        c.storageDevices = [disk]
        let seed = directory.appendingPathComponent("cloud-init.iso")
        if machine.os == .linux, FileManager.default.fileExists(atPath: seed.path) {
            c.storageDevices.append(VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: seed, readOnly: true)))
        }
        let network = VZVirtioNetworkDeviceConfiguration(); network.attachment = VZNATNetworkDeviceAttachment()
        guard let address = VZMACAddress(string: machine.macAddress) else { throw CanaveralError.invalid("Invalid guest network identity.") }
        network.macAddress = address; c.networkDevices = [network]
        c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        if machine.mode == .desktop {
            c.keyboards = [VZUSBKeyboardConfiguration()]
            c.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
        } else {
            let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
            serial.attachment = try serialAttachment ?? VZFileSerialPortAttachment(url: directory.appendingPathComponent("boot.log"), append: true)
            c.serialPorts = [serial]
        }
        // No host directories, clipboard, microphones, cameras, or physical devices are shared.
        if machine.os == .macOS {
            #if arch(arm64)
            let platform = VZMacPlatformConfiguration()
            guard let hardware = VZMacHardwareModel(dataRepresentation: try Data(contentsOf: directory.appendingPathComponent("hardware.bin"))), hardware.isSupported,
                  let identity = VZMacMachineIdentifier(dataRepresentation: try Data(contentsOf: directory.appendingPathComponent("identity.bin"))) else { throw CanaveralError.invalid("Guest hardware identity is missing or unsupported.") }
            platform.hardwareModel = hardware; platform.machineIdentifier = identity
            platform.auxiliaryStorage = VZMacAuxiliaryStorage(contentsOf: directory.appendingPathComponent("auxiliary.bin"))
            c.platform = platform; c.bootLoader = VZMacOSBootLoader()
            let graphics = VZMacGraphicsDeviceConfiguration()
            graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1440, heightInPixels: 900, pixelsPerInch: 110)]
            c.graphicsDevices = [graphics]
            #else
            throw CanaveralError.unavailable("macOS guests require Apple silicon.")
            #endif
        } else {
            let platform = VZGenericPlatformConfiguration()
            guard let identity = VZGenericMachineIdentifier(dataRepresentation: try Data(contentsOf: directory.appendingPathComponent("identity.bin"))) else { throw CanaveralError.invalid("Linux guest identity is missing.") }
            platform.machineIdentifier = identity; c.platform = platform
            let loader = VZEFIBootLoader(); loader.variableStore = VZEFIVariableStore(url: directory.appendingPathComponent("efi.bin")); c.bootLoader = loader
            if machine.installation != .ready, let path = machine.installerPath {
                c.storageDevices.append(VZUSBMassStorageDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: path), readOnly: true)))
            }
            let graphics = VZVirtioGraphicsDeviceConfiguration()
            // EFI still needs a boot framebuffer; server mode never renders it.
            graphics.scanouts = [VZVirtioGraphicsScanoutConfiguration(widthInPixels: machine.mode == .server ? 1024 : 1440, heightInPixels: machine.mode == .server ? 768 : 900)]
            c.graphicsDevices = [graphics]
        }
        try c.validate(); return c
    }
}
#endif
