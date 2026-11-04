import XCTest
import Foundation
import CanaveralVMCore

@MainActor private final class InputBackendFixture: GuestInputBackend {
    var events: [GuestNativeInput]=[], code: UInt16=12, resolutions=0, failed=false
    func resolve(keysym: UInt32, modifiers: GuestInputModifiers) throws -> GuestInputKey {
        resolutions+=1
        return .init(keysym:keysym,code:code,unicode:keysym == 0x0101f680 ? "🚀" : nil)
    }
    func post(_ values: [GuestNativeInput]) throws {
        if failed { events.append(contentsOf:values.prefix(1)); throw CanaveralError.interrupted }
        events+=values
    }
}
@MainActor private final class InputJournalFixture {
    var states: [GuestInputState]=[], failAt: Int?
    func save(_ state: GuestInputState) throws {
        if states.count == failAt { throw CanaveralError.interrupted }
        states.append(state)
    }
}
@MainActor final class GuestDisplayInputTests: XCTestCase {
    func testDragPreservesDownMotionAndUpRatherThanConvertingToClick() throws {
        let backend=InputBackendFixture(), journal=InputJournalFixture(), input=try GuestDisplayInput(backend:backend,save:journal.save)
        let start=GuestInputPoint(x:0.1,y:0.2), end=GuestInputPoint(x:0.8,y:0.9)
        try input.pointer(mask:1,point:start); try input.pointer(mask:1,point:end); try input.pointer(mask:0,point:end)
        XCTAssertEqual(backend.events,[.move(start,buttons:[],modifiers:[]),.button(0,down:true,point:start,modifiers:[],reset:false),
            .move(end,buttons:[0],modifiers:[]),.button(0,down:false,point:end,modifiers:[],reset:false)])
        XCTAssertFalse(input.state.held); XCTAssertEqual(journal.states.count,6)
    }
    func testRightMiddleAuxiliaryButtonsAndHorizontalVerticalWheels() throws {
        let backend=InputBackendFixture(), input=try GuestDisplayInput(backend:backend,save:{ _ in }), point=GuestInputPoint(x:0,y:0)
        try input.pointer(mask:2|4|128|8|32,point:point)
        XCTAssertEqual(input.state.buttons,[1,2,3])
        XCTAssertEqual(backend.events.last,.scroll(horizontal:1,vertical:1,modifiers:[]))
        try input.pointer(mask:16|64,point:point)
        XCTAssertEqual(backend.events.last,.scroll(horizontal:-1,vertical:-1,modifiers:[])); XCTAssertFalse(input.state.held)
    }
    func testBothSidesOfModifierRemainHeldUntilTheirOwnRelease() throws {
        let backend=InputBackendFixture(), input=try GuestDisplayInput(backend:backend,save:{ _ in })
        try input.key(keysym:0xffe1,down:true); try input.key(keysym:0xffe2,down:true)
        try input.key(keysym:0xffe1,down:false); XCTAssertEqual(input.state.modifiers,.shift)
        try input.key(keysym:0xffe2,down:false); XCTAssertTrue(input.state.modifiers.isEmpty)
        XCTAssertEqual(backend.events.last,.key(.init(keysym:0xffe2,code:12),down:false,modifiers:[],repeated:false))
    }
    func testCommandControlOptionShiftSurviveOrdinaryKeyAndPointer() throws {
        let backend=InputBackendFixture(), input=try GuestDisplayInput(backend:backend,save:{ _ in })
        for symbol: UInt32 in [0xffeb,0xffe3,0xffe9,0xffe1] { try input.key(keysym:symbol,down:true) }
        let all: GuestInputModifiers=[.command,.control,.option,.shift]
        try input.key(keysym:0x61,down:true)
        XCTAssertEqual(backend.events.last,.key(.init(keysym:0x61,code:12),down:true,modifiers:all,repeated:false))
        try input.pointer(mask:1,point:.init(x:0,y:0))
        XCTAssertEqual(backend.events.last,.button(0,down:true,point:.init(x:0,y:0),modifiers:all,reset:false))
    }
    func testResolvedNativeKeyRemainsPinnedAcrossLayoutChangeAndRepeat() throws {
        let backend=InputBackendFixture(), input=try GuestDisplayInput(backend:backend,save:{ _ in })
        try input.key(keysym:0x61,down:true); backend.code=0
        try input.key(keysym:0x61,down:true); try input.key(keysym:0x61,down:false)
        XCTAssertEqual(backend.resolutions,1)
        XCTAssertEqual(backend.events,[.key(.init(keysym:0x61,code:12),down:true,modifiers:[],repeated:false),
            .key(.init(keysym:0x61,code:12),down:true,modifiers:[],repeated:true),.key(.init(keysym:0x61,code:12),down:false,modifiers:[],repeated:false)])
    }
    func testUnknownKeyUpCannotReleaseAnUnownedNativeKey() throws {
        let backend=InputBackendFixture(), journal=InputJournalFixture(), input=try GuestDisplayInput(backend:backend,save:journal.save)
        try input.key(keysym:0xffe1,down:false)
        XCTAssertTrue(backend.events.isEmpty); XCTAssertTrue(journal.states.isEmpty); XCTAssertEqual(backend.resolutions,0)
    }
    func testPendingJournalPrecedesNativeEffectAndContainsPossibleReleasedKeys() throws {
        let backend=InputBackendFixture(), journal=InputJournalFixture(), input=try GuestDisplayInput(backend:backend,save:journal.save)
        try input.key(keysym:0x61,down:true); try input.key(keysym:0x61,down:false)
        XCTAssertEqual(journal.states.map(\.uncertain),[true,false,true,false])
        XCTAssertEqual(journal.states[2].keys.map(\.keysym),[0x61]); XCTAssertTrue(journal.states[3].keys.isEmpty)
    }
    func testJournalFailureBeforeDispatchProducesNoNativeEffect() throws {
        let backend=InputBackendFixture(), journal=InputJournalFixture(); journal.failAt=0
        let input=try GuestDisplayInput(backend:backend,save:journal.save)
        XCTAssertThrowsError(try input.key(keysym:0x61,down:true)); XCTAssertTrue(backend.events.isEmpty); XCTAssertFalse(input.state.held)
        XCTAssertFalse(input.state.uncertain)
    }
    func testFinalJournalFailureFencesMoreInputUntilExplicitReset() throws {
        let backend=InputBackendFixture(), journal=InputJournalFixture(); journal.failAt=1
        let input=try GuestDisplayInput(backend:backend,save:journal.save)
        XCTAssertThrowsError(try input.key(keysym:0x61,down:true)); XCTAssertEqual(backend.events.count,1)
        XCTAssertTrue(input.state.uncertain); XCTAssertTrue(input.state.held)
        XCTAssertThrowsError(try input.text("must not run")); XCTAssertEqual(backend.events.count,1)
        journal.failAt=nil; try input.reset(); XCTAssertFalse(input.state.uncertain); XCTAssertFalse(input.state.held)
        XCTAssertEqual(backend.events.last,.key(.init(keysym:0x61,code:12),down:false,modifiers:[],repeated:false))
    }
    func testPartialReleaseFailureRetainsOriginalKeysForReset() throws {
        let backend=InputBackendFixture(), input=try GuestDisplayInput(backend:backend,save:{ _ in })
        try input.key(keysym:0x61,down:true); backend.failed=true
        XCTAssertThrowsError(try input.key(keysym:0x61,down:false)); XCTAssertEqual(input.state.keys.map(\.keysym),[0x61])
        XCTAssertTrue(input.state.uncertain); XCTAssertThrowsError(try input.pointer(mask:0,point:.init(x:0,y:0)))
        backend.failed=false; try input.reset(); XCTAssertFalse(input.state.held)
    }
    func testResetReleasesOrdinaryKeysBeforeModifiersAndButtonsAtCurrentCursor() throws {
        let backend=InputBackendFixture(), input=try GuestDisplayInput(backend:backend,save:{ _ in })
        try input.key(keysym:0xffe3,down:true); try input.key(keysym:0x61,down:true); try input.pointer(mask:1,point:.init(x:0.4,y:0.5))
        let count=backend.events.count; try input.reset()
        XCTAssertEqual(Array(backend.events.dropFirst(count)),[.key(.init(keysym:0x61,code:12),down:false,modifiers:.control,repeated:false),
            .key(.init(keysym:0xffe3,code:12),down:false,modifiers:[],repeated:false),
            .button(0,down:false,point:.init(x:0.4,y:0.5),modifiers:[],reset:true)])
    }
    func testRecoveredStateRequiresResetAndNeverReplaysPresses() throws {
        let backend=InputBackendFixture(), recovered=GuestInputState(keys:[.init(keysym:0x61,code:0)],buttons:[1],point:.init(x:0.5,y:0.5))
        let input=try GuestDisplayInput(backend:backend,recovered:recovered,save:{ _ in })
        XCTAssertThrowsError(try input.key(keysym:0x62,down:true)); XCTAssertTrue(backend.events.isEmpty)
        try input.reset(); XCTAssertEqual(backend.resolutions,0); XCTAssertFalse(input.state.held)
        XCTAssertEqual(backend.events.first,.key(.init(keysym:0x61,code:0),down:false,modifiers:[],repeated:false))
    }
    func testRecoveredMalformedStateIsRefused() throws {
        let backend=InputBackendFixture()
        for recovered in [GuestInputState(keys:[.init(keysym:1,code:128)]),GuestInputState(buttons:[0,0]),GuestInputState(point:.init(x:.infinity,y:0))] {
            XCTAssertThrowsError(try GuestDisplayInput(backend:backend,recovered:recovered,save:{ _ in }))
        }
        XCTAssertTrue(backend.events.isEmpty)
    }
    func testUnicodeKeyTextAndInvalidCoordinates() throws {
        let backend=InputBackendFixture(), input=try GuestDisplayInput(backend:backend,save:{ _ in })
        try input.key(keysym:0x0101f680,down:true); try input.key(keysym:0x0101f680,down:false)
        XCTAssertEqual(backend.events.first,.key(.init(keysym:0x0101f680,code:12,unicode:"🚀"),down:true,modifiers:[],repeated:false))
        try input.text("héllo 🚀"); XCTAssertEqual(backend.events.last,.text("héllo 🚀",modifiers:[]))
        let count=backend.events.count
        for point in [GuestInputPoint(x:-0.1,y:0),.init(x:0,y:.nan),.init(x:1.1,y:0)] { XCTAssertThrowsError(try input.pointer(mask:1,point:point)) }
        XCTAssertThrowsError(try input.text("bad\0text")); XCTAssertThrowsError(try input.text(String(repeating:"🚀",count:4001)))
        XCTAssertEqual(backend.events.count,count)
    }
    func testPartialButtonSwapAndFailedResetKeepEveryPossiblyHeldButton() throws {
        let backend=InputBackendFixture(), input=try GuestDisplayInput(backend:backend,save:{ _ in })
        try input.pointer(mask:1,point:.init(x:0,y:0)); backend.failed=true
        XCTAssertThrowsError(try input.pointer(mask:4,point:.init(x:1,y:1)))
        XCTAssertEqual(input.state.buttons,[0,1]); XCTAssertTrue(input.state.uncertain)
        XCTAssertThrowsError(try input.reset()); XCTAssertEqual(input.state.buttons,[0,1])
        backend.failed=false; try input.reset(); XCTAssertTrue(input.state.buttons.isEmpty)
    }
    func testInvalidNativeResolutionCannotEnterJournalOrPost() throws {
        let backend=InputBackendFixture(), journal=InputJournalFixture(); backend.code=128
        let input=try GuestDisplayInput(backend:backend,save:journal.save)
        XCTAssertThrowsError(try input.key(keysym:0x61,down:true)); XCTAssertTrue(journal.states.isEmpty); XCTAssertTrue(backend.events.isEmpty)
    }

}
