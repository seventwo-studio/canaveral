import Foundation
import CryptoKit

/// Immutable trusted assignment. Owned launch media supplies assigned startup; production transport remains gated.
public struct GuestAssignmentContext: Sendable, Encodable {
    public let version = 1
    public let machineId: String
    public let leaseId: String
    public let fingerprint: String
    public let launchId: String
    public init(machineId: String, leaseId: String, fingerprint: String, launchId: String) throws {
        guard [machineId,leaseId,launchId].allSatisfy(Self.canonicalUUID),
              fingerprint.utf8.count == 64, fingerprint.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil else {
            throw CanaveralError.invalid("Invalid guest assignment identity.")
        }
        self.machineId=machineId; self.leaseId=leaseId; self.fingerprint=fingerprint; self.launchId=launchId
    }
    public static func canonicalUUID(_ value: String) -> Bool {
        value.utf8.count == 36 && value.range(of:"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",options:.regularExpression) != nil
    }
    public init(data: Data) throws {
        guard let v=try JSONSerialization.jsonObject(with:data) as? [String:Any],
              Set(v.keys) == ["version","machineId","leaseId","fingerprint","launchId"],
              let version=v["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              let machine=v["machineId"] as? String, let lease=v["leaseId"] as? String,
              let fingerprint=v["fingerprint"] as? String, let launch=v["launchId"] as? String else {
            throw CanaveralError.invalid("Invalid guest assignment identity.")
        }
        try self.init(machineId:machine,leaseId:lease,fingerprint:fingerprint,launchId:launch)
    }
    public enum Purpose: String { case identityRequest = "identity-request", identityResponse = "identity-response", request }
    public static func canonical32(_ value: String) -> Bool {
        value.utf8.count == 43 && value.range(of:"^[A-Za-z0-9_-]{43}$",options:.regularExpression) != nil &&
        Data(base64URL:value).map { $0.count == 32 && $0.base64URL == value } == true
    }
    /// UTF-8, fixed order, LF delimiters including final LF. Assignment schema stays v1.
    public func canonicalBytes(purpose: Purpose, nonce: String? = nil, incarnation: String? = nil) throws -> Data {
        guard (purpose == .request ? nonce == nil : nonce.map(Self.canonical32) == true),
              (purpose == .identityRequest ? incarnation == nil : incarnation.map(Self.canonicalUUID) == true) else {
            throw CanaveralError.invalid("Invalid guest binding fields.")
        }
        return Data((["Canaveral-Binding-v2",purpose.rawValue,"1",machineId,leaseId,fingerprint,launchId] +
                     (nonce.map { [$0] } ?? []) + (incarnation.map { [$0] } ?? []) + [""]).joined(separator:"\n").utf8)
    }
    public func mac(credential: String, purpose: Purpose, nonce: String? = nil, incarnation: String? = nil) throws -> String {
        let mac=HMAC<SHA256>.authenticationCode(for:try canonicalBytes(purpose:purpose,nonce:nonce,incarnation:incarnation),using:SymmetricKey(data:Data(credential.utf8)))
        return Data(mac).base64URL
    }
    public func authorization(credential: String, incarnation: String? = nil, nonce: String? = nil) throws -> String {
        "Canaveral-Binding-v2 " + (incarnation == nil ? (nonce ?? "") + "." : "") +
        (try mac(credential:credential,purpose:incarnation == nil ? .identityRequest : .request,nonce:nonce,incarnation:incarnation))
    }
    /// Only a canonical, authenticated challenge can reach the identity producer.
    public func authenticatedNonce(authorization: String, credential: String) -> String? {
        guard authorization.utf8.count == 108, authorization.hasPrefix("Canaveral-Binding-v2 ") else { return nil }
        let parts=authorization.dropFirst(21).split(separator:".",omittingEmptySubsequences:false)
        guard parts.count == 2 else { return nil }
        let nonce=String(parts[0]), proof=String(parts[1])
        guard Self.canonical32(nonce), Self.canonical32(proof),
              let expected=try? self.authorization(credential:credential,nonce:nonce), Secrets.equal(authorization,expected) else { return nil }
        return nonce
    }
    public func identity(credential: String, nonce: String, incarnation: String) throws -> [String:JSONValue] {
        ["version":.number(1),"machineId":.string(machineId),"leaseId":.string(leaseId),"fingerprint":.string(fingerprint),"launchId":.string(launchId),
         "incarnation":.string(incarnation),"nonce":.string(nonce),
         "proof":.string(try mac(credential:credential,purpose:.identityResponse,nonce:nonce,incarnation:incarnation))]
    }
}
