import SwiftUI
import CanaveralVMCore
import CanaveralMachines

@MainActor @Observable final class MachineLibrary {
    var storage: StorageLocation?
    var error: String?
    var moving = false
    var progress = ""
    var revision = 0
    init() { reload() }
    func reload() {
        do { storage = try CanaveralStorage.resolve(); error = nil; revision += 1 }
        catch { self.error = error.localizedDescription }
    }
    func move(to parent: URL) {
        guard let source = storage, !moving else { return }; moving = true; error = nil
        Task {
            defer { moving = false }
            do {
                let next = try await Task.detached {
                    try StorageMigration.copy(from: source, to: parent) { detail in
                        Task { @MainActor in self.progress = detail }
                    }
                }.value
                try next.saveBookmark(); storage = next; revision += 1; progress = "Storage moved. Original files were retained."
            } catch { self.error = error.localizedDescription }
        }
    }
}
@main struct CanaveralMachinesApp: App {
    @State private var library = MachineLibrary()
    var body: some Scene {
        Window("Canaveral Machines", id: "machines") {
            if let storage = library.storage, !library.moving {
                NavigationStack { MachinesView(storage: storage) }.id(library.revision)
                    .frame(minWidth: 640, minHeight: 520)
            } else { ContentUnavailableView("Machine storage unavailable", systemImage: "externaldrive", description: Text(library.error ?? library.progress)) }
        }.defaultSize(width: 760, height: 680)
        Settings { MachineSettings(library: library).frame(width: 680, height: 560) }
    }
}
private struct MachineSettings: View {
    @Bindable var library: MachineLibrary
    @State private var helpers = DesktopModel()
    @State private var name = ""
    @State private var address = ""
    @State private var credential = ""
    @State private var picking = false
    @State private var destination: URL?
    @State private var confirming = false
    var body: some View {
        NavigationStack {
            Form {
                Section("Machine storage") {
                    if let storage = library.storage { Text(storage.root.path).textSelection(.enabled) }
                    Text("VM disks, restore images and helper connections belong to Canaveral. Stop machine processes before moving storage. Local drives and mounted network shares are supported.").font(.caption)
                    Button("Move machine storage…") { picking = true }.disabled(library.moving)
                    Button("Retry storage") { library.reload() }.disabled(library.moving)
                    if library.moving { ProgressView(library.progress) }
                    if let error = library.error { Text(error).foregroundStyle(.red) }
                }
                Section("Guest helpers") {
                    TextField("Name", text: $name)
                    TextField("Guest HTTPS Tailscale address", text: $address)
                    SecureField("Guest credential", text: $credential)
                    Button("Register helper") {
                        do {
                            let url = try ConnectionConfiguration.validateRemoteURL(address, allowedPorts: [443, 8443])
                            try helpers.register(.init(name: name, url: url), credential: credential)
                            name = ""; address = ""; credential = ""
                        } catch { helpers.error = error.localizedDescription }
                    }.disabled(name.isEmpty || address.isEmpty || credential.isEmpty || library.moving)
                    NavigationLink("View desktops and take over") { DesktopsView(model: helpers) }
                    ForEach(helpers.state.desktopTargets ?? []) { target in
                        HStack { Text(target.name); Spacer(); Button("Remove", role: .destructive) { do { try helpers.remove(target.id) } catch { helpers.error = error.localizedDescription } } }
                    }
                    if let error = helpers.error { Text(error).foregroundStyle(.red) }
                }
            }.formStyle(.grouped).task { await helpers.connect() }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.folder]) { result in
            do { destination = try result.get(); confirming = true } catch { library.error = error.localizedDescription }
        }
        .confirmationDialog("Move machine storage?", isPresented: $confirming) {
            Button("Copy and switch storage") { if let destination { library.move(to: destination) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Copy into a new Canaveral folder. Existing files are retained and destinations are never overwritten.") }
    }
}
