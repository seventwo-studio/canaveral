import Foundation
#if os(macOS)
import Darwin
#endif

public struct NativeLeaseAuthorization: Codable, Sendable {
    public var version: Int
    public var machineID: UUID
    public var leaseID: UUID
    public var revision: Int
    public var boot: Double
    public var bootSessionID: UUID
    public var deadline: Double
    public var fenced: Bool
    public init(machineID: UUID, leaseID: UUID, revision: Int, boot: Double,
                bootSessionID: UUID, deadline: Double, fenced: Bool = false) {
        self.version = 1; self.machineID = machineID; self.leaseID = leaseID
        self.revision = revision; self.boot = boot; self.bootSessionID = bootSessionID
        self.deadline = deadline; self.fenced = fenced
    }
}

/// One boot's sticky execution deadline. Wall-clock changes cannot renew it.
public struct LeaseExecutionGuard: Sendable {
    private let machineID: UUID, leaseID: UUID, bootSessionID: UUID
    private let boot: Double
    public private(set) var fenced = false
    public private(set) var revision = 0
    public private(set) var deadline: Double?
    public init(machineID: UUID, leaseID: UUID, boot: Double, bootSessionID: UUID) {
        self.machineID = machineID; self.leaseID = leaseID; self.boot = boot
        self.bootSessionID = bootSessionID
    }
    public mutating func observe(_ value: NativeLeaseAuthorization?, now: Double) -> Bool {
        guard !fenced else { return false }
        // Expiry wins even against a higher revision first observed too late.
        if let deadline, now >= deadline { fenced = true; return false }
        guard now.isFinite, now >= 0, let value, value.version == 1,
              value.machineID == machineID, value.leaseID == leaseID,
              value.boot == boot, value.boot.isFinite, value.bootSessionID == bootSessionID,
              value.revision >= 1, value.deadline.isFinite, value.deadline >= 0,
              !value.fenced else { fenced = true; return false }
        if value.revision >= revision {
            if value.revision == revision, let previous = deadline {
                deadline = min(previous, value.deadline)
            } else { deadline = value.deadline; revision = value.revision }
        }
        guard let deadline, now < deadline else { fenced = true; return false }
        return true
    }
}

#if os(macOS)
public enum NativeLeaseClock {
    /// Continuous Mach time includes system sleep, unlike awake-only uptime.
    public static func now() -> Double {
        var scale = mach_timebase_info_data_t()
        mach_timebase_info(&scale)
        return Double(mach_continuous_time()) * Double(scale.numer) / Double(scale.denom) / 1_000_000_000
    }
    public static func bootSession() throws -> UUID {
        var length = 0
        guard sysctlbyname("kern.bootsessionuuid", nil, &length, nil, 0) == 0,
              length > 1, length <= 128 else { throw CanaveralError.unavailable("Host boot identity is unavailable.") }
        var bytes = [CChar](repeating: 0, count: length)
        guard sysctlbyname("kern.bootsessionuuid", &bytes, &length, nil, 0) == 0,
              let identity = UUID(uuidString: String(decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)) else {
            throw CanaveralError.unavailable("Host boot identity is invalid.")
        }
        return identity
    }
}
#endif
