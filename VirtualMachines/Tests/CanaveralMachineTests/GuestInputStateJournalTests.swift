import XCTest
import Foundation
import CanaveralVMCore

@MainActor private final class JournalInputBackend: GuestInputBackend {
    var effects: [GuestNativeInput]=[]
    func resolve(keysym: UInt32, modifiers: GuestInputModifiers) throws -> GuestInputKey { .init(keysym:keysym,code:8) }
    func post(_ events: [GuestNativeInput]) throws { effects+=events }
}
@MainActor final class GuestInputStateJournalTests: XCTestCase {
    private func directory() throws -> URL {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralHeldJournal-\(UUID())")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        addTeardownBlock { try? FileManager.default.removeItem(at:root) }; return root
    }
    func testPrivateStateRoundTripsAndMissingStateIsExplicit() throws {
        let root=try directory(), journal=try GuestInputStateJournal(root)
        XCTAssertNil(try journal.read())
        let state=GuestInputState(keys:[.init(keysym:0xffe3,code:59)],buttons:[0],point:.init(x:0.5,y:0.7),uncertain:true)
        try journal.save(state); XCTAssertEqual(try journal.read(),state)
        let attributes=try FileManager.default.attributesOfItem(atPath:root.appendingPathComponent("held.json").path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue,0o600)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath:root.path)[.posixPermissions] as? NSNumber)?.intValue,0o700)
    }
    func testRealJournalBeforeAndAfterDispatchAndRecoveryOnlyReleases() throws {
        let root=try directory(), journal=try GuestInputStateJournal(root), backend=JournalInputBackend()
        let first=try GuestDisplayInput(backend:backend,save:journal.save)
        try first.key(keysym:0x63,down:true)
        let saved=try XCTUnwrap(journal.read()); XCTAssertTrue(saved.held); XCTAssertFalse(saved.uncertain)
        let recovered=try GuestDisplayInput(backend:backend,recovered:saved,save:journal.save)
        XCTAssertThrowsError(try recovered.key(keysym:0x63,down:true))
        let before=backend.effects.count; try recovered.reset()
        XCTAssertEqual(Array(backend.effects.dropFirst(before)),[.key(.init(keysym:0x63,code:8),down:false,modifiers:[],repeated:false)])
        XCTAssertFalse(try XCTUnwrap(journal.read()).held)
    }
    func testReceiptSymlinkAndNonregularFileCannotBecomeEmptyRecovery() throws {
        let root=try directory(), journal=try GuestInputStateJournal(root), foreign=root.appendingPathComponent("foreign")
        try Data("foreign".utf8).write(to:foreign)
        let held=root.appendingPathComponent("held.json")
        try FileManager.default.createSymbolicLink(at:held,withDestinationURL:foreign)
        XCTAssertThrowsError(try journal.read()); XCTAssertEqual(try Data(contentsOf:foreign),Data("foreign".utf8))
        try FileManager.default.removeItem(at:held); try FileManager.default.createDirectory(at:held,withIntermediateDirectories:false)
        XCTAssertThrowsError(try journal.read())
    }
    func testMalformedOversizedAndUnknownVersionRefuseRecovery() throws {
        let root=try directory(), journal=try GuestInputStateJournal(root), held=root.appendingPathComponent("held.json")
        for data in [Data("{".utf8),Data(repeating:65,count:65537),Data("{\"version\":99,\"state\":{\"keys\":[],\"buttons\":[],\"point\":{\"x\":0,\"y\":0},\"uncertain\":false}}".utf8)] {
            try data.write(to:held); XCTAssertThrowsError(try journal.read())
        }
    }
    func testInvalidStateNeverPublishesAndFailedFinalPublicationStaysUncertain() throws {
        let root=try directory(), journal=try GuestInputStateJournal(root), backend=JournalInputBackend()
        XCTAssertThrowsError(try journal.save(.init(keys:[.init(keysym:1,code:128)])))
        XCTAssertNil(try journal.read())
        var writes=0
        let input=try GuestDisplayInput(backend:backend) { state in
            writes+=1
            if writes == 2 { throw CanaveralError.interrupted }
            try journal.save(state)
        }
        XCTAssertThrowsError(try input.key(keysym:0x63,down:true))
        XCTAssertEqual(backend.effects.count,1); XCTAssertTrue(try XCTUnwrap(journal.read()).uncertain)
        XCTAssertTrue(input.state.uncertain); try input.reset(); XCTAssertFalse(try XCTUnwrap(journal.read()).held)
    }
}
