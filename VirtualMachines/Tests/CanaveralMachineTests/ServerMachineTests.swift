import XCTest
import CanaveralMachines

final class ServerMachineTests: XCTestCase {
    func testLegacyMachinesRemainDesktops() throws {
        let machine = Machine(name: "Existing", os: .linux)
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(machine)) as! [String: Any]
        json.removeValue(forKey: "mode")
        let decoded = try JSONDecoder().decode(Machine.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(decoded, machine)
    }
    func testDesktopCloudDiskImportIsIndependentAndReady() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralDesktopImport-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("desktop.raw")
        let contents = Data(repeating: 65, count: 512)
        try contents.write(to: source)
        let machine = Machine(name: "Desktop template", os: .linux, installerPath: source.path)
        let store = MachineStore(root: root.appendingPathComponent("machines"))
        let directory = try store.prepare(machine)
        let saved = try MachineStore.load(directory: directory)
        XCTAssertEqual(saved.mode, .desktop)
        XCTAssertEqual(saved.installation, .ready)
        XCTAssertNil(saved.installerPath)
        let disk = try FileHandle(forReadingFrom: directory.appendingPathComponent("disk.img"))
        defer { try? disk.close() }
        XCTAssertEqual(try disk.read(upToCount: 512), contents)
        XCTAssertEqual(try Data(contentsOf: source), contents)
    }
    func testServerDefaultsAndResourceBoundaries() throws {
        var server = Machine(name: "Small server", os: .linux, mode: .server)
        XCTAssertEqual(server.cpuCount, 2); XCTAssertEqual(server.memoryGiB, 1); XCTAssertEqual(server.diskGiB, 8)
        server.cpuCount = 1; server.diskGiB = 4; XCTAssertNoThrow(try server.validate())
        server.memoryGiB = 0; XCTAssertThrowsError(try server.validate())
        XCTAssertThrowsError(try Machine(name: "Mac server", os: .macOS, mode: .server).validate())
        XCTAssertThrowsError(try Machine(name: "Desktop", os: .linux, memoryGiB: 1).validate())
    }
    func testServerDiskImportPreservesSourceAndMarksReady() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralServerTests-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("template.raw"), contents = Data(repeating: 42, count: 512)
        try contents.write(to: source)
        let machine = Machine(name: "Imported", os: .linux, diskGiB: 4, installerPath: source.path, mode: .server)
        let store = MachineStore(root: root.appendingPathComponent("machines")), folder = try store.prepare(machine)
        let saved = try MachineStore.load(directory: folder)
        XCTAssertEqual(saved.mode, .server); XCTAssertEqual(saved.installation, .ready); XCTAssertNil(saved.installerPath)
        XCTAssertEqual(try Data(contentsOf: source), contents)
        let disk = try FileHandle(forReadingFrom: folder.appendingPathComponent("disk.img")); defer { try? disk.close() }
        XCTAssertEqual(try disk.read(upToCount: 512), contents)
        XCTAssertEqual(try disk.seekToEnd(), 4 * 1073741824)
    }
    func testTooSmallDestinationRejectsImportWithoutTruncatingSource() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralServerBounds-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("larger.raw")
        try Data(repeating: 42, count: 512).write(to: source)
        let file = try FileHandle(forWritingTo: source)
        try file.truncate(atOffset: 4 * 1073741824 + 512); try file.close()
        let store = MachineStore(root: root.appendingPathComponent("machines"))
        XCTAssertThrowsError(try store.prepare(Machine(name: "Too small", os: .linux, diskGiB: 4, installerPath: source.path, mode: .server)))
        XCTAssertTrue(try store.list().isEmpty)
        let input = try FileHandle(forReadingFrom: source); defer { try? input.close() }
        XCTAssertEqual(try input.seekToEnd(), 4 * 1073741824 + 512)
        try input.seek(toOffset: 0); XCTAssertEqual(try input.read(upToCount: 512), Data(repeating: 42, count: 512))
    }
}
