import XCTest
import Foundation
import CanaveralVMCore

private final class StreamClock: @unchecked Sendable {
    private let lock=NSLock(); private var value=100.0
    func now() -> Double { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ next: Double) { lock.lock(); value=next; lock.unlock() }
}
private actor StreamDeviceFixture: GuestDesktopDevice, GuestStreamDevice {
    var events: [GuestStreamEvent]=[], resets=0, legacy=0
    var semanticEffects=0, semanticFailure=false, neutral=true
    var failInput=false, failReset=false, missingState=false, delayCapture=false, delayInput=false, delayLegacy=false, waiting=false
    private var continuation: CheckedContinuation<Void,Never>?
    private let png="iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAE0lEQVR4nGMU0QhggAEmOAudAwAUnACSJ66rswAAAABJRU5ErkJggg=="
    func capture() async throws -> DesktopFrame { .init(width:4,height:3,pngBase64:png) }
    func perform(_ action: DesktopAction) async throws {
        legacy+=1
        if delayLegacy { waiting=true; await withCheckedContinuation { continuation=$0 } }
    }
    func inspectAccessibility() async throws -> GuestAccessibilitySnapshot {
        .init(nodes:[.init(id:"button",parentId:nil,depth:0,attributes:.init(role:"AXButton",states:["enabled":true],actions:["click"],bounds:.init(x:0,y:0,width:10,height:10)))])
    }
    func performAccessibility(_ action: GuestAccessibilityAction, expected: GuestAccessibilitySnapshot) async throws { legacy+=1 }
    func requireNeutralStreamInput() async throws { if !neutral { throw GuestStreamRefusal.busy } }
    func performSemantic(_ action: GuestStreamSemanticAction, frame: GuestStreamFrameBinding?, expiresAt: Double?) async throws {
        semanticEffects+=1
        if semanticFailure { throw CanaveralError.interrupted }
    }
    func semanticFails() { semanticFailure=true }
    func neutralInput(_ value: Bool) { neutral=value }
    func semanticCount() -> Int { semanticEffects }
    func captureStream() async throws -> GuestStreamFrame {
        if delayCapture { waiting=true; await withCheckedContinuation { continuation=$0 } }
        return .init(frame:try await capture(),displayID:1,bounds:.init(x:10,y:20,width:1440,height:900))
    }
    func performStream(_ event: GuestStreamEvent, frame: GuestStreamFrameBinding, expiresAt: Double) async throws {
        XCTAssertEqual(frame.displayID,1); XCTAssertEqual(frame.width,4); XCTAssertEqual(expiresAt,115)
        events.append(event)
        if delayInput { waiting=true; await withCheckedContinuation { continuation=$0 } }
        if failInput { throw CanaveralError.interrupted }
    }
    func resetStreamInput(requireState: Bool) async throws { resets+=1; if failReset || (requireState && missingState) { throw CanaveralError.interrupted } }
    func failNextInput() { failInput=true }
    func resetFails(_ value: Bool) { failReset=value }
    func stateMissing(_ value: Bool) { missingState=value }
    func delays(capture: Bool = false, input: Bool = false, legacy: Bool = false) { delayCapture=capture; delayInput=input; delayLegacy=legacy }
    func resume() { continuation?.resume(); continuation=nil; delayCapture=false; delayInput=false; delayLegacy=false; waiting=false }
    func counts() -> (Int,Int,Int) { (events.count,resets,legacy) }
}
@MainActor final class GuestDisplayStreamTests: XCTestCase {
    private func directory() throws -> URL {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralStream-\(UUID())")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        addTeardownBlock { try? FileManager.default.removeItem(at:root) }; return root
    }
    private func request(_ route: String, _ object: [String:JSONValue], token: String? = nil) throws -> HTTPRequest {
        .init(method:"POST",target:"/v1/display/"+route,headers:token.map { ["authorization":"Bearer "+$0] } ?? [:],body:try JSONEncoder().encode(JSONValue.object(object)))
    }
    private func identity(_ id: UUID) -> [String:JSONValue] { ["streamId":.string(id.uuidString)] }
    private func input(_ id: UUID, frame: UUID, sequence: Int = 1, event: [String:JSONValue] = ["type":.string("key"),"keysym":.number(0xffe3),"down":.bool(true)]) -> [String:JSONValue] {
        ["streamId":.string(id.uuidString),"sequence":.number(Double(sequence)),"frameId":.string(frame.uuidString),"event":.object(event)]
    }
    @discardableResult private func call(_ stream: GuestDisplayStream, _ route: String, _ object: [String:JSONValue]) async throws -> [String:JSONValue] {
        let response=try await stream.handle(request(route,object)); XCTAssertEqual(response.status,200)
        return try XCTUnwrap(JSONDecoder().decode(JSONValue.self,from:response.body).object)
    }
    private func rejected(_ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected refusal",file:file,line:line) } catch {}
    }
    func testOwnershipAndHeldEventsUseOneFreshFrameAndNoDuplicateEffect() async throws {
        let device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:directory(),clock:{ 100 }), id=UUID()
        let frame=try await stream.capture()
        try await call(stream,"take",identity(id)); try await call(stream,"take",identity(id))
        await rejected { try await self.call(stream,"take",self.identity(UUID())) }
        let first=input(id,frame:frame.frame.id)
        try await call(stream,"input",first); try await call(stream,"input",first)
        try await call(stream,"input",input(id,frame:frame.frame.id,sequence:2,event:["type":.string("key"),"keysym":.number(0xffe3),"down":.bool(false)]))
        let counts=await device.counts(); XCTAssertEqual(counts.0,2); XCTAssertEqual(counts.1,1)
        try await call(stream,"release",identity(id)); let busy=await stream.busy(); XCTAssertFalse(busy)
        try await call(stream,"release",identity(id))
        await rejected { try await self.call(stream,"take",self.identity(id)) }
    }
    func testChangedReplaySkippedSequenceAndWrongOwnerNeverPost() async throws {
        let device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:directory(),clock:{ 100 }), id=UUID()
        let frame=try await stream.capture(); try await call(stream,"take",identity(id))
        try await call(stream,"input",input(id,frame:frame.frame.id))
        await rejected { try await self.call(stream,"input",self.input(id,frame:frame.frame.id,event:["type":.string("text"),"text":.string("changed")])) }
        await rejected { try await self.call(stream,"input",self.input(id,frame:frame.frame.id,sequence:3)) }
        await rejected { try await self.call(stream,"input",self.input(UUID(),frame:frame.frame.id,sequence:2)) }
        let counts=await device.counts(); XCTAssertEqual(counts.0,1)
    }
    func testPointerEdgesCarryCapturedPixelDimensionsAndNativeBounds() async throws {
        let device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:directory(),clock:{ 100 }), id=UUID()
        let frame=try await stream.capture(); try await call(stream,"take",identity(id))
        try await call(stream,"input",input(id,frame:frame.frame.id,event:["type":.string("pointer"),"x":.number(3),"y":.number(2),"buttons":.number(1)]))
        let counts=await device.counts(); XCTAssertEqual(counts.0,1)
        await rejected { try await self.call(stream,"input",self.input(id,frame:frame.frame.id,sequence:2,event:["type":.string("pointer"),"x":.number(4),"y":.number(2),"buttons":.number(1)])) }
    }
    func testExpiredAndBackwardClockFramesNeverAuthorizeInput() async throws {
        for expired in [115.0,99.0] {
            let clock=StreamClock(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:directory(),clock:clock.now), id=UUID()
            let frame=try await stream.capture(); try await call(stream,"take",identity(id)); clock.set(expired)
            await rejected { try await self.call(stream,"input",self.input(id,frame:frame.frame.id)) }
            let counts=await device.counts(); XCTAssertEqual(counts.0,0)
        }
    }
    func testCaptureAgeStartsBeforeCollectionAndLateCaptureIsDiscarded() async throws {
        let clock=StreamClock(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:directory(),clock:clock.now)
        await device.delays(capture:true)
        let task=Task { try await stream.capture() }
        while await !device.waiting { await Task.yield() }
        clock.set(116); await device.resume()
        await rejected { _=try await task.value }
    }
    func testCaptureAcrossInputInvalidationIsDiscarded() async throws {
        let device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:directory(),clock:{ 100 })
        await device.delays(capture:true)
        let task=Task { try await stream.capture() }
        while await !device.waiting { await Task.yield() }
        await stream.invalidateFrames(); await device.resume()
        await rejected { _=try await task.value }
    }
    func testNativeFailureBlocksFurtherInputAndTakeUntilExplicitRelease() async throws {
        let device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:directory(),clock:{ 100 }), id=UUID()
        let frame=try await stream.capture(); try await call(stream,"take",identity(id)); await device.failNextInput()
        let event=input(id,frame:frame.frame.id)
        await rejected { try await self.call(stream,"input",event) }
        await rejected { try await self.call(stream,"input",event) }
        await rejected { try await self.call(stream,"take",self.identity(id)) }
        let counts=await device.counts(); XCTAssertEqual(counts.0,1)
        try await call(stream,"release",identity(id)); let busy=await stream.busy(); XCTAssertFalse(busy)
    }
    func testRestartRefusesOwnershipResumptionButCanResetOwnedInputs() async throws {
        let root=try directory(), device=StreamDeviceFixture(), id=UUID()
        let first=try GuestDisplayStream(device:device,state:root,clock:{ 100 }); try await call(first,"take",identity(id))
        let restarted=try GuestDisplayStream(device:device,state:root,clock:{ 100 })
        await rejected { try await self.call(restarted,"take",self.identity(id)) }
        await rejected { try await self.call(restarted,"take",self.identity(UUID())) }
        try await call(restarted,"release",identity(id)); try await call(restarted,"take",identity(UUID()))
        let counts=await device.counts(); XCTAssertEqual(counts.1,3)
    }
    func testReleaseOldClosedIdentityCannotResetNewOwner() async throws {
        let device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:directory(),clock:{ 100 }), old=UUID(), new=UUID()
        try await call(stream,"take",identity(old)); try await call(stream,"release",identity(old)); try await call(stream,"take",identity(new))
        let before=await device.counts(); try await call(stream,"release",identity(old)); let after=await device.counts()
        XCTAssertEqual(before.1,after.1); let busy=await stream.busy(); XCTAssertTrue(busy)
        await rejected { try await self.call(stream,"release",self.identity(UUID())) }
    }
    func testResetFailureKeepsOwnerBlockedAcrossRestart() async throws {
        let root=try directory(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:root,clock:{ 100 }), id=UUID()
        try await call(stream,"take",identity(id)); await device.resetFails(true)
        await rejected { try await self.call(stream,"release",self.identity(id)) }
        let restarted=try GuestDisplayStream(device:device,state:root,clock:{ 100 })
        await rejected { try await self.call(restarted,"take",self.identity(UUID())) }
        await device.resetFails(false); try await call(restarted,"release",identity(id))
    }
    func testMalformedFieldsIntegersAndEventsNeverDispatch() async throws {
        let device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:directory(),clock:{ 100 }), id=UUID()
        let frame=try await stream.capture(); try await call(stream,"take",identity(id))
        for event: [String:JSONValue] in [
            ["type":.string("key"),"keysym":.bool(true),"down":.bool(true)],
            ["type":.string("key"),"keysym":.number(65),"down":.number(1)],
            ["type":.string("text"),"text":.string("bad\0text")],
            ["type":.string("pointer"),"x":.number(0.5),"y":.number(0),"buttons":.number(0)],
            ["type":.string("pointer"),"x":.number(0),"y":.number(0),"buttons":.number(256)],
            ["type":.string("key"),"keysym":.number(65),"down":.bool(true),"extra":.bool(true)]] {
            await rejected { try await self.call(stream,"input",self.input(id,frame:frame.frame.id,event:event)) }
        }
        var bad=input(id,frame:frame.frame.id); bad["sequence"] = .bool(true)
        await rejected { try await self.call(stream,"input",bad) }
        let counts=await device.counts(); XCTAssertEqual(counts.0,0)
    }
    func testOwnerSymlinkIsNotReadOrOverwrittenAtStartup() throws {
        let root=try directory(), foreign=root.appendingPathComponent("foreign")
        try Data("foreign".utf8).write(to:foreign)
        try FileManager.default.createSymbolicLink(at:root.appendingPathComponent("owner.json"),withDestinationURL:foreign)
        XCTAssertThrowsError(try GuestDisplayStream(device:StreamDeviceFixture(),state:root))
        XCTAssertEqual(try Data(contentsOf:foreign),Data("foreign".utf8))
    }
    func testBridgeAuthenticationHumanOwnershipLegacyExclusionAndConfirmedHandoff() async throws {
        let root=try directory(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:root.appendingPathComponent("streams"),clock:{ 100 })
        let token=String(repeating:"t",count:43), bridge=try DesktopBridge(token:token,device:device,journalURL:root.appendingPathComponent("legacy.json"),displayStream:stream), id=UUID()
        var take=try request("take",identity(id)); var response=await bridge.handle(take); XCTAssertEqual(response.status,401)
        take.headers=["authorization":"Bearer "+token,"origin":"https://fixture.invalid"]
        response=await bridge.handle(take); XCTAssertEqual(response.status,403)
        take.headers.removeValue(forKey:"origin"); response=await bridge.handle(take); XCTAssertEqual(response.status,200)
        response=await bridge.handle(.init(method:"GET",target:"/v1/desktop",headers:take.headers,body:Data()))
        let frame=try JSONDecoder().decode(DesktopFrame.self,from:response.body)
        let legacy=DesktopAction(frameID:frame.id,kind:.typeText,text:"must not run")
        response=await bridge.handle(.init(method:"POST",target:"/v1/desktop/action",headers:take.headers,body:try JSONEncoder().encode(legacy)))
        XCTAssertEqual(response.status,409)
        response=await bridge.handle(.init(method:"GET",target:"/v1/accessibility",headers:take.headers,body:Data()))
        let snapshot=try JSONDecoder().decode(GuestAccessibilitySnapshot.self,from:response.body)
        let action=GuestAccessibilityAction(snapshotId:snapshot.snapshotId,nodeId:"button",nativeAction:"click")
        response=await bridge.handle(.init(method:"POST",target:"/v1/accessibility/action",headers:take.headers,body:try JSONEncoder().encode(action)))
        XCTAssertEqual(response.status,409)
        let change=try JSONEncoder().encode(DesktopControlRequest(targetID:UUID(),userControl:true))
        response=await bridge.handle(.init(method:"POST",target:"/v1/desktop/control",headers:take.headers,body:change)); XCTAssertEqual(response.status,200)
        response=await bridge.handle(try request("take",identity(UUID()),token:token)); XCTAssertEqual(response.status,409)
        response=await bridge.handle(.init(method:"GET",target:"/v1/display/frame",headers:take.headers,body:Data())); XCTAssertEqual(response.status,200)
        let counts=await device.counts(); XCTAssertEqual(counts.2,0); XCTAssertEqual(counts.1,2)
    }
    func testBridgeRejectsQueryAndInvalidControlFields() async throws {
        let root=try directory(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:root.appendingPathComponent("streams"),clock:{ 100 })
        let token=String(repeating:"t",count:43), bridge=try DesktopBridge(token:token,device:device,journalURL:root.appendingPathComponent("legacy.json"),displayStream:stream)
        var query=try request("take",identity(UUID()),token:token); query.target+="?extra=1"
        var response=await bridge.handle(query); XCTAssertEqual(response.status,409)
        let data=try JSONEncoder().encode(JSONValue.object(["targetID":.string(UUID().uuidString),"userControl":.bool(false),"extra":.bool(true)]))
        response=await bridge.handle(.init(method:"POST",target:"/v1/desktop/control",headers:["authorization":"Bearer "+token],body:data)); XCTAssertEqual(response.status,409)
        let counts=await device.counts(); XCTAssertEqual(counts.0,0); XCTAssertEqual(counts.1,0)
    }
    func testControlTransitionWaitsForPostingAndRefusesConcurrentHandoff() async throws {
        let root=try directory(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:root.appendingPathComponent("streams"),clock:{ 100 })
        let token=String(repeating:"t",count:43), headers=["authorization":"Bearer "+token]
        let bridge=try DesktopBridge(token:token,device:device,journalURL:root.appendingPathComponent("legacy.json"),displayStream:stream), id=UUID()
        _=await bridge.handle(try request("take",identity(id),token:token))
        let captured=await bridge.handle(.init(method:"GET",target:"/v1/display/frame",headers:headers,body:Data()))
        let frame=try JSONDecoder().decode(GuestStreamFrame.self,from:captured.body)
        await device.delays(input:true)
        let inputRequest=try request("input",input(id,frame:frame.frame.id),token:token)
        let posting=Task { await bridge.handle(inputRequest) }
        while await !device.waiting { await Task.yield() }
        let control=HTTPRequest(method:"POST",target:"/v1/desktop/control",headers:headers,body:try JSONEncoder().encode(DesktopControlRequest(targetID:UUID(),userControl:true)))
        let transition=Task { await bridge.handle(control) }
        let pending=root.appendingPathComponent("control-pending.json"), deadline=NativeLeaseClock.now()+1
        while !FileManager.default.fileExists(atPath:pending.path), NativeLeaseClock.now() < deadline { try await Task.sleep(for:.milliseconds(1)) }
        XCTAssertTrue(FileManager.default.fileExists(atPath:pending.path))
        var response=await bridge.handle(control); XCTAssertEqual(response.status,409)
        let before=await device.counts(); XCTAssertEqual(before.1,1)
        await device.resume(); response=await posting.value; XCTAssertEqual(response.status,200)
        response=await transition.value; XCTAssertEqual(response.status,200)
        let after=await device.counts(); XCTAssertEqual(after.1,2)
    }
    func testFailedHumanHandoffStaysFencedAcrossBridgeRestart() async throws {
        let root=try directory(), device=StreamDeviceFixture(), state=root.appendingPathComponent("streams"), id=UUID()
        let stream=try GuestDisplayStream(device:device,state:state,clock:{ 100 }), token=String(repeating:"t",count:43), headers=["authorization":"Bearer "+token]
        let bridge=try DesktopBridge(token:token,device:device,journalURL:root.appendingPathComponent("legacy.json"),displayStream:stream)
        _=await bridge.handle(try request("take",identity(id),token:token)); await device.resetFails(true)
        let control=HTTPRequest(method:"POST",target:"/v1/desktop/control",headers:headers,body:try JSONEncoder().encode(DesktopControlRequest(targetID:UUID(),userControl:true)))
        var response=await bridge.handle(control); XCTAssertEqual(response.status,409)
        let restarted=try DesktopBridge(token:token,device:device,journalURL:root.appendingPathComponent("legacy.json"),displayStream:GuestDisplayStream(device:device,state:state,clock:{ 100 }))
        response=await restarted.handle(try request("take",identity(UUID()),token:token)); XCTAssertEqual(response.status,409)
        await device.resetFails(false); response=await restarted.handle(control); XCTAssertEqual(response.status,200)
        response=await restarted.handle(try request("take",identity(UUID()),token:token)); XCTAssertEqual(response.status,409) // Human still owns native input.
    }

    func testMissingHeldStateCannotConfirmRecoveryOfPreviouslyReadyOwner() async throws {
        let root=try directory(), device=StreamDeviceFixture(), id=UUID()
        let first=try GuestDisplayStream(device:device,state:root,clock:{ 100 }); try await call(first,"take",identity(id))
        let restarted=try GuestDisplayStream(device:device,state:root,clock:{ 100 }); await device.stateMissing(true)
        await rejected { try await self.call(restarted,"release",self.identity(id)) }
        let busy=await restarted.busy(); XCTAssertTrue(busy)
        await rejected { try await self.call(restarted,"take",self.identity(UUID())) }
    }
    func testOwnerJournalFailurePreventsResetOrGrantAndRetiresAttemptedIdentity() async throws {
        let root=try directory(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:root,clock:{ 100 }), id=UUID()
        let owner=root.appendingPathComponent("owner.json")
        try FileManager.default.createDirectory(at:owner,withIntermediateDirectories:false)
        await rejected { try await self.call(stream,"take",self.identity(id)) }
        let counts=await device.counts(); XCTAssertEqual(counts.1,0)
        try FileManager.default.removeItem(at:owner)
        let restarted=try GuestDisplayStream(device:device,state:root,clock:{ 100 })
        await rejected { try await self.call(restarted,"take",self.identity(id)) }
        try await call(restarted,"take",identity(UUID()))
    }

    func testTypedBusyRefusalIsBeforeEffectsAndDistinctFromUncertainReset() async throws {
        let root=try directory(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:root.appendingPathComponent("streams"),clock:{ 100 })
        let token=String(repeating:"t",count:43), bridge=try DesktopBridge(token:token,device:device,journalURL:root.appendingPathComponent("legacy.json"),displayStream:stream)
        let id=UUID(); _=await bridge.handle(try request("take",identity(id),token:token))
        let response=await bridge.handle(try request("take",identity(UUID()),token:token))
        let busy=try JSONDecoder().decode(JSONValue.self,from:response.body).object
        XCTAssertEqual(busy?["code"]?.string,"input_busy"); XCTAssertEqual(busy?["state"]?.string,"busy")
        let frame=try await stream.capture(); await device.failNextInput()
        _=await bridge.handle(try request("input",input(id,frame:frame.frame.id),token:token))
        let uncertain=await bridge.handle(try request("take",identity(id),token:token))
        let blocked=try JSONDecoder().decode(JSONValue.self,from:uncertain.body).object
        XCTAssertEqual(blocked?["code"]?.string,"input_reset_uncertain"); XCTAssertEqual(blocked?["state"]?.string,"reset-uncertain")
        let counts=await device.counts(); XCTAssertEqual(counts.0,1); XCTAssertEqual(counts.1,1)
    }

    func testShutdownFencesQueuedRequestsAndNeverReopensInput() async throws {
        let root=try directory(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:root.appendingPathComponent("streams"),clock:{ 100 })
        let token=String(repeating:"t",count:43), headers=["authorization":"Bearer "+token], id=UUID()
        let bridge=try DesktopBridge(token:token,device:device,journalURL:root.appendingPathComponent("legacy.json"),displayStream:stream)
        _=await bridge.handle(try request("take",identity(id),token:token)); try await stream.shutdown()
        await rejected { _=try await stream.capture() }
        var response=await bridge.handle(try request("take",identity(UUID()),token:token)); XCTAssertEqual(response.status,409)
        response=await bridge.handle(.init(method:"GET",target:"/v1/desktop",headers:headers,body:Data()))
        let frame=try JSONDecoder().decode(DesktopFrame.self,from:response.body)
        let action=DesktopAction(frameID:frame.id,kind:.typeText,text:"must not run")
        response=await bridge.handle(.init(method:"POST",target:"/v1/desktop/action",headers:headers,body:try JSONEncoder().encode(action)))
        XCTAssertEqual(response.status,409)
        let counts=await device.counts(); XCTAssertEqual(counts.0,0); XCTAssertEqual(counts.2,0)
        try await stream.shutdown() // Cleanup retry never clears the permanent input fence.
        let busy=await stream.busy(); XCTAssertTrue(busy)
    }

    func testBridgeShutdownWaitsForLegacyPostingBeforeResetAndRejectsQueuedRequests() async throws {
        let root=try directory(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:root.appendingPathComponent("streams"),clock:{ 100 })
        let token=String(repeating:"t",count:43), headers=["authorization":"Bearer "+token], bridge=try DesktopBridge(token:token,device:device,journalURL:root.appendingPathComponent("legacy.json"),displayStream:stream)
        let captured=await bridge.handle(.init(method:"GET",target:"/v1/desktop",headers:headers,body:Data()))
        let frame=try JSONDecoder().decode(DesktopFrame.self,from:captured.body)
        let query=HTTPRequest(method:"POST",target:"/v1/desktop/action",headers:headers,body:try JSONEncoder().encode(DesktopAction(frameID:frame.id,kind:.typeText,text:"accepted before shutdown")))
        await device.delays(legacy:true)
        let posting=Task { await bridge.handle(query) }
        while await !device.waiting { await Task.yield() }
        let shutdown=Task { try await bridge.shutdownInput() }
        let marker=root.appendingPathComponent("control-pending.json"), deadline=NativeLeaseClock.now()+1
        while !FileManager.default.fileExists(atPath:marker.path), NativeLeaseClock.now() < deadline { try await Task.sleep(for:.milliseconds(1)) }
        XCTAssertTrue(FileManager.default.fileExists(atPath:marker.path))
        let refused=await bridge.handle(query); XCTAssertEqual(refused.status,503)
        let before=await device.counts(); XCTAssertEqual(before.1,0)
        await device.resume(); let response=await posting.value; XCTAssertEqual(response.status,200)
        try await shutdown.value
        let after=await device.counts(); XCTAssertEqual(after.1,1); XCTAssertEqual(after.2,1)
        XCTAssertFalse(FileManager.default.fileExists(atPath:marker.path))
    }
    func testShutdownDoesNotEraseAnAlreadyUncertainControlMarker() async throws {
        let root=try directory(), marker=root.appendingPathComponent("control-pending.json")
        try Data("{\"pending\":true}".utf8).write(to:marker)
        let device=StreamDeviceFixture(), bridge=try DesktopBridge(token:String(repeating:"t",count:43),device:device,journalURL:root.appendingPathComponent("legacy.json"))
        try await bridge.shutdownInput(); XCTAssertTrue(FileManager.default.fileExists(atPath:marker.path))
    }

    func testSharedStreamProtocolTranscript() async throws {
        let root=try directory(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:root.appendingPathComponent("streams"),clock:{ 100 })
        let token=String(repeating:"t",count:43), bridge=try DesktopBridge(token:token,device:device,journalURL:root.appendingPathComponent("legacy.json"),displayStream:stream)
        let id=UUID(uuidString:"40404040-4040-4040-8040-404040404040")!
        var events: [JSONValue]=[]
        func record(_ query: HTTPRequest, body: [String:JSONValue]?) async throws -> HTTPResponse {
            let result=await bridge.handle(query); XCTAssertEqual(result.status,200)
            let response=try JSONDecoder().decode(JSONValue.self,from:result.body)
            events.append(.object(["method":.string(query.method),"route":.string(query.path),"request":body.map(JSONValue.object) ?? .null,"response":response]))
            return result
        }
        let response=try await record(.init(method:"GET",target:"/v1/display/frame",headers:["authorization":"Bearer "+token],body:Data()),body:nil)
        let frame=try JSONDecoder().decode(GuestStreamFrame.self,from:response.body)
        _=try await record(request("take",identity(id),token:token),body:identity(id))
        let payloads: [[String:JSONValue]]=[
            ["type":.string("key"),"keysym":.number(0xffe3),"down":.bool(true)],
            ["type":.string("key"),"keysym":.number(0x63),"down":.bool(true)],
            ["type":.string("key"),"keysym":.number(0x63),"down":.bool(false)],
            ["type":.string("pointer"),"x":.number(3),"y":.number(2),"buttons":.number(1)],
            ["type":.string("pointer"),"x":.number(3),"y":.number(2),"buttons":.number(0)],
            ["type":.string("key"),"keysym":.number(0xffe3),"down":.bool(false)],
        ]
        for (index,event) in payloads.enumerated() {
            let body=input(id,frame:frame.frame.id,sequence:index+1,event:event)
            _=try await record(request("input",body,token:token),body:body)
        }
        _=try await record(request("release",identity(id),token:token),body:identity(id))
        XCTAssertEqual(events.count,9)
        if let output=ProcessInfo.processInfo.environment["CANAVERAL_STREAM_FIXTURE_OUTPUT"] {
            try JSONEncoder().encode(JSONValue.object(["format":.string("canaveral-native-stream-transcript-v1"),"events":.array(events)])).write(to:URL(fileURLWithPath:output),options:.atomic)
        }
    }

    func testSameOwnerSemanticActionUsesDurableReceiptAndCannotCrossOwnerOrReplayChangedPayload() async throws {
        let root=try directory(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:root.appendingPathComponent("streams"),clock:{ 100 })
        let token=String(repeating:"t",count:43), headers=["authorization":"Bearer "+token], owner=UUID(), operation=UUID()
        let bridge=try DesktopBridge(token:token,device:device,journalURL:root.appendingPathComponent("legacy.json"),displayStream:stream)
        _=await bridge.handle(try request("take",identity(owner),token:token))
        let capture=await bridge.handle(.init(method:"GET",target:"/v1/display/frame",headers:headers,body:Data()))
        let frame=try JSONDecoder().decode(GuestStreamFrame.self,from:capture.body)
        var value: [String:JSONValue]=["streamId":.string(owner.uuidString),"id":.string(operation.uuidString),"frameId":.string(frame.frame.id.uuidString),"action":.string("text"),"arguments":.object(["text":.string("once")])]
        var other=value; other["streamId"] = .string(UUID().uuidString)
        var response=await bridge.handle(try request("action",other,token:token)); XCTAssertEqual(response.status,409)
        response=await bridge.handle(try request("action",value,token:token)); XCTAssertEqual(response.status,200)
        response=await bridge.handle(try request("action",value,token:token)); XCTAssertEqual(response.status,200)
        value["arguments"] = .object(["text":.string("different")])
        response=await bridge.handle(try request("action",value,token:token)); XCTAssertEqual(response.status,409)
        let count=await device.semanticCount(); XCTAssertEqual(count,1)
    }
    func testSameOwnerAccessibilityActionUsesInspectionWithoutRequiringPngFrame() async throws {
        let root=try directory(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:root.appendingPathComponent("streams"),clock:{ 100 })
        let token=String(repeating:"t",count:43), headers=["authorization":"Bearer "+token], owner=UUID()
        let bridge=try DesktopBridge(token:token,device:device,journalURL:root.appendingPathComponent("legacy.json"),displayStream:stream)
        _=await bridge.handle(try request("take",identity(owner),token:token))
        let inspection=await bridge.handle(.init(method:"GET",target:"/v1/accessibility",headers:headers,body:Data()))
        let snapshot=try JSONDecoder().decode(GuestAccessibilitySnapshot.self,from:inspection.body)
        let value: [String:JSONValue]=["streamId":.string(owner.uuidString),"id":.string(UUID().uuidString),"action":.string("accessibility-action"),"arguments":.object(["snapshotId":.string(snapshot.snapshotId.uuidString),"nodeId":.string("button"),"nativeAction":.string("click")])]
        let response=await bridge.handle(try request("action",value,token:token)); XCTAssertEqual(response.status,200)
        let count=await device.semanticCount(); XCTAssertEqual(count,1)
    }
    func testSemanticFailureIsNeverReplayedAndBlocksTheOwner() async throws {
        let root=try directory(), device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:root.appendingPathComponent("streams"),clock:{ 100 })
        let token=String(repeating:"t",count:43), headers=["authorization":"Bearer "+token], owner=UUID()
        let bridge=try DesktopBridge(token:token,device:device,journalURL:root.appendingPathComponent("legacy.json"),displayStream:stream)
        _=await bridge.handle(try request("take",identity(owner),token:token))
        let capture=await bridge.handle(.init(method:"GET",target:"/v1/display/frame",headers:headers,body:Data()))
        let frame=try JSONDecoder().decode(GuestStreamFrame.self,from:capture.body)
        let value: [String:JSONValue]=["streamId":.string(owner.uuidString),"id":.string(UUID().uuidString),"frameId":.string(frame.frame.id.uuidString),"action":.string("tap"),"arguments":.object(["x":.number(3),"y":.number(2)])]
        await device.semanticFails()
        var response=await bridge.handle(try request("action",value,token:token)); XCTAssertEqual(response.status,409)
        response=await bridge.handle(try request("action",value,token:token)); XCTAssertEqual(response.status,409)
        response=await bridge.handle(try request("take",identity(owner),token:token)); XCTAssertEqual(response.status,409)
        let count=await device.semanticCount(); XCTAssertEqual(count,1)
    }
    func testHeldRawInputRefusesSemanticBeforeEffectsWithoutLosingItsOwner() async throws {
        let device=StreamDeviceFixture(), stream=try GuestDisplayStream(device:device,state:directory(),clock:{ 100 }), owner=UUID()
        let frame=try await stream.capture(); try await call(stream,"take",identity(owner)); await device.neutralInput(false)
        await rejected { try await stream.semantic(id:owner,frameID:frame.frame.id) { _,_ in XCTFail("No semantic dispatch while raw keys are held") } }
        await device.neutralInput(true)
        try await call(stream,"input",input(owner,frame:frame.frame.id))
        let count=await device.semanticCount(); XCTAssertEqual(count,0)
    }

}
