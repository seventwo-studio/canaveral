import XCTest
import CanaveralVMCore
import CanaveralMachines
#if os(macOS)
import Virtualization
#endif

private let fixturePNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=="
actor FixtureGuest: GuestDesktopDevice {
    var actions = 0
    var fail = false
    func capture() async throws -> DesktopFrame { .init(width: 1, height: 1, pngBase64: fixturePNG) }
    func perform(_ action: DesktopAction) async throws { actions += 1; if fail { throw CanaveralError.interrupted } }
    func failNext() { fail = true }
}
final class MachinesAndDesktopTests: XCTestCase, @unchecked Sendable {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralMachineTests-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }; return root
    }
    private func request(_ path: String, body: Data = Data(), token: String = String(repeating: "t", count: 43)) -> HTTPRequest {
        .init(method: body.isEmpty ? "GET" : "POST", target: path, headers: ["authorization": "Bearer " + token], body: body)
    }
    func testMachineStorageSparseDiskStableIdentityAndBounds() throws {
        let root = try directory(), image = root.appendingPathComponent("linux.iso")
        try Data(repeating: 0, count: 512).write(to: image)
        let store = MachineStore(root: root.appendingPathComponent("machines"))
        let m = Machine(name: "Linux work", os: .linux, cpuCount: 2, memoryGiB: 4, diskGiB: 32, installerPath: image.path)
        let folder = try store.prepare(m)
        XCTAssertEqual(try store.list(), [m]); XCTAssertEqual(try MachineStore.load(directory: folder).macAddress, m.macAddress)
        let bytes = try FileManager.default.attributesOfItem(atPath: folder.appendingPathComponent("disk.img").path)[.size] as! NSNumber
        XCTAssertEqual(bytes.uint64Value, 32 * 1073741824)
        XCTAssertThrowsError(try store.prepare(m))
        var invalid = m; invalid.cpuCount = 0; XCTAssertThrowsError(try invalid.validate())
        invalid = m; invalid.installerPath = "/test.ipsw"; XCTAssertThrowsError(try invalid.validate())
    }
    func testFrameAndInputValidation() throws {
        try DesktopFrame(width: 1, height: 1, pngBase64: fixturePNG).validate()
        XCTAssertThrowsError(try DesktopFrame(width: 3000, height: 1, pngBase64: fixturePNG).validate())
        XCTAssertThrowsError(try DesktopFrame(width: 1, height: 1, pngBase64: "not-png").validate())
        XCTAssertThrowsError(try DesktopAction(frameID: UUID(), kind: .click, x: -.infinity, y: 0).validate())
        XCTAssertThrowsError(try DesktopAction(frameID: UUID(), kind: .scroll, delta: 21).validate())
    }
    func testGuestAuthenticationFreshFramesAndDurableReceipts() async throws {
        let guest = FixtureGuest(), root = try directory()
        let bridge = try DesktopBridge(token: String(repeating: "t", count: 43), device: guest, journalURL: root.appendingPathComponent("inputs.json"))
        let rejected = await bridge.handle(request("/v1/desktop", token: "wrong")); XCTAssertEqual(rejected.status, 401)
        let screenshot = await bridge.handle(request("/v1/desktop"))
        let frame = try JSONDecoder().decode(DesktopFrame.self, from: screenshot.body)
        let action = DesktopAction(frameID: frame.id, kind: .click, x: 0.5, y: 0.5)
        let body = try JSONEncoder().encode(action)
        let first = await bridge.handle(request("/v1/desktop/action", body: body)); XCTAssertEqual(first.status, 200)
        let duplicate = await bridge.handle(request("/v1/desktop/action", body: body)); XCTAssertEqual(duplicate.status, 200)
        let stale = await bridge.handle(request("/v1/desktop/action", body: try JSONEncoder().encode(DesktopAction(frameID: frame.id, kind: .click, x: 0.5, y: 0.5))))
        XCTAssertEqual(stale.status, 409)
        let restarted = try DesktopBridge(token: String(repeating: "t", count: 43), device: guest, journalURL: root.appendingPathComponent("inputs.json"))
        let replay = await restarted.handle(request("/v1/desktop/action", body: body)); XCTAssertEqual(replay.status, 200)
        let count = await guest.actions; XCTAssertEqual(count, 1)
    }
    func testUncertainGuestInputStopsAndNeverReplays() async throws {
        let guest = FixtureGuest(), root = try directory()
        let bridge = try DesktopBridge(token: String(repeating: "t", count: 43), device: guest, journalURL: root.appendingPathComponent("inputs.json"))
        let screenshot = await bridge.handle(request("/v1/desktop"))
        let frame = try JSONDecoder().decode(DesktopFrame.self, from: screenshot.body)
        await guest.failNext()
        let body = try JSONEncoder().encode(DesktopAction(frameID: frame.id, kind: .key, key: "return"))
        let failed = await bridge.handle(request("/v1/desktop/action", body: body)); XCTAssertEqual(failed.status, 409)
        let restarted = try DesktopBridge(token: String(repeating: "t", count: 43), device: guest, journalURL: root.appendingPathComponent("inputs.json"))
        let replay = await restarted.handle(request("/v1/desktop/action", body: body)); XCTAssertEqual(replay.status, 409)
        let count = await guest.actions; XCTAssertEqual(count, 1)
    }

    func testTakeoverPersistsBlocksAIAndReturnInvalidatesHumanFrames() async throws {
        let root = try directory(), guest = FixtureGuest(), journal = root.appendingPathComponent("inputs.json")
        let bridge = try DesktopBridge(token: String(repeating: "t", count: 43), device: guest, journalURL: journal)
        let takeover = try JSONEncoder().encode(DesktopControlRequest(targetID: UUID(), userControl: true))
        let rejected = await bridge.handle(request("/v1/desktop/control", body: takeover, token: "revoked")); XCTAssertEqual(rejected.status, 401)
        let acknowledged = await bridge.handle(request("/v1/desktop/control", body: takeover)); XCTAssertEqual(acknowledged.status, 200)
        let restarted = try DesktopBridge(token: String(repeating: "t", count: 43), device: guest, journalURL: journal)
        let response = await restarted.handle(request("/v1/desktop/session"))
        let session = try JSONDecoder().decode(DesktopSession.self, from: response.body); XCTAssertTrue(session.userControl)
        let ai = DesktopAction(frameID: session.frame.id, kind: .key, key: "return")
        let blocked = await restarted.handle(request("/v1/desktop/action", body: try JSONEncoder().encode(ai))); XCTAssertEqual(blocked.status, 409)
        var human = ai; human.human = true
        let posted = await restarted.handle(request("/v1/desktop/action", body: try JSONEncoder().encode(human))); XCTAssertEqual(posted.status, 200)
        let count = await guest.actions; XCTAssertEqual(count, 1)
        let humanScreenshot = await restarted.handle(request("/v1/desktop"))
        let humanFrame = try JSONDecoder().decode(DesktopFrame.self, from: humanScreenshot.body)
        let returned = await restarted.handle(request("/v1/desktop/control", body: try JSONEncoder().encode(DesktopControlRequest(targetID: UUID(), userControl: false)))); XCTAssertEqual(returned.status, 200)
        let staleAI = await restarted.handle(request("/v1/desktop/action", body: try JSONEncoder().encode(DesktopAction(frameID: humanFrame.id, kind: .key, key: "return")))); XCTAssertEqual(staleAI.status, 409)
        let after = try DesktopBridge(token: String(repeating: "t", count: 43), device: guest, journalURL: journal)
        let afterResponse = await after.handle(request("/v1/desktop/session"))
        XCTAssertFalse(try JSONDecoder().decode(DesktopSession.self, from: afterResponse.body).userControl)
    }
    func testWatchingDoesNotInvalidateAIFrame() async throws {
        let bridge = try DesktopBridge(token: String(repeating: "t", count: 43), device: FixtureGuest(), journalURL: directory().appendingPathComponent("inputs.json"))
        let first = await bridge.handle(request("/v1/desktop"))
        let frame = try JSONDecoder().decode(DesktopFrame.self, from: first.body)
        for _ in 0..<3 { let response = await bridge.handle(request("/v1/desktop/session")); XCTAssertEqual(response.status, 200) }
        let posted = await bridge.handle(request("/v1/desktop/action", body: try JSONEncoder().encode(DesktopAction(frameID: frame.id, kind: .click, x: 0.5, y: 0.5))))
        XCTAssertEqual(posted.status, 200)
    }


}
