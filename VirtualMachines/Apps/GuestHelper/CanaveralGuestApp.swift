import SwiftUI
import CanaveralVMCore
import ApplicationServices

@MainActor @Observable final class GuestModel {
    static let shared=GuestModel()
    var credential = ""
    var status = "Starting guest helper…"
    private var running: Task<Void, Never>?
    private var server: LoopbackServer?
    private var shells: GuestShells?
    private var displayStream: GuestDisplayStream?
    private var serviceLock: GuestServiceLock?
    private var bridge: DesktopBridge?
    init() {
        guard MacDesktopDevice.isVirtualGuest else { status = "Install Canaveral Guest inside a VM. Host desktop control is disabled."; return }
        do {
            let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Canaveral Guest")
            serviceLock=try GuestServiceLock(state:root)
            let vault = KeychainVault(service: "app.canaveral.guest")
            if let saved = try vault.read("desktop-credential"), let token = String(data: saved, encoding: .utf8) { credential = token }
            else { credential = try Secrets.randomToken(); try vault.write("desktop-credential", data: Data(credential.utf8)) }
            let files = try GuestFiles(root:URL(fileURLWithPath:"/"), state:root.appendingPathComponent("file-transfers"), permitted:{ MacDesktopDevice.isVirtualGuest })
            let home = FileManager.default.homeDirectoryForCurrentUser
            let environment=["HOME":home.path,"PATH":"/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin","TERM":"xterm-256color","LANG":"en_US.UTF-8","TMPDIR":NSTemporaryDirectory()]
            let terminals = try GuestShells(state:root.appendingPathComponent("shells"),permitted:{ MacDesktopDevice.isVirtualGuest }) { columns,rows in
                try GuestNativePTY(directory:home,argv:["/bin/zsh","-i"],environment:environment,columns:columns,rows:rows,permitted:{ MacDesktopDevice.isVirtualGuest })
            }
            shells=terminals
            let device=MacDesktopDevice(inputStateURL:root.appendingPathComponent("held-input"))
            let stream=try GuestDisplayStream(device:device,state:root.appendingPathComponent("display-stream"))
            displayStream=stream
            let bridge = try DesktopBridge(token: credential, device: device, journalURL: root.appendingPathComponent("inputs.json"), workspace:GuestWorkspace(files:files,shells:terminals), displayStream:stream)
            self.bridge=bridge
            let listener = try LoopbackServer(port: 8767) { await bridge.handle($0) }; server = listener
            running = Task { do { try await listener.run() } catch { status = error.localizedDescription } }
            status = "Guest helper listening on 127.0.0.1:8767"
        } catch { status = error.localizedDescription }
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
@MainActor final class GuestAppDelegate: NSObject, NSApplicationDelegate {
    private var terminating=false
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateCancel }
        terminating=true
        Task {
            let stopped=await GuestModel.shared.stop()
            terminating=false
            sender.reply(toApplicationShouldTerminate:stopped)
        }
        return .terminateLater
    }
}
@main struct CanaveralGuestApp: App {
    @NSApplicationDelegateAdaptor(GuestAppDelegate.self) private var delegate
    @State private var model = GuestModel.shared
    @Environment(\.openWindow) private var openWindow
    var body: some Scene {
        Window("Canaveral Guest", id: "guest") {
            Form {
                Text(model.status)
                if !model.credential.isEmpty {
                    Section("Connect this guest") {
                        Text("Run Tailscale Serve for 127.0.0.1:8767, then register its HTTPS address and this credential in the Canaveral Machines settings on the host.")
                        Text(model.credential).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    }
                    Section("Guest permissions") {
                        Button("Allow Screen Recording") { _ = CGRequestScreenCaptureAccess() }
                        Button("Allow Accessibility") { _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary) }
                        Text("Allow these permissions only inside this guest. The helper stays running when its window closes.").font(.caption)
                    }
                }
            }.formStyle(.grouped).frame(width: 540, height: 400)
        }
        MenuBarExtra("Canaveral Guest", systemImage: "rectangle.dashed") {
            Text(model.status)
            Button("Open guest helper") { openWindow(id: "guest"); NSApp.activate() }
            Button("Quit guest helper") { NSApp.terminate(nil) }
        }
    }
}
