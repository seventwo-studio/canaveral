import XCTest
import CanaveralVMCore
import CanaveralMachines
final class CommandTests: XCTestCase, @unchecked Sendable {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralCommandTests-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }; return root
    }
    func testCommandOutputAndCancellation() async throws {
        let dir = try directory()
        let result = try await CommandRunner.run("printf 'fixture-output'", directory: dir, network: false)
        XCTAssertTrue(result.contains("fixture-output")); XCTAssertTrue(result.contains("Exit 0"))
        let signaled = try await CommandRunner.run("kill -TERM $$", directory: dir, network: false)
        XCTAssertTrue(signaled.contains("Terminated by signal 15"), signaled)
        let task = Task { try await CommandRunner.run("sleep 30 & wait", directory: dir, network: false) }
        try await Task.sleep(for: .milliseconds(150)); task.cancel()
        let start = Date()
        do { _ = try await task.value; XCTFail("Canceled command succeeded") } catch {}
        XCTAssertLessThan(Date().timeIntervalSince(start), 4)
    }
}
