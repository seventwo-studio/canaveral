import SwiftUI
import CanaveralMachines
import CanaveralVMCore
import Virtualization

@MainActor final class MachineAppDelegate: NSObject, NSApplicationDelegate {
    var runtime: MachineRuntime?
    func applicationDidFinishLaunching(_ notification: Notification) {
        if runtime?.machine?.mode == .server { NSApp.setActivationPolicy(.accessory) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        runtime?.releaseWhenStopped() == true ? .terminateNow : .terminateCancel
    }
}
@main struct CanaveralMachineHostApp: App {
    @NSApplicationDelegateAdaptor(MachineAppDelegate.self) private var delegate
    @State private var runtime: MachineRuntime
    @Environment(\.openWindow) private var openWindow
    @State private var reopenObserver: NSObjectProtocol?
    init() {
        let args = CommandLine.arguments
        let path = args.firstIndex(of: "--machine").flatMap { args.indices.contains($0+1) ? args[$0+1] : nil } ?? "/nonexistent"
        let storagePath = args.firstIndex(of: "--storage-root").flatMap { args.indices.contains($0+1) ? args[$0+1] : nil }
        let storageID = args.firstIndex(of: "--storage-id").flatMap { args.indices.contains($0+1) ? args[$0+1] : nil }.flatMap(UUID.init(uuidString:))
        let storage = storagePath.map { path -> StorageLocation in
            let root = URL(fileURLWithPath: path)
            return StorageLocation(root: root, id: storageID ?? UUID())
        }
        let runtime = MachineRuntime(directory: URL(fileURLWithPath: path), storage: storage)
        _runtime = State(initialValue: runtime)
        delegate.runtime = runtime
        Task { await runtime.boot() }
    }
    var body: some Scene {
        Window(runtime.machine?.mode == .server ? "Server console" : "Guest desktop", id: "desktop") {
            VStack(spacing: 0) {
                HStack { Text(runtime.machine?.name ?? "Canaveral machine").font(.headline); Spacer(); Text(runtime.phase).foregroundStyle(.secondary) }.padding()
                if !runtime.detail.isEmpty { Text(runtime.detail).font(.callout).padding() }
                if runtime.machine?.mode == .server, let console = runtime.serialConsole {
                    ServerConsoleView(console: console, running: runtime.phase == "Running")
                } else if let vm = runtime.virtualMachine, runtime.machine?.mode != .server { MachineConsole(runtime: runtime, vm: vm) }
                else { ContentUnavailableView(runtime.phase, systemImage: "desktopcomputer", description: Text(runtime.detail)) }
            }.frame(minWidth: 640, minHeight: 480)
            .onAppear {
                installReopenObserver()
            }
            .toolbar {
                Button("Start guest", systemImage: "play") { Task { await runtime.restart() } }.disabled(runtime.busy || runtime.phase != "Stopped")
                Button("Pause / resume", systemImage: "pause") { Task { await runtime.pauseOrResume() } }.disabled(runtime.busy)
                Button("Shut down guest", systemImage: "power") { runtime.requestShutdown() }.disabled(runtime.busy)
                if runtime.machine?.os == .linux, runtime.machine?.installation != .ready {
                    Button("Finish installation") { do { try runtime.finishLinuxInstallation() } catch { runtime.detail = error.localizedDescription } }
                }
            }
        }.defaultSize(width: 1100, height: 760)
            .defaultLaunchBehavior(runtime.machine?.mode == .server && !CommandLine.arguments.contains("--show-console") ? .suppressed : .presented)
        MenuBarExtra {
            Button(runtime.machine?.mode == .server ? "Open console" : "Open desktop") { openWindow(id: "desktop"); NSApp.activate() }
            Button("Start guest") { Task { await runtime.restart() } }.disabled(runtime.phase != "Stopped")
            Button("Pause / resume") { Task { await runtime.pauseOrResume() } }
            Button("Shut down guest") { runtime.requestShutdown() }
            Divider()
            Button("Quit machine process") { if runtime.releaseWhenStopped() { NSApp.terminate(nil) } }
        } label: {
            Label(String((runtime.machine?.name ?? "Canaveral machine").prefix(30)), systemImage: runtime.machine?.mode == .server ? "server.rack" : "desktopcomputer")
                .onAppear { installReopenObserver() }
        }
    }
    private func installReopenObserver() {
        guard reopenObserver == nil else { return }
        reopenObserver = DistributedNotificationCenter.default().addObserver(forName: .init("app.canaveral.machine.reopen"), object: nil, queue: .main) { note in
            let id = note.object as? String
            Task { @MainActor in if id == runtime.machine?.id.uuidString { openWindow(id: "desktop"); NSApp.activate() } }
        }
    }
}

@MainActor private struct MachineConsole: View {
    @Bindable var runtime: MachineRuntime
    var vm: VZVirtualMachine
    @State private var model = DesktopModel()
    @State private var selected = ""
    @State private var manual = false
    @State private var unlinking = false
    private var target: DesktopTarget? { model.state.desktopTargets?.first { $0.id.uuidString == selected } }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("AI guest helper", selection: $selected) {
                    if selected.isEmpty { Text("No helper linked").tag("") }
                    else if target == nil { Text("Linked helper unavailable").tag(selected) }
                    ForEach(model.state.desktopTargets ?? []) { Text($0.name).tag($0.id.uuidString) }
                }.frame(maxWidth: 400).disabled(!selected.isEmpty)
                if !selected.isEmpty {
                    Text("Use Controls to take over.").font(.caption).foregroundStyle(.secondary)
                    Button("Change helper") {
                        unlinking = true
                        Task {
                            do {
                                if let target { _ = try await model.desktopControl(target.id, human: true) }
                                try runtime.setLinkedDesktopID(nil)
                                selected = ""; manual = false
                            } catch { model.error = error.localizedDescription }
                            unlinking = false
                        }
                    }.disabled(unlinking || !model.connected)
                }
                else { Button("Reconnect helpers") { Task { await model.connect() } } }
                Spacer()
            }.padding()
            if let error = model.error { Text(error).foregroundStyle(.red).padding(8) }
            if let target {
                TabView {
                    Tab("Live desktop", systemImage: "display") {
                        VStack(spacing: 0) {
                            Text("View only. Take over in Controls to send input through the guest helper.").font(.caption).foregroundStyle(.secondary).padding(8)
                            GuestDesktopView(virtualMachine: vm, inputEnabled: false)
                        }
                    }
                    Tab("Controls", systemImage: "hand.raised") { RemoteDesktopView(target: target, model: model) }
                }
            } else {
                if selected.isEmpty {
                    Toggle("Enable manual console — no AI is controlling this guest", isOn: $manual).padding()
                } else {
                    Text("The linked helper is unavailable. Reconnect helpers to use takeover controls.").padding()
                }
                GuestDesktopView(virtualMachine: vm, inputEnabled: selected.isEmpty && manual)
            }
        }
        .task {
            do { selected = try runtime.linkedDesktopID() ?? "" }
            catch { selected = "unavailable"; model.error = error.localizedDescription }
            await model.connect()
        }
        .onChange(of: selected) {
            manual = false
            if !selected.isEmpty, selected != "unavailable" {
                do { try runtime.setLinkedDesktopID(selected) } catch { model.error = error.localizedDescription }
            }
        }
    }
}
