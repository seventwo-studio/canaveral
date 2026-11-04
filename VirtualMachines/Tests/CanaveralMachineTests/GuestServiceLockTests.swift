import XCTest
import Foundation
import CanaveralVMCore

final class GuestServiceLockTests: XCTestCase {
    private func directory() throws -> URL {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralGuestLock-\(UUID())")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        addTeardownBlock { try? FileManager.default.removeItem(at:root) }; return root
    }
    func testDuplicateHelperIsRefusedUntilOwnerCloses() throws {
        let root=try directory(); var first: GuestServiceLock?=try GuestServiceLock(state:root)
        XCTAssertNotNil(first); XCTAssertThrowsError(try GuestServiceLock(state:root))
        first=nil
        let second=try GuestServiceLock(state:root); try withExtendedLifetime(second) { XCTAssertThrowsError(try GuestServiceLock(state:root)) }
    }
    func testDistinctFixtureStateDirectoriesRemainIndependent() throws {
        let first=try GuestServiceLock(state:directory()), second=try GuestServiceLock(state:directory())
        withExtendedLifetime((first,second)) {}
    }
    func testSymlinkOrNonregularLockCannotClaimForeignFile() throws {
        let root=try directory(), foreign=root.appendingPathComponent("foreign"), lock=root.appendingPathComponent("guest-helper.lock")
        try Data("foreign".utf8).write(to:foreign)
        try FileManager.default.createSymbolicLink(at:lock,withDestinationURL:foreign)
        XCTAssertThrowsError(try GuestServiceLock(state:root)); XCTAssertEqual(try Data(contentsOf:foreign),Data("foreign".utf8))
        try FileManager.default.removeItem(at:lock); try FileManager.default.createDirectory(at:lock,withIntermediateDirectories:false)
        XCTAssertThrowsError(try GuestServiceLock(state:root))
    }
}
