import XCTest
import Foundation
import Security
@testable import CanaveralVMCore
@preconcurrency import Network
import CanaveralMachines
private struct TLSDevice: GuestDesktopDevice {
    func capture() async throws -> DesktopFrame { throw CanaveralError.interrupted }
    func perform(_ action: DesktopAction) async throws { XCTFail("Unexpected input") }
}
@MainActor final class GuestTLSTests: XCTestCase {
    func testProviderTLSRoundTrip() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let exchange = env["CANAVERAL_BOOTSTRAP_EXCHANGE"], let root = env["CANAVERAL_FIXTURE_ROOT"], let node = env["CANAVERAL_NODE"] else { throw XCTSkip("Run check_guest_bootstrap.mjs") }
        let storage = URL(fileURLWithPath: exchange)
        let bootstrap = try GuestBootstrap(data: Data(contentsOf: storage.appendingPathComponent("guest-bootstrap/content/assignment.json")))
        XCTAssertThrowsError(try GuestTLSIdentity(pkcs12: Data("bad".utf8), launchId: bootstrap.assignment.launchId))
        XCTAssertThrowsError(try GuestTLSIdentity(pkcs12: bootstrap.pkcs12, launchId: UUID().uuidString.lowercased()))
        let identity = try GuestTLSIdentity(pkcs12: bootstrap.pkcs12, launchId: bootstrap.assignment.launchId)
        var key: SecKey?
        XCTAssertEqual(SecIdentityCopyPrivateKey(identity.identity, &key), errSecSuccess)
        let attributes = SecKeyCopyAttributes(key!)! as NSDictionary
        // Some Security implementations report isPermanent even for memory-only
        // imports. Record that limit; narrowly scoped lookup must not find our key.
        func checkOwnKey() {
          if let label = attributes[kSecAttrApplicationLabel] {
            let result = SecItemCopyMatching([kSecClass as String: kSecClassKey, kSecAttrApplicationLabel as String: label, kSecReturnAttributes as String: true, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail] as CFDictionary, nil)
            XCTAssertTrue([errSecItemNotFound, errSecNotAvailable, errSecMissingEntitlement, errSecInteractionNotAllowed].contains(result), "Own key unexpectedly accessible in Keychain")
            print("Memory-only import: isPermanent=\(attributes[kSecAttrIsPermanent] ?? "absent"), own-key lookup status=\(result)")
          }
        }
        checkOwnKey()
        XCTAssertThrowsError(try GuestTLSIdentity(pkcs12: Data("invalid".utf8), launchId: bootstrap.assignment.launchId))
        checkOwnKey()
        let state = storage.appendingPathComponent("fixture-state")
        try FileManager.default.createDirectory(at: state.appendingPathComponent("files"), withIntermediateDirectories: true)
        try Data("fixture bytes".utf8).write(to: state.appendingPathComponent("files/hello"))
        let files = try GuestFiles(root: state.appendingPathComponent("files"), state: state.appendingPathComponent("transfers"), permitted: { true })
        let bridge = try DesktopBridge(token: bootstrap.credential, device: TLSDevice(), journalURL: state.appendingPathComponent("input.json"), workspace: files, assignment: bootstrap.assignment)
        var limits = BoundTLSServer.Limits(); limits.handshake = 1; limits.head = 1; limits.body = 2; limits.work = 1; limits.write = 1
        let listener = try BoundTLSServer(address: "127.0.0.1", port: 0, identity: identity, limits: limits, authenticate: { await bridge.authenticateHead($0) }, handler: { request in
            if request.path == "/v1/fixturework" { try? await Task.sleep(for: .seconds(3)); return .error("late fixture", status: 500) }
            if request.path == "/v1/fixturewrite" { return HTTPResponse(body: Data(repeating: 32, count: 64 * 1048576)) }
            return await bridge.handle(request)
        })
        let ready = expectation(description: "TLS listener ready")
        let running = Task { try await listener.run { ready.fulfill() } }
        await fulfillment(of: [ready], timeout: 5)
        defer { listener.stop(); running.cancel() }
        let process = Process(); process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [root + "/script/check_assigned_tls_client.mjs", exchange, String(listener.port!)]
        process.environment = env
        try process.run()
        while process.isRunning { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(process.terminationStatus, 0)
        let stats = await listener.statistics()
        XCTAssertEqual(stats.total, limits.total); XCTAssertLessThanOrEqual(stats.unauthenticated, limits.unauthenticated)
        XCTAssertLessThanOrEqual(stats.preauthBytes, 4096)
        let peer = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: listener.port!)!, using: .tcp)
        peer.start(queue: .global())
        try await Task.sleep(for: .milliseconds(100))
        let owned = await listener.statistics(); XCTAssertGreaterThan(owned.active, 0)
        let closed = expectation(description: "owned handshake socket closed on stop")
        peer.receive(minimumIncompleteLength: 1, maximumLength: 1) { _, _, complete, error in if complete || error != nil { closed.fulfill() } }
        listener.stop(); try await running.value
        await fulfillment(of: [closed], timeout: 2); peer.cancel()
        let stopped = await listener.statistics(); XCTAssertEqual(stopped.active, 0); checkOwnKey()
    }
    func testMACAndInterfaceSelection() throws {
        let root = ProcessInfo.processInfo.environment["CANAVERAL_FIXTURE_ROOT"] ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
        let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: root).appendingPathComponent("fixtures/guest-mac.json"))) as! [[String: String]]
        for row in vectors { XCTAssertEqual(GuestInterface.expectedMAC(machineId: row["machineId"]!), row["mac"]!) }
        let machine = Machine(name: "fixture", os: .macOS)
        XCTAssertEqual(GuestInterface.expectedMAC(machineId: machine.id.uuidString.lowercased()), machine.macAddress.lowercased())
        XCTAssertThrowsError(try GuestBootstrap(data: Data(contentsOf: URL(fileURLWithPath: root).appendingPathComponent("fixtures/guest-bootstrap-v1.json"))))
        let mac = GuestInterface.expectedMAC(machineId: "12345678-9abc-4def-8123-123456789abc")
        XCTAssertEqual(mac, "02:12:34:56:78:9a")
        let row = GuestInterfaceAddress(name: "en9", mac: mac, address: "192.168.64.3")
        XCTAssertEqual(try GuestInterface.select([row], mac: mac), row.address)
        XCTAssertThrowsError(try GuestInterface.select([row, row], mac: mac))
        XCTAssertThrowsError(try GuestInterface.select([.init(name: "en0", mac: mac, address: "169.254.1.1")], mac: mac))
    }
}
