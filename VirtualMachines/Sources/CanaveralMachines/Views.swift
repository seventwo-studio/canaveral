#if os(macOS)
import SwiftUI
import Virtualization
import UniformTypeIdentifiers
import CanaveralVMCore

public struct GuestDesktopView: NSViewRepresentable {
    public var virtualMachine: VZVirtualMachine
    public var inputEnabled: Bool
    public init(virtualMachine: VZVirtualMachine, inputEnabled: Bool = false) { self.virtualMachine = virtualMachine; self.inputEnabled = inputEnabled }
    public func makeNSView(context: Context) -> VZVirtualMachineView {
        let view = GatedVirtualMachineView(); view.inputEnabled = inputEnabled; view.virtualMachine = virtualMachine
        view.capturesSystemKeys = false; view.automaticallyReconfiguresDisplay = true; return view
    }
    public func updateNSView(_ view: VZVirtualMachineView, context: Context) {
        if view.virtualMachine !== virtualMachine { view.virtualMachine = virtualMachine }
        if let gated = view as? GatedVirtualMachineView {
            gated.inputEnabled = inputEnabled
            if !inputEnabled, let responder = view.window?.firstResponder as? NSView, responder === view || responder.isDescendant(of: view) { view.window?.makeFirstResponder(nil) }
        }
    }
}
private final class GatedVirtualMachineView: VZVirtualMachineView {
    var inputEnabled = false
    override var acceptsFirstResponder: Bool { inputEnabled && super.acceptsFirstResponder }
    override func hitTest(_ point: NSPoint) -> NSView? { inputEnabled ? super.hitTest(point) : nil }
    override func keyDown(with event: NSEvent) { if inputEnabled { super.keyDown(with: event) } }
    override func keyUp(with event: NSEvent) { if inputEnabled { super.keyUp(with: event) } }
    override func flagsChanged(with event: NSEvent) { if inputEnabled { super.flagsChanged(with: event) } }
    override func scrollWheel(with event: NSEvent) { if inputEnabled { super.scrollWheel(with: event) } }
}
private enum MacRestoreSource: String { case automatic, cached, local }
public struct MachinesView: View {
    @State private var machines: [Machine] = []
    @State private var creating = false
    @State private var name = ""
    @State private var os: GuestOS = MacOSRestoreImages.supported ? .macOS : .linux
    @State private var mode = MachineMode.desktop
    @State private var cpus = 4
    @State private var memory = 8
    @State private var disk = 64
    @State private var image: URL?
    @State private var picking = false
    @State private var restoreSource = MacRestoreSource.automatic
    @State private var cachedRestores: [CachedMacOSRestore] = []
    @State private var cachedID = ""
    @State private var creationTask: Task<Void, Never>?
    @State private var preparation = ""
    @State private var progress: RestoreDownloadProgress?
    @State private var canceling = false
    @State private var busy = false
    @State private var error: String?
    @State private var revision = 0
    private let store: MachineStore
    private let storage: StorageLocation
    private let restores: MacOSRestoreImageStore
    public init(storage: StorageLocation) {
        self.storage = storage; store = MachineStore(root: storage.machines)
        restores = MacOSRestoreImageStore(root: storage.restores, storage: storage)
    }
    public var body: some View {
        List {
            if machines.isEmpty { ContentUnavailableView("A machine for each kind of work", systemImage: "server.rack", description: Text("Create macOS or Linux desktops and small Linux servers. Each machine keeps running in its own process when Canaveral closes.")) }
            ForEach(machines) { machine in
                VStack(alignment: .leading, spacing: 10) {
                    HStack { Label(machine.name, systemImage: machine.mode == .server ? "server.rack" : "desktopcomputer").font(.headline); Spacer(); Text(store.status(machine.id)?.phase ?? "Stopped").foregroundStyle(.secondary) }
                    Text("\(machine.os.rawValue) \(machine.mode.rawValue) · \(machine.cpuCount) CPUs · \(machine.memoryGiB) GB memory · \(machine.diskGiB) GB storage").font(.caption).foregroundStyle(.secondary)
                    if let detail = store.status(machine.id)?.detail, !detail.isEmpty { Text(detail).font(.caption) }
                    Button(store.status(machine.id) == nil ? "Start \(machine.mode.rawValue)" : (machine.mode == .server ? "Open console" : "Open desktop")) { launch(machine) }
                        .disabled(busy)
                }.padding(.vertical, 10)
            }
        }
        .navigationTitle("Machines")
        .toolbar { Button("New machine", systemImage: "plus") { creating = true }.disabled(busy) }
        .task { reload(); while !Task.isCancelled { try? await Task.sleep(for: .seconds(2)); revision += 1 } }
        .onChange(of: revision) { reload() }
        .sheet(isPresented: $creating) {
            NavigationStack {
                Form {
                    TextField("Name", text: $name)
                    Picker("System", selection: $os) { Text("macOS").tag(GuestOS.macOS).disabled(!MacOSRestoreImages.supported); Text("Linux").tag(GuestOS.linux) }.onChange(of: os) { image = nil; if os == .macOS { mode = .desktop; resetSize() } }
                    if os == .linux {
                        Picker("Use", selection: $mode) { Text("Desktop").tag(MachineMode.desktop); Text("Server").tag(MachineMode.server) }
                            .onChange(of: mode) { image = nil; resetSize() }
                    }
                    Stepper("CPUs: \(cpus)", value: $cpus, in: (mode == .server ? 1 : 2)...min(64, max(2, ProcessInfo.processInfo.processorCount)))
                    Stepper("Memory: \(memory) GB", value: $memory, in: (mode == .server ? 1 : 4)...128)
                    Stepper("Storage: \(disk) GB", value: $disk, in: (mode == .server ? 4 : 32)...1024, step: mode == .server ? 4 : 16)
                    if os == .macOS {
                        Picker("Install macOS", selection: $restoreSource) {
                            Text("Latest compatible macOS from Apple").tag(MacRestoreSource.automatic)
                            if !cachedRestores.isEmpty { Text("Reuse downloaded macOS").tag(MacRestoreSource.cached) }
                            Text("Use a local IPSW").tag(MacRestoreSource.local)
                        }
                        if restoreSource == .cached {
                            Picker("Downloaded version", selection: $cachedID) {
                                ForEach(cachedRestores) { restore in Text("macOS \(restore.descriptor.version) · \(restore.descriptor.build)").tag(restore.id) }
                            }
                        } else if restoreSource == .local {
                            Button(image?.lastPathComponent ?? "Choose macOS IPSW") { picking = true }
                        } else {
                            Text("Canaveral finds the latest version compatible with this Mac, downloads the restore image directly from Apple, and installs it. Completed downloads are kept for reuse.").font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        Button(image?.lastPathComponent ?? (mode == .server ? "Choose server disk or ISO" : "Choose Linux ISO")) { picking = true }
                    }
                    if mode == .server {
                        Text("Import an EFI-bootable IMG, RAW or standalone QCOW2 disk with login/SSH already configured, or use an ISO that supports serial installation. Enable a serial login on hvc0. No desktop window opens on startup.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Text("Linux media must match the host CPU architecture. Storage grows as the guest writes. Host folders and clipboard are not shared.").font(.caption).foregroundStyle(.secondary)
                    if busy {
                        if let fraction = progress?.fraction { ProgressView(preparation, value: fraction) }
                        else { ProgressView(preparation) }
                        if let progress {
                            Text(progress.expected > 0 ? "\(ByteCountFormatter.string(fromByteCount: progress.received, countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: progress.expected, countStyle: .file))" : ByteCountFormatter.string(fromByteCount: progress.received, countStyle: .file)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }.formStyle(.grouped).navigationTitle("New machine").disabled(busy)
                .interactiveDismissDisabled(busy)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(canceling ? "Canceling…" : "Cancel") {
                            if busy { canceling = true; preparation = "Canceling preparation…"; creationTask?.cancel() }
                            else { creating = false }
                        }.disabled(canceling)
                    }
                    ToolbarItem(placement: .confirmationAction) { Button(os == .macOS && restoreSource == .automatic ? "Download and create" : "Create") { create() }.disabled(!canCreate) }
                }
                .fileImporter(isPresented: $picking, allowedContentTypes: [.data]) { result in do { image = try result.get() } catch { self.error = error.localizedDescription } }
            }.frame(width: 500, height: 620)
            .task { await loadCachedRestores() }
        }
        .alert("Machines", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK") { error = nil } } message: { Text(error ?? "") }
    }
    private func reload() { do { try storage.checkAvailable(); machines = try store.list() } catch { self.error = error.localizedDescription } }
    private func resetSize() { cpus = mode == .server ? 2 : 4; memory = mode == .server ? 1 : 8; disk = mode == .server ? 8 : 64 }
    private var canCreate: Bool {
        guard !busy, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if os == .macOS {
            guard MacOSRestoreImages.supported else { return false }
            if restoreSource == .automatic { return true }
            if restoreSource == .cached { return cachedRestores.contains(where: { $0.id == cachedID }) }
        }
        return image != nil
    }
    private func loadCachedRestores() async {
        do {
            try storage.checkAvailable()
            cachedRestores = try await restores.cached()
            if !cachedRestores.contains(where: { $0.id == cachedID }) { cachedID = cachedRestores.first?.id ?? "" }
            if cachedRestores.isEmpty && restoreSource == .cached { restoreSource = .automatic }
        } catch { self.error = error.localizedDescription }
    }
    private func create() {
        guard canCreate else { return }
        busy = true; canceling = false; progress = nil; preparation = "Preparing the machine…"
        var machine = Machine(name: name, os: os, cpuCount: cpus, memoryGiB: memory, diskGiB: disk, installerPath: image?.path, mode: mode)
        let source = restoreSource, selected = cachedRestores.first { $0.id == cachedID }
        creationTask = Task { @MainActor in
            defer { busy = false; canceling = false; creationTask = nil; progress = nil }
            var directory: URL?
            do {
                try storage.checkAvailable()
                let lease = try StorageLease(root: storage.root)
                defer { withExtendedLifetime(lease) {} }
                if machine.os == .macOS && source == .automatic {
                    preparation = "Finding compatible macOS from Apple…"
                    let descriptor = try await MacOSRestoreImages.latestSupported()
                    preparation = "Downloading macOS \(descriptor.version)…"
                    let file = try await restores.obtain(descriptor) { update in
                        Task { @MainActor in if !canceling { progress = update } }
                    }
                    machine.installerPath = file.path
                } else if machine.os == .macOS && source == .cached {
                    preparation = "Checking downloaded macOS…"
                    guard let selected else { throw CanaveralError.invalid("Choose a downloaded macOS image.") }
                    machine.installerPath = try await restores.useCached(selected).path
                }
                try Task.checkCancellation(); try storage.checkAvailable(); preparation = "Preparing guest storage and hardware…"; progress = nil
                directory = try store.prepare(machine)
                machine = try MachineStore.load(directory: directory!)
                try await MachineConfiguration.preparePlatform(machine: &machine, directory: directory!)
                try Task.checkCancellation()
                creating = false; name = ""; image = nil; reload(); launch(machine, background: machine.mode == .server)
            } catch {
                if let directory { try? FileManager.default.removeItem(at: directory) }
                if !Task.isCancelled { self.error = error.localizedDescription }
                else { preparation = "Preparation canceled" }
            }
            await loadCachedRestores()
        }
    }
    private func launch(_ machine: Machine, background: Bool = false) {
        // A running helper owns its VM. Reopen its window rather than start a duplicate guest.
        Task { @MainActor in
            do {
                try storage.checkAvailable()
                let lease = try StorageLease(root: storage.root)
                defer { withExtendedLifetime(lease) {} }
                if let status = store.status(machine.id), let app = NSRunningApplication(processIdentifier: status.pid) {
                    app.activate(options: [])
                    DistributedNotificationCenter.default().postNotificationName(.init("app.canaveral.machine.reopen"), object: machine.id.uuidString, userInfo: nil, deliverImmediately: true)
                    return
                }
                let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/CanaveralMachineHost.app")
                guard FileManager.default.fileExists(atPath: helper.path) else { throw CanaveralError.unavailable("The bundled machine host is missing. Rebuild CanaveralMac.") }
                let config = NSWorkspace.OpenConfiguration(); config.createsNewApplicationInstance = true; config.activates = !background
                config.arguments = ["--machine", store.directory(machine.id).path, "--storage-root", storage.root.path, "--storage-id", storage.id.uuidString] + (background ? [] : ["--show-console"])
                _ = try await NSWorkspace.shared.openApplication(at: helper, configuration: config)
            } catch { self.error = error.localizedDescription }
        }
    }
}
#endif
