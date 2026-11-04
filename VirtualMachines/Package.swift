// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "CanaveralVirtualMachines", platforms: [.macOS("26.0")],
    products: [
        .library(name: "CanaveralVMCore", targets: ["CanaveralVMCore"]),
        .library(name: "CanaveralMachines", targets: ["CanaveralMachines"]),
        .executable(name: "CanaveralMachinesApp", targets: ["CanaveralMachinesApp"]),
        .executable(name: "CanaveralMachineHost", targets: ["CanaveralMachineHost"]),
        .executable(name: "CanaveralGuest", targets: ["CanaveralGuest"]),
        .executable(name: "CanaveralVMCheck", targets: ["CanaveralVMCheck"]),
        .executable(name: "CanaveralVMRunner", targets: ["CanaveralVMRunner"])
    ], targets: [
        .target(name: "CanaveralGuestPTYSupport"),
        .target(name: "CanaveralVMCore", dependencies: ["CanaveralGuestPTYSupport"]),
        .target(name: "CanaveralMachines", dependencies: ["CanaveralVMCore"]),
        .executableTarget(name: "CanaveralMachinesApp", dependencies: ["CanaveralMachines"], path: "Apps/Manager"),
        .executableTarget(name: "CanaveralMachineHost", dependencies: ["CanaveralMachines"], path: "Apps/MachineHost"),
        .executableTarget(name: "CanaveralGuest", dependencies: ["CanaveralVMCore"], path: "Apps/GuestHelper"),
        .executableTarget(name: "CanaveralVMCheck", dependencies: ["CanaveralMachines"], path: "Tests/VMConfigurationCheck"),
        .executableTarget(name: "CanaveralVMRunner", dependencies: ["CanaveralVMCore", "CanaveralMachines"], path: "Apps/VMRunner"),
        .testTarget(name: "CanaveralMachineTests", dependencies: ["CanaveralVMCore", "CanaveralMachines"])
    ])
