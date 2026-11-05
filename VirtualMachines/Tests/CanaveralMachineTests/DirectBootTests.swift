import XCTest
import CryptoKit
import Darwin
@testable import CanaveralMachines

final class DirectBootTests: XCTestCase {
    private func fixture() throws -> (Machine, DirectBoot) {
        let member = UUID(), lease = UUID(), attempt = UUID()
        var m = Machine(name: "direct", os: .linux, memoryGiB: 1, mode: .server)
        m.id = member; m.executionLeaseID = lease
        let artifact: [String: Any] = ["path": "/operator/Image", "size": 1, "sha256": String(repeating: "a", count: 64)]
        let json: [String: Any] = ["version": 1, "revision": 1, "kernel": artifact, "initrd": artifact, "rootfs": artifact, "launchMedium": artifact, "launchFilesystemUUID": UUID().uuidString, "bundleDigest": String(repeating: "b", count: 64), "commandLine": "root=/dev/vda rootfstype=erofs ro", "leaseID": lease.uuidString, "memberID": member.uuidString, "bootSessionID": UUID().uuidString, "bootAttempt": attempt.uuidString, "workspaceBytes": 16777216]
        return (m, try JSONDecoder().decode(DirectBoot.self, from: JSONSerialization.data(withJSONObject: json)))
    }
    func testShapeAndNonce() throws {
        let (m, boot) = try fixture()
        XCTAssertNoThrow(try boot.validateShape(machine: m))
        XCTAssertEqual(boot.serial, String(boot.bootAttempt.uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(20)))
        XCTAssertTrue(boot.effectiveCommandLine.hasSuffix("canaveral.launch=" + boot.bootAttempt.uuidString.lowercased()))
    }
    func testBoundsAndBindings() throws {
        let (m, good) = try fixture()
        var roomy = m; roomy.memoryGiB = 2
        var b = good; b.workspaceBytes = 1073741824
        XCTAssertNoThrow(try b.validateShape(machine: roomy))
        XCTAssertThrowsError(try b.validateShape(machine: m))
        b.workspaceBytes += 1; XCTAssertThrowsError(try b.validateShape(machine: roomy))
        b.workspaceBytes = 16777215; XCTAssertThrowsError(try b.validateShape(machine: roomy))
        b = good; b.memberID = UUID(); XCTAssertThrowsError(try b.validateShape(machine: m))
        b = good; b.leaseID = UUID(); XCTAssertThrowsError(try b.validateShape(machine: m))
        b = good; b.initrd = nil; XCTAssertThrowsError(try b.validateShape(machine: m))
        b = good; b.commandLine += " canaveral.launch=x"; XCTAssertThrowsError(try b.validateShape(machine: m))
        b = good; b.commandLine += " rw"; XCTAssertThrowsError(try b.validateShape(machine: m))
        b = good; b.revision = 0; XCTAssertThrowsError(try b.validateShape(machine: m))
    }
    func testLegacyMachineDecoding() throws {
        let json = #"{"id":"11111111-1111-4111-8111-111111111111","name":"old","os":"linux","cpuCount":2,"memoryGiB":4,"diskGiB":32,"installation":"ready","macAddress":"02:11:11:11:11:11"}"#
        let decoded = try JSONDecoder().decode(Machine.self, from: Data(json.utf8))
        XCTAssertNil(decoded.directBoot)
        XCTAssertEqual(decoded.mode, .desktop)
    }
    func testCommandLineBoundAndParser() throws {
        let (m, good) = try fixture()
        var b = good
        b.commandLine += String(repeating: " ", count: 1993 - b.commandLine.utf8.count)
        XCTAssertNoThrow(try b.validateShape(machine: m))
        XCTAssertEqual(b.effectiveCommandLine.utf8.count + 1, 2048)
        b.commandLine += " "; XCTAssertThrowsError(try b.validateShape(machine: m))
        for suffix in [" --", " \"rw\"", " 'rw'"] {
            b = good; b.commandLine += suffix
            XCTAssertThrowsError(try b.validateShape(machine: m))
        }
    }
    private func temporaryDirectory(base: URL = FileManager.default.temporaryDirectory) throws -> URL {
        let raw = base.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let resolved = try XCTUnwrap(realpath(raw.path, nil)); defer { free(resolved) }
        return URL(fileURLWithPath: String(cString: resolved))
    }
    func testRealPinnedFileVerification() throws {
        try verifyRealFile(base: URL(fileURLWithPath: "/private/tmp"))
        try verifyRealFile(base: FileManager.default.temporaryDirectory)
    }
    private func verifyRealFile(base: URL) throws {
        let dir = try temporaryDirectory(base: base), path = dir.appendingPathComponent("Image").path
        defer { _ = chflags(path, 0); try? FileManager.default.removeItem(at: dir) }
        let data = Data("artifact".utf8)
        try data.write(to: URL(fileURLWithPath: path))
        var pin = PinnedBootFile(path: path, sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), size: UInt64(data.count))
        XCTAssertEqual(chmod(path, 0o400), 0)
        XCTAssertThrowsError(try pin.verify()) // no immutable flag
        XCTAssertEqual(chflags(path, UInt32(UF_IMMUTABLE)), 0)
        XCTAssertNoThrow(try pin.verify()) // actual realpath spelling, without URL standardization
        XCTAssertEqual(chmod(dir.path, 0o777), 0)
        XCTAssertThrowsError(try pin.verify())
        XCTAssertEqual(chmod(dir.path, 0o700), 0)
        if path.hasPrefix("/private/tmp/") {
            var alias = pin; alias.path = String(path.dropFirst("/private".count))
            XCTAssertThrowsError(try alias.verify()) // /tmp is a symlink
        }
        var bad = pin; bad.sha256 = String(repeating: "0", count: 64); XCTAssertThrowsError(try bad.verify())
        bad = pin; bad.size += 1; XCTAssertThrowsError(try bad.verify())
        for spelling in [dir.path + "//Image", dir.path + "/./Image", dir.path + "/../Image", path + "/"] {
            bad = pin; bad.path = spelling; XCTAssertThrowsError(try bad.verify())
        }
        let link = dir.appendingPathComponent("link").path
        XCTAssertEqual(symlink(path, link), 0)
        bad = pin; bad.path = link; XCTAssertThrowsError(try bad.verify())
        let ancestor = dir.appendingPathComponent("alias").path
        XCTAssertEqual(symlink(dir.path, ancestor), 0)
        bad.path = ancestor + "/Image"; XCTAssertThrowsError(try bad.verify())
        XCTAssertEqual(chflags(path, 0), 0)
        XCTAssertEqual(chmod(path, 0o600), 0)
        try Data("artifacx".utf8).write(to: URL(fileURLWithPath: path))
        XCTAssertEqual(chmod(path, 0o400), 0)
        XCTAssertEqual(chflags(path, UInt32(UF_IMMUTABLE)), 0)
        XCTAssertThrowsError(try pin.verify()) // changed contents, same byte size
        XCTAssertEqual(chflags(path, 0), 0)
        XCTAssertEqual(chmod(path, 0o600), 0)
        try data.write(to: URL(fileURLWithPath: path))
        XCTAssertEqual(chmod(path, 0o500), 0)
        XCTAssertEqual(chflags(path, UInt32(UF_IMMUTABLE)), 0)
        XCTAssertThrowsError(try pin.verify())
        XCTAssertEqual(chflags(path, 0), 0); XCTAssertEqual(chmod(path, 0o400), 0)
        let hard = dir.appendingPathComponent("hard").path
        XCTAssertEqual(linkat(AT_FDCWD, path, AT_FDCWD, hard, 0), 0)
        XCTAssertEqual(chflags(path, UInt32(UF_IMMUTABLE)), 0)
        XCTAssertThrowsError(try pin.verify())
        pin.path = "/tmp/" + UUID().uuidString; XCTAssertThrowsError(try pin.verify())
    }
    func testAttemptReceiptsAndFailures() throws {
        let dir = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: dir) }
        let attempt = UUID()
        XCTAssertNoThrow(try DirectBootAttempt.consume(directory: dir, attempt: attempt))
        XCTAssertThrowsError(try DirectBootAttempt.consume(directory: dir, attempt: attempt))
        for failedStep in 1...3 {
            let attempt = UUID(); var step = 0
            XCTAssertThrowsError(try DirectBootAttempt.consume(directory: dir, attempt: attempt, sync: { _, _ in
                step += 1; return step == failedStep ? -1 : 0
            }))
            XCTAssertEqual(step, failedStep)
            XCTAssertThrowsError(try DirectBootAttempt.consume(directory: dir, attempt: attempt))
        }
        XCTAssertThrowsError(try DirectBootAttempt.consume(directory: dir.appendingPathComponent("missing"), attempt: UUID()))
    }
    func testPreparationChecksBeforeStateCreationAndEFIStillNeedsImage() throws {
        let (m, boot) = try fixture(); var direct = m; direct.directBoot = boot
        direct.installerPath = "ignored-without-image-extension"
        XCTAssertNoThrow(try direct.validate())
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let store = MachineStore(root: root)
        XCTAssertThrowsError(try store.prepare(direct)) // unavailable pinned artifacts
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.directory(direct.id).path))
        XCTAssertThrowsError(try store.prepare(m)) // EFI still requires an image
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.directory(m.id).path))
    }
    func testStaleInventoryStoreRoundTrip() throws {
        let (m, boot) = try fixture(); var stale = m; stale.directBoot = boot
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appendingPathComponent(stale.id.uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        XCTAssertNoThrow(try MachineStore.save(stale, directory: directory))
        XCTAssertEqual(try MachineStore.load(directory: directory), stale)
        XCTAssertEqual(try MachineStore(root: root).list(), [stale])
        XCTAssertThrowsError(try boot.validate(machine: stale))
    }
}
