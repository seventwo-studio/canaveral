#if os(macOS)
import Foundation
import Security

/// Legacy login-Keychain APIs ignore the newer per-query UI flag in some cases.
/// This switch is process-local. Serialize and restore it around every vault operation.
enum MacKeychainInteraction {
    private static let lock = NSRecursiveLock()
    static func perform<T>(allowUI: Bool, _ operation: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        var previous = DarwinBoolean(false)
        let read = SecKeychainGetUserInteractionAllowed(&previous)
        guard read == errSecSuccess else { throw KeychainAccessError(status: read) }
        let changed = SecKeychainSetUserInteractionAllowed(allowUI)
        guard changed == errSecSuccess else { throw KeychainAccessError(status: changed) }
        defer { SecKeychainSetUserInteractionAllowed(previous.boolValue) }
        return try operation()
    }
}

/// Narrow compatibility bridge for existing login-Keychain items.
enum MacKeychainPolicy {
    struct Policy { let access: SecAccess; let stamp: Data }
    private static let identity: (team: String, identifier: String, url: URL)? = {
        let bundle = Bundle.main
        guard let identifier = bundle.bundleIdentifier,
              ["app.canaveral.machines", "app.canaveral.machineshine-host"].contains(identifier),
              let team = signingTeam(bundle.bundleURL, identifier: identifier) else { return nil }
        return (team, identifier, bundle.bundleURL)
    }()
    static func make(service: String, key: String) throws -> Policy? {
        let shared = service == "app.canaveral.private" && (key.hasPrefix("desktop-") || key == "desktop-credential")
        if Bundle.main.bundleIdentifier == "app.canaveral.machineshine-host", service == "app.canaveral.private", !shared {
            throw CanaveralError.invalid("Only Canaveral's main app may access account credentials.")
        }
        guard let identity else { return nil }
        var current: SecTrustedApplication?
        guard SecTrustedApplicationCreateFromPath(nil, &current) == errSecSuccess, let current else {
            throw CanaveralError.unavailable("Cannot establish Canaveral's signed Keychain identity.")
        }
        var trusted = [current]
        if shared {
            let other = identity.identifier == "app.canaveral.machines"
                ? identity.url.appendingPathComponent("Contents/Helpers/CanaveralMachineHost.app")
                : identity.url.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            let otherID = identity.identifier == "app.canaveral.machines" ? "app.canaveral.machineshine-host" : "app.canaveral.machines"
            if signingTeam(other, identifier: otherID) == identity.team {
                var application: SecTrustedApplication?
                let status = other.path.withCString { SecTrustedApplicationCreateFromPath($0, &application) }
                if status == errSecSuccess, let application { trusted.append(application) }
            }
            // A separately launched helper must not shrink an existing shared access list.
            if trusted.count != 2 { return nil }
        }
        var access: SecAccess?
        guard SecAccessCreate("Canaveral — \(key)" as CFString, trusted as CFArray, &access) == errSecSuccess, let access else {
            throw CanaveralError.unavailable("Cannot prepare Canaveral's Keychain access policy.")
        }
        let stamp = Data("seven-keychain-v1:\(identity.team):\(shared ? "chat" : identity.identifier):\(trusted.count)".utf8)
        return Policy(access: access, stamp: stamp)
    }
    private static func signingTeam(_ url: URL, identifier: String) -> String? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let values = info as? [String: Any], values[kSecCodeInfoIdentifier as String] as? String == identifier,
              let team = values[kSecCodeInfoTeamIdentifier as String] as? String,
              team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { return nil }
        let text = "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
              SecStaticCodeCheckValidity(code, [], requirement) == errSecSuccess else { return nil }
        return team
    }
}
#endif
