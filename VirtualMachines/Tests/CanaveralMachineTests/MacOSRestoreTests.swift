import Foundation
import XCTest
import CanaveralVMCore
@testable import CanaveralMachines

private actor RestoreFixtureDownload: RestoreImageDownloading {
    let root: URL
    let contents = Data("fixture IPSW bytes".utf8)
    let slowFirst: Bool
    var count = 0
    init(root: URL, slowFirst: Bool = false) { self.root = root; self.slowFirst = slowFirst }
    func download(_ url: URL, progress: @escaping @Sendable (RestoreDownloadProgress) -> Void) async throws -> URL {
        count += 1
        if slowFirst && count == 1 { try await Task.sleep(for: .seconds(30)) }
        let file = root.appendingPathComponent("download-\(UUID()).ipsw")
        try contents.write(to: file)
        progress(.init(received: Int64(contents.count), expected: Int64(contents.count)))
        return file
    }
}
private struct RestoreFixtureValidator: RestoreImageValidating {
    var accepted = true
    func validate(_ url: URL, descriptor: MacOSRestoreDescriptor) async throws {
        if !accepted { throw CanaveralError.invalid("Fixture restore image is unsupported") }
        guard try Data(contentsOf: url) == Data("fixture IPSW bytes".utf8) else { throw CanaveralError.invalid("Fixture restore image is corrupt") }
    }
}
final class MacOSRestoreTests: XCTestCase, @unchecked Sendable {
    let descriptor = MacOSRestoreDescriptor(url: URL(string: "https://updates.cdn-apple.com/restore/test.ipsw")!, version: "26.0.1", build: "fixture-build", minimumCPUs: 2, minimumMemoryGiB: 4)
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralRestoreTests-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }
    func testDownloadReusedAcrossInstancesAndOfflineCacheNeedsNoNetwork() async throws {
        let root = try directory(), downloader = RestoreFixtureDownload(root: try directory())
        let store = MacOSRestoreImageStore(root: root, downloader: downloader, validator: RestoreFixtureValidator())
        let image = try await store.obtain(descriptor)
        XCTAssertEqual(try Data(contentsOf: image), Data("fixture IPSW bytes".utf8))
        let again = try await store.obtain(descriptor); XCTAssertEqual(image, again)
        let calls = await downloader.count; XCTAssertEqual(calls, 1)
        let restarted = MacOSRestoreImageStore(root: root, downloader: downloader, validator: RestoreFixtureValidator())
        let cached = try await restarted.cached(); XCTAssertEqual(cached.count, 1)
        let offline = try await restarted.useCached(try XCTUnwrap(cached.first)); XCTAssertEqual(offline, image)
        let laterCalls = await downloader.count; XCTAssertEqual(laterCalls, 1)
        let machine = Machine(name: "macOS", os: .macOS, installerPath: offline.path)
        XCTAssertNoThrow(try machine.validate())
    }
    func testUnsupportedDownloadedImageIsNotPublishedAndTemporaryIsRemoved() async throws {
        let root = try directory(), temporary = try directory(), downloader = RestoreFixtureDownload(root: temporary)
        let store = MacOSRestoreImageStore(root: root, downloader: downloader, validator: RestoreFixtureValidator(accepted: false))
        do { _ = try await store.obtain(descriptor); XCTFail("Unsupported image cached") } catch {}
        let cached = try await store.cached(); XCTAssertTrue(cached.isEmpty)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: temporary.path).isEmpty)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }
    func testCorruptCachedFileIsNotOfferedAndCanBeDownloadedAgain() async throws {
        let root = try directory(), downloader = RestoreFixtureDownload(root: try directory())
        let store = MacOSRestoreImageStore(root: root, downloader: downloader, validator: RestoreFixtureValidator())
        let original = try await store.obtain(descriptor)
        try Data([1]).write(to: original)
        let cached = try await store.cached(); XCTAssertTrue(cached.isEmpty)
        let restored = try await store.obtain(descriptor)
        XCTAssertEqual(try Data(contentsOf: restored), Data("fixture IPSW bytes".utf8))
        let count = await downloader.count; XCTAssertEqual(count, 2)
    }
    func testCancellationDoesNotPublishPartialImageAndAllowsRetry() async throws {
        let root = try directory(), downloader = RestoreFixtureDownload(root: try directory(), slowFirst: true)
        let store = MacOSRestoreImageStore(root: root, downloader: downloader, validator: RestoreFixtureValidator())
        let descriptor = descriptor
        let task = Task { try await store.obtain(descriptor) }
        for _ in 0..<100 {
            if await downloader.count > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let started = await downloader.count
        if started == 0 {
            task.cancel()
            do { _ = try await task.value; XCTFail("Download did not start") }
            catch { XCTFail("Download did not start: \(error)") }
            return
        }
        task.cancel()
        do { _ = try await task.value; XCTFail("Canceled download succeeded") } catch is CancellationError {} catch { XCTFail("Unexpected cancellation: \(error)") }
        let cached = try await store.cached(); XCTAssertTrue(cached.isEmpty)
        let retry = try await store.obtain(descriptor); XCTAssertTrue(FileManager.default.fileExists(atPath: retry.path))
    }
    func testUntrustedDownloadURLsRejectedBeforeNetwork() async throws {
        let root = try directory(), downloader = RestoreFixtureDownload(root: try directory())
        let store = MacOSRestoreImageStore(root: root, downloader: downloader, validator: RestoreFixtureValidator())
        for url in ["http://updates.cdn-apple.com/test.ipsw", "https://apple.com.evil.invalid/test.ipsw", "https://cdn-apple.com.evil.invalid/test.ipsw", "https://evilapple.com/test.ipsw", "https://user:secret@apple.com/test.ipsw", "https://apple.com:8443/test.ipsw"] {
            let invalid = MacOSRestoreDescriptor(url: URL(string: url)!, version: "26", build: "fixture", minimumCPUs: 2, minimumMemoryGiB: 4)
            do { _ = try await store.obtain(invalid); XCTFail("Untrusted URL accepted") } catch {}
        }
        let count = await downloader.count; XCTAssertEqual(count, 0)
    }
    func testSameSizeCorruptCacheCanBeRepairedByDownloadingAgain() async throws {
        let root = try directory(), downloader = RestoreFixtureDownload(root: try directory())
        let store = MacOSRestoreImageStore(root: root, downloader: downloader, validator: RestoreFixtureValidator())
        let file = try await store.obtain(descriptor)
        let size = try Data(contentsOf: file).count
        try Data(repeating: 0, count: size).write(to: file)
        let repaired = try await store.obtain(descriptor)
        XCTAssertEqual(try Data(contentsOf: repaired), Data("fixture IPSW bytes".utf8))
        let count = await downloader.count; XCTAssertEqual(count, 2)
    }
}
