import XCTest
import Foundation
import CanaveralVMCore
@testable import CanaveralMachines
import Virtualization
import CryptoKit

private struct BootstrapDevice: GuestDesktopDevice {
    func capture() async throws -> DesktopFrame { throw CanaveralError.interrupted }
    func perform(_ action: DesktopAction) async throws { XCTFail("Unexpected native input") }
}
@MainActor final class GuestBootstrapTests: XCTestCase {
    func payload() throws -> Data {
        let root = ProcessInfo.processInfo.environment["CANAVERAL_FIXTURE_ROOT"] ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
        return try Data(contentsOf: URL(fileURLWithPath: root).appendingPathComponent("fixtures/guest-bootstrap-v2.json"))
    }
    func testStrictPayloadAndSelectorNoFallback() throws {
        let bytes = try payload(), valid = GuestBootstrapMount(path: "/fixture", filesystem: "cd9660", label: "CANAVERAL_BOOT", readOnly: true)
        XCTAssertNoThrow(try GuestBootstrapSelector.select(mounts: { [valid] }, read: { _ in bytes }))
        for mounts in [[], [valid, valid], [.init(path: "/fixture", filesystem: "cd9660", label: "OTHER", readOnly: true)], [.init(path: "/fixture", filesystem: "cd9660", label: "CANAVERAL_BOOT", readOnly: false)]] {
            var started = false
            XCTAssertThrowsError(try AssignedGuestStartup.start(isVirtualGuest: true, mounts: { mounts }, read: { _ in bytes }) { _ in started = true })
            XCTAssertFalse(started)
        }
        XCTAssertThrowsError(try AssignedGuestStartup.start(isVirtualGuest: false, mounts: { [valid] }, read: { _ in bytes }) { _ in XCTFail() })
        let duplicate = String(decoding: bytes, as: UTF8.self).replacingOccurrences(of: "\"version\": 2", with: "\"version\": 2, \"version\": 2")
        XCTAssertThrowsError(try GuestBootstrap(data: Data(duplicate.utf8)))
        var object = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        for (key, value) in [("extra", 1 as Any), ("version", true), ("credential", "not-canonical")] {
            var bad = object; bad[key] = value
            XCTAssertThrowsError(try GuestBootstrap(data: JSONSerialization.data(withJSONObject: bad)))
        }
        object["assignment"] = ["version": 1]
        XCTAssertThrowsError(try GuestBootstrap(data: JSONSerialization.data(withJSONObject: object)))
        XCTAssertThrowsError(try GuestBootstrap(data: Data(repeating: 32, count: 4097)))
    }
    func testReadRejectsExtraFilesSymlinksAndMountSubstitution() throws {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("BootstrapRead-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let path = root.resolvingSymlinksInPath(), file = path.appendingPathComponent("assignment.json")
        try payload().write(to: file)
        let mount = GuestBootstrapMount(path: path.path, filesystem: "cd9660", label: "CANAVERAL_BOOT", readOnly: true)
        XCTAssertNoThrow(try GuestBootstrapSelector.read(mount))
        let extra = path.appendingPathComponent("extra"); try Data().write(to: extra)
        XCTAssertThrowsError(try GuestBootstrapSelector.read(mount)); try FileManager.default.removeItem(at: extra)
        try FileManager.default.removeItem(at: file); try FileManager.default.createSymbolicLink(at: file, withDestinationURL: extra)
        XCTAssertThrowsError(try GuestBootstrapSelector.read(mount))
    }
    func testRealStartupBridgeAndProviderBytes() async throws {
        let exchange = ProcessInfo.processInfo.environment["CANAVERAL_BOOTSTRAP_EXCHANGE"]
        let bytes = try exchange.map { try Data(contentsOf: URL(fileURLWithPath: $0).appendingPathComponent("guest-bootstrap/content/assignment.json")) } ?? payload()
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("BootstrapBridge-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let mount = GuestBootstrapMount(path: "/fixture", filesystem: "cd9660", label: "CANAVERAL_BOOT", readOnly: true)
        let bootstrap = try AssignedGuestStartup.start(isVirtualGuest: true, mounts: { [mount] }, read: { _ in bytes }) { $0 }
        if let exchange {
            let directory = URL(fileURLWithPath: exchange).appendingPathComponent(bootstrap.assignment.machineId.uppercased())
            let pin = try LaunchMediaPin.load(directory: directory)
            try pin.verify()
            XCTAssertEqual(pin.machineId, bootstrap.assignment.machineId)
            XCTAssertEqual(pin.leaseId, bootstrap.assignment.leaseId)
            XCTAssertEqual(pin.fingerprint, bootstrap.assignment.fingerprint)
            XCTAssertEqual(pin.launchId, bootstrap.assignment.launchId)
        }
        try GuestAssignedLaunchAttempt.consume(state: root.appendingPathComponent(bootstrap.assignment.launchId))
        XCTAssertThrowsError(try GuestAssignedLaunchAttempt.consume(state: root.appendingPathComponent(bootstrap.assignment.launchId)))
        let bridge = try DesktopBridge(token: bootstrap.credential, device: BootstrapDevice(), journalURL: root.appendingPathComponent(bootstrap.assignment.launchId + "/inputs.json"), assignment: bootstrap.assignment)
        let nonce = Data(repeating: 7, count: 32).base64URL
        let response = await bridge.handle(.init(method: "GET", target: "/v1/identity", headers: ["authorization": try bootstrap.assignment.authorization(credential: bootstrap.credential, nonce: nonce)], body: Data()))
        XCTAssertEqual(response.status, 200)
        if let exchange { try response.body.write(to: URL(fileURLWithPath: exchange).appendingPathComponent("identity.json")) }
        let legacy = await bridge.handle(.init(method: "GET", target: "/v1/identity", headers: ["authorization": "Bearer " + bootstrap.credential], body: Data()))
        XCTAssertEqual(legacy.status, 401)
    }
    func testTypedNativeAttachmentRevalidatesAfterAttachment() throws {
        let rawRoot = FileManager.default.temporaryDirectory.appendingPathComponent("LaunchPin-\(UUID())")
        try FileManager.default.createDirectory(at: rawRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let canonical = try XCTUnwrap(realpath(rawRoot.path, nil)); defer { free(canonical) }
        let root = URL(fileURLWithPath: String(cString: canonical))
        defer { try? FileManager.default.removeItem(at: root) }
        let boot = root.appendingPathComponent("guest-bootstrap"), bytes = Data(repeating: 0, count: 32768)
        try FileManager.default.createDirectory(at: boot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let path = boot.appendingPathComponent("launch.iso"); try bytes.write(to: path); try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: path.path)
        var machine = Machine(name: "fixture", os: .macOS, cpuCount: 2, memoryGiB: 4, diskGiB: 8)
        machine.executionLeaseID = UUID()
        let metadata = try FileManager.default.attributesOfItem(atPath: path.path), launch = UUID().uuidString.lowercased()
        let raw: [String: Any] = ["path": path.path, "size": bytes.count, "sha256": SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), "uid": getuid(), "mode": 256, "nlink": 1, "dev": String((metadata[.systemNumber] as! NSNumber).uint64Value), "ino": String((metadata[.systemFileNumber] as! NSNumber).uint64Value), "version": 2, "machineId": machine.id.uuidString.lowercased(), "leaseId": machine.executionLeaseID!.uuidString.lowercased(), "fingerprint": String(repeating: "a", count: 64), "launchId": launch]
        let pin = try JSONDecoder().decode(LaunchMediaPin.self, from: JSONSerialization.data(withJSONObject: raw))
        let directory = root.appendingPathComponent(machine.id.uuidString)
        let validated = try ValidatedLaunchMedia(pin: pin, machine: machine, directory: directory, launch: launch)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        XCTAssertNoThrow(try validated.consume(directory: directory))
        XCTAssertThrowsError(try validated.consume(directory: directory))
        XCTAssertThrowsError(try ValidatedLaunchMedia(pin: pin, machine: machine, directory: directory, launch: UUID().uuidString.lowercased()))
        let device = try MachineConfiguration.launchMediaDevice(validated)
        XCTAssertTrue((device.attachment as! VZDiskImageStorageDeviceAttachment).isReadOnly)
        XCTAssertThrowsError(try MachineConfiguration.launchMediaDevice(validated, afterAttachment: {
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        }))
    }
}
