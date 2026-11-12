// Explicit operator-only diagnostic. Never boots a valid image or bypasses lease admission.
import Foundation
import Virtualization
import Darwin

@main struct SessionProbe {
    @MainActor static func main() async {
        guard CommandLine.arguments.count == 2 else { exit(64) }
        let config = VZVirtualMachineConfiguration()
        config.cpuCount = 2
        config.memorySize = 2 * 1024 * 1024 * 1024
        config.platform = VZGenericPlatformConfiguration()
        config.bootLoader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: CommandLine.arguments[1]))
        func report(_ stage: String, _ error: Error? = nil) {
            let e = error as NSError?
            let data: [String: Any] = ["stage": stage, "supported": VZVirtualMachine.isSupported,
                "error": e?.description ?? NSNull()]
            print(String(decoding: try! JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]), as: UTF8.self))
            fflush(stdout)
        }
        do { try config.validate(); report("validated") }
        catch { report("validation-rejected", error); exit(1) }
        // This input must be a deliberately invalid file supplied by the operator.
        guard let bytes = try? Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])),
              bytes == Data("invalid-canaveral-probe-kernel\n".utf8) else { exit(64) }
        DispatchQueue.global().asyncAfter(deadline: .now() + 15) { exit(124) }
        let vm = VZVirtualMachine(configuration: config)
        do {
            try await vm.start()
            report("unexpected-start")
            try await vm.stop()
            exit(2)
        } catch { report("start-rejected", error) }
        // No guest disk or OS: starting firmware tests VZ service admission independently of a kernel.
        let storeURL = URL(fileURLWithPath: CommandLine.arguments[1] + "." + UUID().uuidString + ".nvram")
        defer { try? FileManager.default.removeItem(at: storeURL) }
        do {
            let loader = VZEFIBootLoader()
            loader.variableStore = try VZEFIVariableStore(creatingVariableStoreAt: storeURL)
            config.bootLoader = loader
            try config.validate(); report("efi-validated")
            let firmware = VZVirtualMachine(configuration: config)
            try await firmware.start(); report("efi-started")
            try await firmware.stop(); report("efi-stopped")
        } catch { report("efi-rejected", error); exit(1) }
    }
}
