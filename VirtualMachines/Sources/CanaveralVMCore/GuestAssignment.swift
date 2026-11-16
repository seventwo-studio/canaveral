import Foundation
import CryptoKit

/// Immutable trusted assignment. There is no production launch source or bootstrap delivery yet.
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
    /// UTF-8, fixed order, LF delimiters including final LF. Fields cannot contain LF.
    public func canonicalBytes(incarnation: String? = nil) throws -> Data {
        if let incarnation, !Self.canonicalUUID(incarnation) { throw CanaveralError.invalid("Invalid guest helper incarnation.") }
        return Data((["Canaveral-Binding-v1",incarnation == nil ? "identity" : "request",machineId,leaseId,fingerprint,launchId] + (incarnation.map { [$0] } ?? []) + [""]).joined(separator:"\n").utf8)
    }
    public func authorization(credential: String, incarnation: String? = nil) throws -> String {
        let mac=HMAC<SHA256>.authenticationCode(for:try canonicalBytes(incarnation:incarnation),using:SymmetricKey(data:Data(credential.utf8)))
        return "Canaveral-Binding-v1 " + Data(mac).base64URL
    }
    public func identity(incarnation: String) -> [String:JSONValue] {
        ["version":.number(1),"machineId":.string(machineId),"leaseId":.string(leaseId),"fingerprint":.string(fingerprint),"launchId":.string(launchId),"incarnation":.string(incarnation)]
    }
}
