import Foundation
import XCTest
import CanaveralVMCore
import CanaveralMachines

final class LeaseExecutionTests: XCTestCase {
    let machine = UUID(), lease = UUID(), hostBoot = UUID()
    func authorization(revision: Int = 1, deadline: Double = 100) -> NativeLeaseAuthorization {
        NativeLeaseAuthorization(machineID: machine, leaseID: lease, revision: revision, boot: 42,
                                 bootSessionID: hostBoot, deadline: deadline)
    }
    func guardState() -> LeaseExecutionGuard {
        LeaseExecutionGuard(machineID: machine, leaseID: lease, boot: 42, bootSessionID: hostBoot)
    }
    func testSameRevisionCannotExtendAndExpiryWinsAgainstLateRenewal() {
        var state = guardState()
        XCTAssertTrue(state.observe(authorization(), now: 10))
        XCTAssertTrue(state.observe(authorization(deadline: 200), now: 20))
        XCTAssertEqual(state.deadline, 100)
        XCTAssertFalse(state.observe(authorization(revision: 2, deadline: 300), now: 100))
        XCTAssertFalse(state.observe(authorization(revision: 3, deadline: 400), now: 101))
    }
    func testFreshRenewalAndStaleRevisionNeverRollBackDeadline() {
        var state = guardState()
        XCTAssertTrue(state.observe(authorization(), now: 10))
        XCTAssertTrue(state.observe(authorization(revision: 2, deadline: 200), now: 20))
        XCTAssertTrue(state.observe(authorization(deadline: 15), now: 21))
        XCTAssertEqual(state.deadline, 200)
        XCTAssertFalse(state.observe(authorization(revision: 2, deadline: 200), now: 201))
    }
    func testMissingInvalidOrChangedOwnershipFencesImmediately() {
        for field in 0..<8 {
            var state = guardState(), value = authorization()
            switch field {
            case 0: value.machineID = UUID()
            case 1: value.leaseID = UUID()
            case 2: value.bootSessionID = UUID()
            case 3: value.boot = 43
            case 4: value.version = 2
            case 5: value.deadline = .infinity
            case 6: value.fenced = true
            default: value.revision = 0
            }
            XCTAssertFalse(state.observe(value, now: 10))
            XCTAssertFalse(state.observe(authorization(), now: 11))
        }
        var missing = guardState()
        XCTAssertFalse(missing.observe(nil, now: 10))
    }
    @MainActor func testLeasedMachineCannotBootWithoutSupervisor() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let directory = root.appendingPathComponent(machine.uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var value = Machine(name: "leased fixture", os: .linux, cpuCount: 1, memoryGiB: 1, diskGiB: 4, mode: .server)
        value.id = machine; value.executionLeaseID = lease; value.installation = .ready
        try MachineStore.save(value, directory: directory)
        let runtime = MachineRuntime(directory: directory)
        await runtime.boot()
        XCTAssertNil(runtime.virtualMachine)
        XCTAssertEqual(runtime.phase, "Unavailable")
        XCTAssertTrue(runtime.detail.contains("execution supervisor"))
    }
}
