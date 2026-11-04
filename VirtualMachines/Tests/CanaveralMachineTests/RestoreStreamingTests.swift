import Foundation
import XCTest
@testable import CanaveralMachines

private final class RestoreURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "updates.cdn-apple.com" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let data = Data(repeating: 42, count: 16 * 1024)
        let expected = data.count + (request.url!.lastPathComponent == "truncated.ipsw" ? 1 : 0)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": String(expected)])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data.prefix(8192))
        client?.urlProtocol(self, didLoad: data.suffix(8192))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class RestoreStreamingTests: XCTestCase, @unchecked Sendable {
    private func downloader() throws -> (AppleRestoreImageDownloader, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralStreamingTests-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return (AppleRestoreImageDownloader(directory: root, configurationFactory: {
            let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [RestoreURLProtocol.self]; return config
        }), root)
    }
    func testAppleDownloadStreamsIntoSelectedStorage() async throws {
        let (downloader, root) = try downloader()
        let file = try await downloader.download(URL(string: "https://updates.cdn-apple.com/success.ipsw")!) { _ in }
        XCTAssertEqual(file.deletingLastPathComponent().path, root.path)
        XCTAssertEqual(try Data(contentsOf: file), Data(repeating: 42, count: 16 * 1024))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).count, 1)
    }
    func testIncompleteDownloadRemovesSelectedStoragePartial() async throws {
        let (downloader, root) = try downloader()
        do { _ = try await downloader.download(URL(string: "https://updates.cdn-apple.com/truncated.ipsw")!) { _ in }; XCTFail("Partial download accepted") }
        catch { XCTAssertTrue(error.localizedDescription.contains("incomplete")) }
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }
    func testCanceledNativeDownloadLeavesNoPartial() async throws {
        let (downloader, root) = try downloader()
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await downloader.download(URL(string: "https://updates.cdn-apple.com/success.ipsw")!) { _ in }
        }
        do { _ = try await task.value; XCTFail("Canceled download succeeded") } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }
}
