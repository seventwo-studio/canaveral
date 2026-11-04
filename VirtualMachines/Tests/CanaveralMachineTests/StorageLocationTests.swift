import Foundation
import XCTest
import CanaveralVMCore
@testable import CanaveralMachines
#if os(macOS)
import Darwin
#endif

final class StorageLocationTests: XCTestCase, @unchecked Sendable {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralStorageTests-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }; return root
    }
    func testLocationSurvivesRestartAndAbsentDriveNeverCreatesFallback() throws {
        let root = try directory(), profile = root.appendingPathComponent("bootstrap/location.json")
        let selected = try CanaveralStorage.initialize(root: root.appendingPathComponent("external/Canaveral"))
        try selected.saveBookmark(to: profile)
        let defaultRoot = root.appendingPathComponent("internal/Canaveral")
        let reopened = try CanaveralStorage.resolve(profileURL: profile, defaultRoot: defaultRoot)
        XCTAssertEqual(reopened.root.path, selected.root.path); XCTAssertEqual(reopened.id, selected.id)
        try FileManager.default.removeItem(at: selected.root)
        XCTAssertThrowsError(try CanaveralStorage.resolve(profileURL: profile, defaultRoot: defaultRoot))
        XCTAssertFalse(FileManager.default.fileExists(atPath: defaultRoot.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: selected.root.path))
    }
    func testDifferentStorageIdentityIsRejected() throws {
        let selected = try CanaveralStorage.initialize(root: try directory())
        try Data(UUID().uuidString.utf8).write(to: selected.marker)
        XCTAssertThrowsError(try selected.checkAvailable())
    }
    func testLegacyLayoutIsRetainedUntilAnExplicitMove() throws {
        let root = try directory(), profile = root.appendingPathComponent("bootstrap/location.json")
        let legacy = root.appendingPathComponent("Canaveral Machines"), data = root.appendingPathComponent("Canaveral")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: false)
        try Data("existing machine".utf8).write(to: legacy.appendingPathComponent("untouched"))
        let selected = try CanaveralStorage.resolve(profileURL: profile, defaultRoot: data, legacyMachinesRoot: legacy)
        XCTAssertEqual(selected.machines, legacy)
        let reopened = try CanaveralStorage.resolve(profileURL: profile, defaultRoot: data)
        XCTAssertEqual(reopened.machines.path, legacy.path)
        XCTAssertEqual(try String(contentsOf: legacy.appendingPathComponent("untouched"), encoding: .utf8), "existing machine")
    }



    #if os(macOS)
    func testMigrationCopiesLegacyMachinesRebasesMediaAndPreservesSource() throws {
        let root = try directory(), legacy = root.appendingPathComponent("old-machines")
        let selected = try CanaveralStorage.initialize(root: root.appendingPathComponent("old-data"), legacyMachinesRoot: legacy)
        let agent = selected.agent; try FileManager.default.createDirectory(at: agent, withIntermediateDirectories: true)
        try Data("agent projects and memory".utf8).write(to: agent.appendingPathComponent("disk.img"))
        let sourceImage = selected.restores.appendingPathComponent("mac.ipsw")
        try FileManager.default.createDirectory(at: selected.restores, withIntermediateDirectories: true)
        try Data("restore bytes".utf8).write(to: sourceImage)
        let machine = Machine(name: "Mac desktop", os: .macOS, installerPath: sourceImage.path)
        let folder = legacy.appendingPathComponent(machine.id.uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try MachineStore.save(machine, directory: folder)
        try Data("hardware identity".utf8).write(to: folder.appendingPathComponent("hardware.bin"))
        let sparse = folder.appendingPathComponent("disk.img")
        FileManager.default.createFile(atPath: sparse.path, contents: Data([1, 2, 3]))
        let file = try FileHandle(forWritingTo: sparse); try file.truncate(atOffset: 32 * 1048576); try file.close()
        let destination = root.appendingPathComponent("new-drive"); try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
        let moved = try StorageMigration.copy(from: selected, to: destination)
        XCTAssertNil(moved.legacyMachinesRoot); try moved.checkAvailable()
        let migrated = try MachineStore(root: moved.machines).list()
        XCTAssertEqual(migrated.first?.id, machine.id)
        XCTAssertEqual(migrated.first?.installerPath, moved.restores.appendingPathComponent("mac.ipsw").path)
        XCTAssertEqual(try Data(contentsOf: moved.agent.appendingPathComponent("disk.img")), Data("agent projects and memory".utf8))
        XCTAssertEqual(try Data(contentsOf: moved.machines.appendingPathComponent("\(machine.id)/hardware.bin")), Data("hardware identity".utf8))
        let size = try FileManager.default.attributesOfItem(atPath: moved.machines.appendingPathComponent("\(machine.id)/disk.img").path)[.size] as? NSNumber
        XCTAssertEqual(size?.intValue, 32 * 1048576)
        XCTAssertEqual(try MachineStore.load(directory: folder).installerPath, sourceImage.path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: agent.appendingPathComponent("disk.img").path))
    }
    func testMigrationRejectsRunningDiskAndNeverOverwritesDestination() throws {
        let root = try directory(), selected = try CanaveralStorage.initialize(root: root.appendingPathComponent("source"))
        let destination = root.appendingPathComponent("destination"); try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
        do {
            let lease = try StorageLease(root: selected.root)
            XCTAssertThrowsError(try StorageMigration.copy(from: selected, to: destination))
            withExtendedLifetime(lease) {}
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathComponent("Canaveral").path))
        // A runtime lock catches legacy helpers that do not hold the root lock.
        try FileManager.default.createDirectory(at: selected.agent, withIntermediateDirectories: false)
        let fd = open(selected.agent.appendingPathComponent("runtime.lock").path, O_CREAT | O_RDWR, 0o600)
        XCTAssertGreaterThanOrEqual(fd, 0); XCTAssertEqual(flock(fd, LOCK_EX | LOCK_NB), 0)
        defer { close(fd) }
        XCTAssertThrowsError(try StorageMigration.copy(from: selected, to: destination)) { error in
            XCTAssertTrue(error.localizedDescription.contains("still owns its disk"))
        }
        let foreign = destination.appendingPathComponent("Canaveral")
        try FileManager.default.createDirectory(at: foreign, withIntermediateDirectories: false)
        try Data("foreign data".utf8).write(to: foreign.appendingPathComponent("keep"))
        XCTAssertThrowsError(try StorageMigration.copy(from: selected, to: destination))
        XCTAssertEqual(try Data(contentsOf: foreign.appendingPathComponent("keep")), Data("foreign data".utf8))
    }
    func testCanceledMigrationKeepsOriginalAndCleansStaging() async throws {
        let root = try directory(), selected = try CanaveralStorage.initialize(root: root.appendingPathComponent("source"))
        try Data("original".utf8).write(to: selected.root.appendingPathComponent("data"))
        let destination = root.appendingPathComponent("destination"); try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try StorageMigration.copy(from: selected, to: destination)
        }
        do { _ = try await task.value; XCTFail("Canceled move succeeded") } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: destination.path).isEmpty)
        XCTAssertEqual(try Data(contentsOf: selected.root.appendingPathComponent("data")), Data("original".utf8))
    }
    #endif
}
