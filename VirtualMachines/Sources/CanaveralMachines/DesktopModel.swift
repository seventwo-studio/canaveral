import Foundation
import Observation
import CanaveralVMCore

/// Guest-only connections; uses separate guest credentials.
@MainActor @Observable public final class DesktopModel {
    public struct State { public var desktopTargets: [DesktopTarget]? = [] }
    public var state = State()
    public var connected = false
    public var error: String?
    private let storage: StorageLocation?
    private let vault = KeychainVault()
    public init(storage: StorageLocation? = nil) { self.storage = storage }
    private func location() throws -> StorageLocation { try storage ?? CanaveralStorage.resolve() }
    public func connect() async {
        do {
            let location = try location(); try location.checkAvailable()
            let url = location.root.appendingPathComponent("desktops.json")
            state.desktopTargets = FileManager.default.fileExists(atPath: url.path) ? try JSONDecoder().decode([DesktopTarget].self, from: Data(contentsOf: url)) : []
            connected = true; error = nil
        } catch { connected = false; self.error = error.localizedDescription }
    }
    public func register(_ target: DesktopTarget, credential: String) throws {
        try target.validate()
        guard (32...256).contains(credential.count), !credential.contains(where: \.isWhitespace) else { throw CanaveralError.invalid("Invalid guest credential.") }
        try vault.write("desktop-\(target.id)", data: Data(credential.utf8))
        state.desktopTargets = (state.desktopTargets ?? []).filter { $0.id != target.id } + [target]
        try persist()
    }
    public func remove(_ id: UUID) throws {
        try vault.delete("desktop-\(id)"); state.desktopTargets?.removeAll { $0.id == id }; try persist()
    }
    public func desktop(_ id: UUID) async throws -> DesktopSession { try await client(id).session() }
    public func desktopControl(_ id: UUID, human: Bool) async throws -> DesktopControlState {
        let result = try await client(id).control(human)
        if let i = state.desktopTargets?.firstIndex(where: { $0.id == id }) { state.desktopTargets?[i].userControl = result.userControl }
        try persist(); return result
    }
    public func desktopInput(_ id: UUID, action: DesktopAction) async throws -> DesktopReceipt {
        var input = action; input.human = true; return try await client(id).perform(input)
    }
    private func client(_ id: UUID) throws -> DesktopClient {
        try location().checkAvailable()
        guard let target = state.desktopTargets?.first(where: { $0.id == id }), let data = try vault.read("desktop-\(id)"), let token = String(data: data, encoding: .utf8) else { throw CanaveralError.invalid("Register the guest helper in Canaveral Machines.") }
        return .init(target: target, token: token)
    }
    private func persist() throws {
        let location = try location(); try location.checkAvailable()
        let url = location.root.appendingPathComponent("desktops.json")
        try JSONEncoder().encode(state.desktopTargets ?? []).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
