#if os(macOS)
import Foundation
import Virtualization
import CryptoKit
import CanaveralVMCore

public struct MacOSRestoreDescriptor: Codable, Sendable, Equatable {
    public let url: URL
    public let version: String
    public let build: String
    public let minimumCPUs: Int
    public let minimumMemoryGiB: Int
    public init(url: URL, version: String, build: String, minimumCPUs: Int, minimumMemoryGiB: Int) {
        self.url = url; self.version = version; self.build = build
        self.minimumCPUs = minimumCPUs; self.minimumMemoryGiB = minimumMemoryGiB
    }
}
public struct RestoreDownloadProgress: Sendable {
    public let received: Int64
    public let expected: Int64
    public var fraction: Double? { expected > 0 ? min(1, max(0, Double(received) / Double(expected))) : nil }
    public init(received: Int64, expected: Int64) { self.received = received; self.expected = expected }
}
public struct CachedMacOSRestore: Sendable, Identifiable {
    public var id: String { url.lastPathComponent }
    public let descriptor: MacOSRestoreDescriptor
    public let url: URL
}
@MainActor public enum MacOSRestoreImages {
    public static var supported: Bool {
        #if arch(arm64)
        VZVirtualMachine.isSupported
        #else
        false
        #endif
    }
    public static func latestSupported() async throws -> MacOSRestoreDescriptor {
        guard supported else { throw CanaveralError.unavailable("macOS guests require an Apple silicon Mac with hardware virtualization.") }
        return try await fetchLatestDescriptor()
    }
    // Keep the framework object on the nonisolated executor; only its Sendable
    // value descriptor crosses back to callers on the main actor.
    private nonisolated static func fetchLatestDescriptor() async throws -> MacOSRestoreDescriptor {
        #if arch(arm64)
        let image = try await VZMacOSRestoreImage.latestSupported
        guard let requirements = image.mostFeaturefulSupportedConfiguration else { throw CanaveralError.unavailable("Apple has no compatible macOS restore image for this Mac.") }
        let version = image.operatingSystemVersion
        return .init(url: image.url, version: "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)", build: image.buildVersion,
                     minimumCPUs: requirements.minimumSupportedCPUCount,
                     minimumMemoryGiB: Int((requirements.minimumSupportedMemorySize + 1073741823) / 1073741824))
        #else
        throw CanaveralError.unavailable("macOS guests require Apple silicon.")
        #endif
    }
}
public protocol RestoreImageDownloading: Sendable {
    /// Returns a caller-owned temporary file. Never buffers the full IPSW in memory.
    func download(_ url: URL, progress: @escaping @Sendable (RestoreDownloadProgress) -> Void) async throws -> URL
}
public protocol RestoreImageValidating: Sendable {
    func validate(_ url: URL, descriptor: MacOSRestoreDescriptor) async throws
}
struct NativeRestoreImageValidator: RestoreImageValidating {
    func validate(_ url: URL, descriptor: MacOSRestoreDescriptor) async throws {
        #if arch(arm64)
        let image = try await VZMacOSRestoreImage.image(from: url)
        guard image.mostFeaturefulSupportedConfiguration != nil, image.buildVersion == descriptor.build else {
            throw CanaveralError.invalid("The downloaded restore image does not match Apple's compatible macOS build.")
        }
        #else
        throw CanaveralError.unavailable("macOS guests require Apple silicon.")
        #endif
    }
}
/// URLSession streams directly into selected storage, including multi-gigabyte IPSWs.
private final class RestoreStreamDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let file: FileHandle
    private let url: URL
    private let progress: @Sendable (RestoreDownloadProgress) -> Void
    private let lock = NSLock()
    private var continuation: CheckedContinuation<URL, any Error>?
    private var task: URLSessionDataTask?
    private var finished = false
    private var canceled = false
    private var received: Int64 = 0
    private var expected: Int64 = -1
    private var lastReport: TimeInterval = 0
    init(url: URL, progress: @escaping @Sendable (RestoreDownloadProgress) -> Void) throws {
        self.url = url; self.progress = progress
        guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CanaveralError.unavailable("Could not create the restore download on Canaveral storage.") }
        file = try FileHandle(forWritingTo: url)
    }
    deinit { try? file.close() }
    func run(_ session: URLSession, request: URLRequest) async throws -> URL {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let shouldCancel = lock.withLock {
                    self.continuation = continuation
                    if canceled { return true }
                    let task = session.dataTask(with: request); self.task = task; task.resume(); return false
                }
                if shouldCancel { finish(CancellationError()) }
            }
        } onCancel: {
            let task = self.lock.withLock { self.canceled = true; return self.task }
            task?.cancel()
        }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              let final = response.url, MacOSRestoreImageStore.isAppleDownload(final) else {
            finish(CanaveralError.unavailable("Apple's macOS restore download failed.")); completionHandler(.cancel); return
        }
        lock.withLock { expected = response.expectedContentLength }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        do {
            let update: RestoreDownloadProgress? = try lock.withLock {
                guard !finished, !canceled else { return nil }
                try file.write(contentsOf: data); received += Int64(data.count)
                let now = Date.timeIntervalSinceReferenceDate
                guard now - lastReport >= 0.2 || received == expected else { return nil }
                lastReport = now; return .init(received: received, expected: expected)
            }
            if let update { progress(update) }
        } catch { finish(error); dataTask.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) { finish(error) }
    private func finish(_ error: (any Error)?) {
        let completion: (CheckedContinuation<URL, any Error>?, (any Error)?) = lock.withLock {
            guard !finished else { return (nil, nil) }; finished = true
            var error = canceled ? CancellationError() : error
            if error == nil, received <= 0 || (expected > 0 && received != expected) { error = CanaveralError.invalid("The macOS restore download is incomplete.") }
            if error == nil { do { try file.synchronize() } catch let failure { error = failure } }
            try? file.close()
            let result = continuation; continuation = nil; task = nil; return (result, error)
        }
        if let error = completion.1 { completion.0?.resume(throwing: error) }
        else { completion.0?.resume(returning: url) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(request.url.map(MacOSRestoreImageStore.isAppleDownload) == true ? request : nil)
    }
}
struct AppleRestoreImageDownloader: RestoreImageDownloading {
    let directory: URL
    var configurationFactory: @Sendable () -> URLSessionConfiguration = { .ephemeral }
    func download(_ url: URL, progress: @escaping @Sendable (RestoreDownloadProgress) -> Void) async throws -> URL {
        guard MacOSRestoreImageStore.isAppleDownload(url) else { throw CanaveralError.invalid("macOS restore downloads must come from Apple over HTTPS.") }
        let owned = directory.appendingPathComponent(".Canaveral-download-\(UUID()).ipsw")
        var completed = false
        defer { if !completed { try? FileManager.default.removeItem(at: owned) } }
        let delegate = try RestoreStreamDownload(url: owned, progress: progress)
        let session = URLSession(configuration: configurationFactory(), delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url); request.timeoutInterval = 120
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        let file = try await delegate.run(session, request: request)
        try Task.checkCancellation(); completed = true; return file
    }
}
public actor MacOSRestoreImageStore {
    private struct Receipt: Codable {
        var descriptor: MacOSRestoreDescriptor
        var bytes: Int
        var savedAt: Date
    }
    private let root: URL
    private let storage: StorageLocation?
    private let downloader: any RestoreImageDownloading
    private let validator: any RestoreImageValidating
    private var busy = false
    public init(root: URL, storage: StorageLocation? = nil) {
        self.root = root; self.storage = storage; downloader = AppleRestoreImageDownloader(directory: root); validator = NativeRestoreImageValidator()
    }
    init(root: URL, downloader: any RestoreImageDownloading, validator: any RestoreImageValidating) {
        self.root = root; self.storage = nil; self.downloader = downloader; self.validator = validator
    }
    nonisolated static func isAppleDownload(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host?.lowercased(), ["apple.com", "cdn-apple.com"].contains(where: { host == $0 || host.hasSuffix("." + $0) }),
              url.user == nil, url.password == nil, url.port == nil || url.port == 443, url.fragment == nil else { return false }
        return true
    }
    private func location(_ descriptor: MacOSRestoreDescriptor) -> URL {
        let digest = Data(SHA256.hash(data: Data((descriptor.url.absoluteString + "\n" + descriptor.build).utf8))).base64URL
        return root.appendingPathComponent(digest).appendingPathExtension("ipsw")
    }
    public func cached() throws -> [CachedMacOSRestore] {
        try storage?.checkAvailable()
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .compactMap { receiptURL -> (Receipt, URL)? in
                guard let data = try? Data(contentsOf: receiptURL), let receipt = try? JSONDecoder().decode(Receipt.self, from: data),
                      Self.isAppleDownload(receipt.descriptor.url) else { return nil }
                let file = location(receipt.descriptor)
                guard receiptURL.standardizedFileURL.path == file.appendingPathExtension("json").standardizedFileURL.path,
                      let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size == receipt.bytes, size > 0 else { return nil }
                return (receipt, file)
            }
            .sorted { $0.0.savedAt > $1.0.savedAt }
            .map { CachedMacOSRestore(descriptor: $0.0.descriptor, url: $0.1) }
    }
    public func useCached(_ cached: CachedMacOSRestore) async throws -> URL {
        guard try self.cached().contains(where: { $0.url == cached.url && $0.descriptor == cached.descriptor }) else { throw CanaveralError.invalid("The cached restore image is no longer available. Choose another source.") }
        try await validator.validate(cached.url, descriptor: cached.descriptor)
        return cached.url
    }
    public func obtain(_ descriptor: MacOSRestoreDescriptor, progress: @escaping @Sendable (RestoreDownloadProgress) -> Void = { _ in }) async throws -> URL {
        try storage?.checkAvailable()
        guard Self.isAppleDownload(descriptor.url) else { throw CanaveralError.invalid("macOS restore downloads must come from Apple over HTTPS.") }
        if let existing = try cached().first(where: { $0.descriptor == descriptor }) {
            do { return try await useCached(existing) }
            catch {
                try Task.checkCancellation()
                // A damaged cache can be replaced by a fresh, validated download.
                // Offline useCached deliberately never makes a network request.
            }
        }
        guard !busy else { throw CanaveralError.unavailable("A macOS restore image is already being prepared. Wait for it to finish.") }
        busy = true; defer { busy = false }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = try await downloader.download(descriptor.url, progress: progress)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Task.checkCancellation()
        try await validator.validate(temporary, descriptor: descriptor)
        try Task.checkCancellation(); try storage?.checkAvailable()
        let target = location(descriptor)
        let size = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0 else { throw CanaveralError.invalid("Apple returned an empty restore image.") }
        let receipt = try JSONEncoder().encode(Receipt(descriptor: descriptor, bytes: size, savedAt: Date()))
        let staged = root.appendingPathComponent(".\(UUID()).ipsw")
        try FileManager.default.moveItem(at: temporary, to: staged)
        defer { try? FileManager.default.removeItem(at: staged) }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: staged.path)
        // Replace only our managed cache entry; never modify a user-supplied IPSW.
        if FileManager.default.fileExists(atPath: target.path) { _ = try FileManager.default.replaceItemAt(target, withItemAt: staged) }
        else { try FileManager.default.moveItem(at: staged, to: target) }
        try receipt.write(to: target.appendingPathExtension("json"), options: .atomic)
        return target
    }
}
#endif
