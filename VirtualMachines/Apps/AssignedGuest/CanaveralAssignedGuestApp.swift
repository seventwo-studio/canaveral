import SwiftUI
import CanaveralVMCore
import CanaveralGuestDesktop
import ApplicationServices

@MainActor @Observable final class AssignedGuestModel {
    static let shared=AssignedGuestModel()
    var status = "Starting guest helper…"
    private var running: Task<Void, Never>?
    private var server: BoundTLSServer?
    private var shells: GuestShells?
    private var displayStream: GuestDisplayStream?
    private var serviceLock: GuestServiceLock?
    private var bridge: DesktopBridge?
    init() {
        guard MacDesktopDevice.isVirtualGuest else { status = "Install Canaveral Guest inside a VM. Host desktop control is disabled."; return }
        do {
            let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Canaveral Guest")
            serviceLock=try GuestServiceLock(state:root)
            let bootstrap = try AssignedGuestStartup.start(isVirtualGuest: MacDesktopDevice.isVirtualGuest, mounts: GuestBootstrapSelector.systemMounts) { $0 }
            let launchRoot = root.appendingPathComponent("assigned/" + bootstrap.assignment.launchId)
            let identity = try GuestTLSIdentity(pkcs12: bootstrap.pkcs12, launchId: bootstrap.assignment.launchId)
            let state = launchRoot
            let files = try GuestFiles(root:URL(fileURLWithPath:"/"), state:state.appendingPathComponent("file-transfers"), permitted:{ MacDesktopDevice.isVirtualGuest })
            let home = FileManager.default.homeDirectoryForCurrentUser
            let environment=["HOME":home.path,"PATH":"/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin","TERM":"xterm-256color","LANG":"en_US.UTF-8","TMPDIR":NSTemporaryDirectory()]
            let terminals = try GuestShells(state:state.appendingPathComponent("shells"),permitted:{ MacDesktopDevice.isVirtualGuest }) { columns,rows in
                try GuestNativePTY(directory:home,argv:["/bin/zsh","-i"],environment:environment,columns:columns,rows:rows,permitted:{ MacDesktopDevice.isVirtualGuest })
            }
            shells=terminals
            let device=MacDesktopDevice(inputStateURL:state.appendingPathComponent("held-input"))
            let stream=try GuestDisplayStream(device:device,state:state.appendingPathComponent("display-stream"))
            displayStream=stream
            let bridge = try DesktopBridge(token: bootstrap.credential, device: device, journalURL: state.appendingPathComponent("inputs.json"), workspace:GuestWorkspace(files:files,shells:terminals), assignment: bootstrap.assignment, displayStream:stream)
            self.bridge=bridge
            running = Task {
                do {
                    let address = try await GuestInterface.wait(machineId: bootstrap.assignment.machineId)
                    try GuestAssignedLaunchAttempt.consume(state: launchRoot)
                    let listener = try BoundTLSServer(address: address, port: 8767, identity: identity, authenticate: { await bridge.authenticateHead($0) }, handler: { await bridge.handle($0) })
                    server = listener
                    try await listener.run { Task { @MainActor in self.status = "Guest helper ready" } }
                } catch { status = "Guest helper could not start" }
            }
        } catch { status = "Guest helper could not start" }
    }
    func stop() async -> Bool {
        server?.stop(); running?.cancel()
        var inputReset=true
        do { try await bridge?.shutdownInput() } catch { inputReset=false }
        let shellsClosed=await shells?.revoke() ?? true
        let closed=inputReset && shellsClosed
        if !closed { status="Input or shell cleanup is unconfirmed. Retry quitting after inspecting the guest." }
        return closed
    }
}
@MainActor final class AssignedGuestAppDelegate: NSObject, NSApplicationDelegate {
    private var terminating=false
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateCancel }
        terminating=true
        Task {
            let stopped=await AssignedGuestModel.shared.stop()
            terminating=false
            sender.reply(toApplicationShouldTerminate:stopped)
        }
        return .terminateLater
    }
}
@main struct CanaveralAssignedGuestApp: App {
    @NSApplicationDelegateAdaptor(AssignedGuestAppDelegate.self) private var delegate
    @State private var model = AssignedGuestModel.shared
    @Environment(\.openWindow) private var openWindow
    var body: some Scene {
        Window("Canaveral Guest", id: "guest") {
            Form {
                Text(model.status)
            }.formStyle(.grouped).frame(width: 540, height: 400)
        }
        MenuBarExtra("Canaveral Guest", systemImage: "rectangle.dashed") {
            Text(model.status)
            Button("Open guest helper") { openWindow(id: "guest"); NSApp.activate() }
            Button("Quit guest helper") { NSApp.terminate(nil) }
        }
    }
}
