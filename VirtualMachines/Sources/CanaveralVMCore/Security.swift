import Foundation
import CryptoKit
import Security

public enum Secrets {
    public static func randomToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw CanaveralError.unavailable("Secure random generation failed.") }
        return Data(bytes).base64URL
    }
    public static func hash(_ token: String) -> String { Data(SHA256.hash(data: Data(token.utf8))).base64URL }
    public static func equal(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8), b = Array(rhs.utf8)
        guard a.count == b.count else { return false }
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}
public extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    init?(base64URL: String) {
        let s = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        self.init(base64Encoded: s + String(repeating: "=", count: (4 - s.count % 4) % 4))
    }
}
public protocol CredentialVault: Sendable {
    func read(_ key: String) throws -> Data?
    func write(_ key: String, data: Data) throws
    func delete(_ key: String) throws
}
public struct KeychainAccessError: Error, LocalizedError, Sendable {
    public let status: OSStatus
    public var needsAuthorization: Bool { [errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled].contains(status) }
    public var errorDescription: String? {
        #if os(macOS)
        needsAuthorization ? "Saved credentials need access. Open Canaveral guest settings. Approve Canaveral once; normal background access does not show password prompts." : "Keychain is unavailable (\(status))."
        #else
        needsAuthorization ? "Unlock your device to access its saved connection credentials." : "Keychain is unavailable (\(status))."
        #endif
    }
}
public struct KeychainVault: CredentialVault {
    public let service: String
    public let allowAuthenticationUI: Bool
    public init(service: String = "app.canaveral.private", allowAuthenticationUI: Bool = false) { self.service = service; self.allowAuthenticationUI = allowAuthenticationUI }
    public func read(_ key: String) throws -> Data? {
        try withInteraction { try readItem(key) }
    }
    private func readItem(_ key: String) throws -> Data? {
        #if os(macOS)
        _ = try MacKeychainPolicy.make(service: service, key: key)
        #endif
        var query = operationQuery(key); query[kSecReturnData as String] = true; query[kSecReturnAttributes as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainAccessError(status: status) }
        let attributes = result as? [String: Any]
        return attributes?[kSecValueData as String] as? Data ?? result as? Data
    }
    public func write(_ key: String, data: Data) throws {
        try withInteraction { try writeItem(key, data: data) }
    }
    private func writeItem(_ key: String, data: Data) throws {
        let query = operationQuery(key)
        let changes: [String: Any] = [kSecValueData as String: data]
        #if os(macOS)
        let policy = try MacKeychainPolicy.make(service: service, key: key)
        #endif
        let status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query; item.merge(changes) { _, value in value }
            #if os(macOS)
            if let policy { item[kSecAttrAccess as String] = policy.access; item[kSecAttrGeneric as String] = policy.stamp }
            #endif
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let result = SecItemAdd(item as CFDictionary, nil)
            guard result == errSecSuccess else { throw KeychainAccessError(status: result) }
        } else if status != errSecSuccess { throw KeychainAccessError(status: status) }
    }
    public func delete(_ key: String) throws {
        try withInteraction { try deleteItem(key) }
    }
    private func deleteItem(_ key: String) throws {
        #if os(macOS)
        _ = try MacKeychainPolicy.make(service: service, key: key)
        #endif
        let status = SecItemDelete(operationQuery(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainAccessError(status: status) }
    }
    private func base(_ key: String) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key] }
    private func withInteraction<T>(_ operation: () throws -> T) throws -> T {
        #if os(macOS)
        try MacKeychainInteraction.perform(allowUI: allowAuthenticationUI, operation)
        #else
        try operation()
        #endif
    }
    private func operationQuery(_ key: String) -> [String: Any] {
        var query = base(key)
        #if os(macOS)
        query[kSecUseAuthenticationUI as String] = allowAuthenticationUI ? kSecUseAuthenticationUIAllow : kSecUseAuthenticationUIFail
        #endif
        return query
    }
    #if os(macOS)
    /// User initiated only. Enumerate this app's service, never other apps' items.
    public func authorizeSavedCredentials() throws {
        try withInteraction { try authorizeItems() }
    }
    private func authorizeItems() throws {
        guard service == "app.canaveral.private", allowAuthenticationUI else { throw CanaveralError.invalid("Use Canaveral's explicit Keychain access action.") }
        var query = operationQuery(""); query.removeValue(forKey: kSecAttrAccount as String)
        query[kSecReturnAttributes as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitAll
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return }
        guard status == errSecSuccess else { throw KeychainAccessError(status: status) }
        let known = Set(["desktop-credential"])
        let keys = (result as? [[String: Any]] ?? []).compactMap { $0[kSecAttrAccount as String] as? String }
            .filter { known.contains($0) || ($0.hasPrefix("desktop-") && UUID(uuidString: String($0.dropFirst(8))) != nil) }.sorted()
        for key in keys { _ = try read(key) }
    }
    #endif
}
public struct ConnectionConfiguration: Codable, Sendable {
    public var url: URL; public var token: String
    public init(url: URL, token: String) { self.url = url; self.token = token }
    public static func validateRemoteURL(_ text: String, allowedPorts: Set<Int> = [443]) throws -> URL {
        guard let u = URL(string: text), u.scheme == "https", let host = u.host,
              host.hasSuffix(".ts.net"), u.user == nil, u.password == nil, u.query == nil, u.fragment == nil,
              allowedPorts.contains(u.port ?? 443), u.path.isEmpty || u.path == "/" else {
            throw CanaveralError.invalid("Use the VM’s HTTPS Tailscale address, ending in .ts.net.")
        }
        return u
    }
}
