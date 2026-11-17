import Foundation
import Security

/// No Keychain fallback: the only import path is the macOS 15 memory-only API.
public final class GuestTLSIdentity: @unchecked Sendable {
    public let identity: SecIdentity
    public let certificate: SecCertificate
    public let serverName: String
    public init(pkcs12: Data, launchId: String) throws {
        guard #available(macOS 15, *), pkcs12.count <= 2800,
              UUID(uuidString: launchId)?.uuidString.lowercased() == launchId else { throw CanaveralError.invalid("Unsupported TLS identity.") }
        serverName = launchId + ".canaveral.invalid"
        var items: CFArray?
        guard SecPKCS12Import(pkcs12 as CFData, [kSecImportExportPassphrase as String: "canaveral-launch-v2", kSecImportToMemoryOnly as String: true] as CFDictionary, &items) == errSecSuccess,
              let rows = items as? [[String: Any]], rows.count == 1,
              let raw = rows[0][kSecImportItemIdentity as String] else { throw CanaveralError.invalid("TLS identity import failed.") }
        identity = raw as! SecIdentity
        var cert: SecCertificate?, key: SecKey?
        guard SecIdentityCopyCertificate(identity, &cert) == errSecSuccess, let cert,
              SecIdentityCopyPrivateKey(identity, &key) == errSecSuccess, let key,
              let publicKey = SecCertificateCopyKey(cert),
              let attrs = SecKeyCopyAttributes(publicKey) as? [String: Any],
              attrs[kSecAttrKeyType as String] as? String == kSecAttrKeyTypeECSECPrimeRandom as String,
              attrs[kSecAttrKeySizeInBits as String] as? Int == 256 else { throw CanaveralError.invalid("TLS key profile differs.") }
        guard let values = SecCertificateCopyValues(cert, [kSecOIDSubjectAltName, kSecOIDBasicConstraints, kSecOIDExtendedKeyUsage, kSecOIDKeyUsage] as CFArray, nil) as? [String: [String: Any]],
              let san = values[kSecOIDSubjectAltName as String]?[kSecPropertyKeyValue as String] as? [[String: Any]],
              san.count == 2, san[1][kSecPropertyKeyLabel as String] as? String == "DNS Name",
              san[1][kSecPropertyKeyValue as String] as? String == serverName,
              let basic = values[kSecOIDBasicConstraints as String]?[kSecPropertyKeyValue as String] as? [[String: Any]], basic.count == 2,
              basic[1][kSecPropertyKeyLabel as String] as? String == "Certificate Authority", basic[1][kSecPropertyKeyValue as String] as? String == "No",
              let usages = values[kSecOIDExtendedKeyUsage as String]?[kSecPropertyKeyValue as String] as? [Data], usages == [Data([0x2b, 6, 1, 5, 5, 7, 3, 1])],
              let usage = values[kSecOIDKeyUsage as String]?[kSecPropertyKeyValue as String] as? NSNumber, usage.int32Value == Int32(bitPattern: 0x80000001),
              SecCertificateCopyNormalizedIssuerSequence(cert) == SecCertificateCopyNormalizedSubjectSequence(cert) else { throw CanaveralError.invalid("TLS certificate extensions differ.") }
        guard let notBefore = SecCertificateCopyNotValidBeforeDate(cert), let notAfter = SecCertificateCopyNotValidAfterDate(cert),
              CFDateGetAbsoluteTime(notBefore) <= CFAbsoluteTimeGetCurrent(), CFAbsoluteTimeGetCurrent() < CFDateGetAbsoluteTime(notAfter) else { throw CanaveralError.invalid("TLS certificate clock is invalid.") }
        certificate = cert
        let challenge = Data("Canaveral key match".utf8)
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, challenge as CFData, nil),
              SecKeyVerifySignature(publicKey, .ecdsaSignatureMessageX962SHA256, challenge as CFData, signature, nil) else { throw CanaveralError.invalid("TLS key mismatch.") }
        var trust: SecTrust?
        guard SecTrustCreateWithCertificates(cert, SecPolicyCreateSSL(true, serverName as CFString), &trust) == errSecSuccess, let trust,
              SecTrustSetAnchorCertificates(trust, [cert] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else { throw CanaveralError.invalid("TLS certificate profile or clock is invalid.") }
    }
}
