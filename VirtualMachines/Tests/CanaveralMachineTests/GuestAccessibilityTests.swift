import XCTest
import Foundation
import CanaveralVMCore

private final class InspectionClock: @unchecked Sendable {
    private let lock=NSLock()
    private var value=100.0
    func now() -> Double { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ number: Double) { lock.lock(); value=number; lock.unlock() }
}

@MainActor private final class AccessibilityFixture: GuestAccessibilityBackend {
    typealias Element = String
    var values: [String:GuestAccessibilityAttributes]=[
        "app": .init(role:"AXApplication",name:"Fixture",properties:["applicationIdentifier":.string("com.example.fixture")]),
        "window": .init(role:"AXWindow",name:"Window",bounds:.init(x:0,y:0,width:800,height:600)),
        "button": .init(role:"AXButton",name:"Continue",identifier:"continue",states:["enabled":true],actions:["click","AXShowMenu"],bounds:.init(x:10,y:20,width:100,height:40)),
    ]
    var descendants: [String:[String]]=["app":["window"],"window":["button"]]
    var rootElements=["app"]
    var effects: [String]=[], fail=false
    var onRead: (() -> Void)?
    func roots() throws -> [String] { rootElements }
    func attributes(_ element: String) throws -> GuestAccessibilityAttributes {
        onRead?()
        guard let value=values[element] else { throw CanaveralError.unavailable("Private fixture failure") }
        return value
    }
    func children(_ element: String, limit: Int) throws -> (elements:[String],truncated:Bool) {
        let values=descendants[element,default:[]]; return (Array(values.prefix(limit)),values.count > limit)
    }
    func hash(_ element: String) -> Int { element.hashValue }
    func same(_ first: String, _ second: String) -> Bool { first == second }
    func perform(_ element: String, action: String) throws {
        effects.append(element+":"+action)
        if fail { throw CanaveralError.interrupted }
    }
}

private actor AccessibilityGuestFixture: GuestDesktopDevice {
    let snapshot: GuestAccessibilitySnapshot
    var effects=0, failed=false, waiting=false, delayed=false
    private var last: GuestAccessibilitySnapshot?, reads=0
    private var continuation: CheckedContinuation<Void,Never>?
    init(snapshot: GuestAccessibilitySnapshot) { self.snapshot=snapshot }
    func capture() async throws -> DesktopFrame {
        .init(width:1,height:1,pngBase64:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==")
    }
    func perform(_ action: DesktopAction) async throws { effects+=1 }
    func inspectAccessibility() async throws -> GuestAccessibilitySnapshot {
        if delayed { waiting=true; await withCheckedContinuation { continuation=$0 } }
        var value=snapshot
        if reads > 0 { value.snapshotId=UUID() }
        reads+=1; last=value
        return value
    }
    func performAccessibility(_ action: GuestAccessibilityAction, expected: GuestAccessibilitySnapshot) async throws {
        guard expected == last else { throw CanaveralError.invalid("Wrong guest snapshot") }
        effects+=1
        if failed { throw CanaveralError.interrupted }
    }
    func failNext() { failed=true }
    func delay() { delayed=true }
    func resume() { continuation?.resume(); continuation=nil }
}

@MainActor final class GuestAccessibilityTests: XCTestCase {
    private func directory() throws -> URL {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralAccessibility-\(UUID())")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        addTeardownBlock { try? FileManager.default.removeItem(at:root) }; return root
    }
    private func request(_ path: String = "/v1/accessibility", body: Data = Data(), token: String = String(repeating:"t",count:43), origin: Bool = false) -> HTTPRequest {
        var headers=["authorization":"Bearer "+token]
        if origin { headers["origin"]="https://fixture.invalid" }
        return .init(method:body.isEmpty ? "GET" : "POST",target:path,headers:headers,body:body)
    }
    private func snapshot() throws -> GuestAccessibilitySnapshot { try GuestAccessibilityTree(backend:AccessibilityFixture()).inspect() }
    private func action(_ value: GuestAccessibilitySnapshot, id: UUID = UUID(), human: Bool? = nil) -> GuestAccessibilityAction {
        .init(id:id,snapshotId:value.snapshotId,nodeId:value.nodes.last!.id,nativeAction:"click",human:human)
    }
    func testCanonicalSnapshotEmitsNullParentsBoundsAndSharedShape() async throws {
        let tree=GuestAccessibilityTree(backend:AccessibilityFixture()), value=try tree.inspect()
        try value.validate()
        let data=try JSONEncoder().encode(value)
        let object=try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
        let nodes=try XCTUnwrap(object["nodes"] as? [[String:Any]])
        XCTAssertTrue(nodes[0]["parentId"] is NSNull); XCTAssertTrue(nodes[0]["bounds"] is NSNull)
        XCTAssertEqual(nodes[2]["parentId"] as? String,nodes[1]["id"] as? String)
        XCTAssertEqual(value.source,"macos-accessibility"); XCTAssertEqual(value.coordinateSpace,"screen-points")
        XCTAssertEqual(try JSONDecoder().decode(GuestAccessibilitySnapshot.self,from:data),value)
        if let export=ProcessInfo.processInfo.environment["CANAVERAL_ACCESSIBILITY_FIXTURE_OUTPUT"] {
            try data.write(to:URL(fileURLWithPath:export),options:.atomic)
        }
    }
    func testNativeActionRevalidatesThenRetiresSnapshot() async throws {
        let backend=AccessibilityFixture(), tree=GuestAccessibilityTree(backend:backend)
        let value=try tree.inspect(); var input=action(value); input.nativeAction="AXShowMenu"
        try tree.perform(input,expected:value)
        XCTAssertEqual(backend.effects,["button:AXShowMenu"])
        XCTAssertThrowsError(try tree.perform(input,expected:value)); XCTAssertEqual(backend.effects.count,1)
    }
    func testMovedReplacedAndChangedAncestorTargetsNeverDispatch() async throws {
        for change in ["bounds","ancestor","replacement","state","process"] {
            let backend=AccessibilityFixture(), tree=GuestAccessibilityTree(backend:backend), value=try tree.inspect()
            if change == "bounds" { backend.values["button"]!.bounds!.x=11 }
            if change == "ancestor" { backend.values["window"]!.name="Different context" }
            if change == "replacement" { backend.values["other"]=backend.values["button"]; backend.descendants["window"]=["other"] }
            if change == "state" { backend.values["button"]!.states["enabled"]=false }
            if change == "process" { backend.values["app"]!.properties["processStartedAt"] = .number(200) }
            XCTAssertThrowsError(try tree.perform(action(value),expected:value)); XCTAssertEqual(backend.effects,[])
        }
    }
    func testPasswordRedactionAppliesToDescendantsAndArbitraryNativeProperties() async throws {
        let backend=AccessibilityFixture()
        backend.values["window"]!.states["password"]=true
        backend.values["window"]!.name="private-password"
        backend.values["button"]!.name="private-password"
        backend.values["button"]!.properties=["AXValue":.string("private-password"),"other":.array([.string("private-password")])]
        let value=try GuestAccessibilityTree(backend:backend).inspect()
        let text=String(decoding:try JSONEncoder().encode(value),as:UTF8.self)
        XCTAssertFalse(text.contains("private-password")); XCTAssertEqual(value.nodes.last!.name,"[redacted]")
        XCTAssertEqual(value.nodes.last!.states["password"],true); XCTAssertEqual(value.nodes.last!.identifier,"continue")
    }
    func testNodeDepthCycleAndByteBudgetsAreExplicit() async throws {
        for limit in ["nodes","depth","cycle","bytes"] {
            let backend=AccessibilityFixture()
            if limit == "nodes" || limit == "bytes" {
                let count=limit == "nodes" ? 2200 : 150
                let children=(0..<count).map { "child-\($0)" }; backend.descendants["app"]=children
                for child in children {
                    backend.values[child] = .init(role:"AXText",properties:limit == "bytes" ? ["value":.string(String(repeating:"v",count:60000))] : [:])
                }
            }
            if limit == "depth" {
                for n in 0..<40 { let key="depth-\(n)"; backend.values[key] = .init(role:"AXGroup"); backend.descendants[key]=["depth-\(n+1)"] }
                backend.descendants["app"]=["depth-0"]
            }
            if limit == "cycle" { backend.descendants["button"]=["app"] }
            let value=try GuestAccessibilityTree(backend:backend).inspect(); try value.validate()
            XCTAssertTrue(value.truncated); XCTAssertLessThanOrEqual(value.nodes.count,2000)
            XCTAssertLessThanOrEqual(try JSONEncoder().encode(value).count,6*1048576)
        }
    }
    func testUnavailableElementsDoNotLeakNativeErrorsAndUnknownInputIsDenied() async throws {
        let backend=AccessibilityFixture(); backend.descendants["window"]!.append("vanished")
        let tree=GuestAccessibilityTree(backend:backend), value=try tree.inspect()
        XCTAssertEqual(value.unavailableNodes,1)
        XCTAssertFalse(String(decoding:try JSONEncoder().encode(value),as:UTF8.self).contains("Private"))
        var unsupported=action(value); unsupported.nativeAction="host-command"
        XCTAssertThrowsError(try tree.perform(unsupported,expected:value))
        var forged=value; forged.nodes[2].name="forged"
        XCTAssertThrowsError(try tree.perform(action(value),expected:forged)); XCTAssertEqual(backend.effects,[])
    }
    func testSuspendAgeRollbackAndExpiryDuringRefreshRefuseInput() async throws {
        for mode in ["expiry","rollback","refresh"] {
            let time=InspectionClock(), backend=AccessibilityFixture()
            let tree=GuestAccessibilityTree(backend:backend,clock:{ time.now() }), value=try tree.inspect()
            if mode == "expiry" { time.set(115) }
            if mode == "rollback" { time.set(99) }
            if mode == "refresh" { backend.onRead={ time.set(115) } }
            XCTAssertThrowsError(try tree.perform(action(value),expected:value)); XCTAssertEqual(backend.effects,[])
        }
    }
    func testFailedNativeDispatchCannotReuseSnapshot() async throws {
        let backend=AccessibilityFixture(), tree=GuestAccessibilityTree(backend:backend), value=try tree.inspect()
        backend.fail=true
        XCTAssertThrowsError(try tree.perform(action(value),expected:value))
        XCTAssertThrowsError(try tree.perform(action(value),expected:value)); XCTAssertEqual(backend.effects.count,1)
    }
    func testBridgeAuthenticationOriginAndQueryBeforeInspection() async throws {
        let guest=AccessibilityGuestFixture(snapshot:try snapshot())
        let bridge=try DesktopBridge(token:String(repeating:"t",count:43),device:guest,journalURL:directory().appendingPathComponent("input.json"))
        let bad=await bridge.handle(request(token:"wrong")); XCTAssertEqual(bad.status,401)
        let origin=await bridge.handle(request(origin:true)); XCTAssertEqual(origin.status,403)
        let query=await bridge.handle(request("/v1/accessibility?host=other")); XCTAssertEqual(query.status,409)
        let response=await bridge.handle(request()); XCTAssertEqual(response.status,200)
        try JSONDecoder().decode(GuestAccessibilitySnapshot.self,from:response.body).validate()
    }
    func testBridgeActionBindingRestartAndCrossProtocolIdentityConflicts() async throws {
        let value=try snapshot(), guest=AccessibilityGuestFixture(snapshot:value), journal=try directory().appendingPathComponent("input.json")
        let bridge=try DesktopBridge(token:String(repeating:"t",count:43),device:guest,journalURL:journal)
        let inspection=await bridge.handle(request()); XCTAssertEqual(inspection.status,200)
        let input=action(value), data=try JSONEncoder().encode(input)
        let posted=await bridge.handle(request("/v1/accessibility/action",body:data)); XCTAssertEqual(posted.status,200)
        let restarted=try DesktopBridge(token:String(repeating:"t",count:43),device:guest,journalURL:journal)
        let repeated=await restarted.handle(request("/v1/accessibility/action",body:data)); XCTAssertEqual(repeated.status,200)
        var changed=input; changed.nativeAction="AXShowMenu"
        let conflict=await restarted.handle(request("/v1/accessibility/action",body:try JSONEncoder().encode(changed))); XCTAssertEqual(conflict.status,409)
        let desktop=DesktopAction(id:input.id,frameID:UUID(),kind:.key,key:"return")
        let other=await restarted.handle(request("/v1/desktop/action",body:try JSONEncoder().encode(desktop))); XCTAssertEqual(other.status,409)
        let count=await guest.effects; XCTAssertEqual(count,1)
        let journalText=try String(contentsOf:journal,encoding:.utf8)
        XCTAssertFalse(journalText.contains("Continue")); XCTAssertFalse(journalText.contains("com.example.fixture"))
    }
    func testBridgeControlTakeoverExpiryAndReadOnlyInspection() async throws {
        let time=InspectionClock(), value=try snapshot(), guest=AccessibilityGuestFixture(snapshot:value)
        let bridge=try DesktopBridge(token:String(repeating:"t",count:43),device:guest,journalURL:directory().appendingPathComponent("input.json"),clock:{ time.now() })
        _=await bridge.handle(request())
        time.set(115)
        let expired=await bridge.handle(request("/v1/accessibility/action",body:try JSONEncoder().encode(action(value)))); XCTAssertEqual(expired.status,409)
        _=await bridge.handle(request("/v1/desktop/control",body:try JSONEncoder().encode(DesktopControlRequest(targetID:UUID(),userControl:true))))
        let inspection=await bridge.handle(request()); XCTAssertEqual(inspection.status,200)
        let current=try JSONDecoder().decode(GuestAccessibilitySnapshot.self,from:inspection.body)
        let blocked=await bridge.handle(request("/v1/accessibility/action",body:try JSONEncoder().encode(action(current)))); XCTAssertEqual(blocked.status,409)
        let posted=await bridge.handle(request("/v1/accessibility/action",body:try JSONEncoder().encode(action(current,human:true)))); XCTAssertEqual(posted.status,200)
        let count=await guest.effects; XCTAssertEqual(count,1)
    }
    func testUncertainBridgeDispatchNeverReplaysAfterRestart() async throws {
        let value=try snapshot(), guest=AccessibilityGuestFixture(snapshot:value), journal=try directory().appendingPathComponent("input.json")
        let bridge=try DesktopBridge(token:String(repeating:"t",count:43),device:guest,journalURL:journal)
        _=await bridge.handle(request()); await guest.failNext()
        let data=try JSONEncoder().encode(action(value))
        let failed=await bridge.handle(request("/v1/accessibility/action",body:data)); XCTAssertEqual(failed.status,409)
        let restarted=try DesktopBridge(token:String(repeating:"t",count:43),device:guest,journalURL:journal)
        let again=await restarted.handle(request("/v1/accessibility/action",body:data)); XCTAssertEqual(again.status,409)
        let count=await guest.effects; XCTAssertEqual(count,1)
    }
    func testLateInspectionIsDiscardedAfterInputGenerationChanges() async throws {
        let value=try snapshot(), guest=AccessibilityGuestFixture(snapshot:value)
        let bridge=try DesktopBridge(token:String(repeating:"t",count:43),device:guest,journalURL:directory().appendingPathComponent("input.json"))
        await guest.delay()
        let inspection=Task { await bridge.handle(request()) }
        for _ in 0..<100 { if await guest.waiting { break }; try await Task.sleep(for:.milliseconds(5)) }
        let waiting=await guest.waiting; XCTAssertTrue(waiting)
        _=await bridge.handle(request("/v1/desktop/control",body:try JSONEncoder().encode(DesktopControlRequest(targetID:UUID(),userControl:true))))
        await guest.resume(); let late=await inspection.value; XCTAssertEqual(late.status,409)
        let input=await bridge.handle(request("/v1/accessibility/action",body:try JSONEncoder().encode(action(value,human:true)))); XCTAssertEqual(input.status,409)
        let count=await guest.effects; XCTAssertEqual(count,0)
    }
    func testJournalFailureAndMalformedNativeActionsPrecedeAnyGuestEffect() async throws {
        let value=try snapshot(), guest=AccessibilityGuestFixture(snapshot:value), root=try directory(), journal=root.appendingPathComponent("input.json")
        let bridge=try DesktopBridge(token:String(repeating:"t",count:43),device:guest,journalURL:journal)
        _=await bridge.handle(request())
        let valid=action(value)
        var object=try XCTUnwrap(JSONSerialization.jsonObject(with:JSONEncoder().encode(valid)) as? [String:Any])
        object["hostPath"]="must-not-be-used"
        let malformed=await bridge.handle(request("/v1/accessibility/action",body:try JSONSerialization.data(withJSONObject:object)))
        XCTAssertEqual(malformed.status,409); XCTAssertFalse(FileManager.default.fileExists(atPath:journal.path))
        try FileManager.default.createDirectory(at:journal,withIntermediateDirectories:false)
        let failed=await bridge.handle(request("/v1/accessibility/action",body:try JSONEncoder().encode(valid)))
        XCTAssertEqual(failed.status,409); let count=await guest.effects; XCTAssertEqual(count,0)
    }
    func testReadOnlyAccessibilityDoesNotInvalidateAnIssuedDesktopFrame() async throws {
        let guest=AccessibilityGuestFixture(snapshot:try snapshot())
        let bridge=try DesktopBridge(token:String(repeating:"t",count:43),device:guest,journalURL:directory().appendingPathComponent("input.json"))
        let image=await bridge.handle(request("/v1/desktop"))
        let frame=try JSONDecoder().decode(DesktopFrame.self,from:image.body)
        _=await bridge.handle(request())
        let response=await bridge.handle(request("/v1/desktop/action",body:try JSONEncoder().encode(DesktopAction(frameID:frame.id,kind:.key,key:"return"))))
        XCTAssertEqual(response.status,200); let count=await guest.effects; XCTAssertEqual(count,1)
    }
    func testUncertainControlChangeBlocksInputAcrossRestartUntilConfirmed() async throws {
        let guest=AccessibilityGuestFixture(snapshot:try snapshot()), root=try directory(), journal=root.appendingPathComponent("input.json")
        let bridge=try DesktopBridge(token:String(repeating:"t",count:43),device:guest,journalURL:journal)
        let control=root.appendingPathComponent("control.json"), pending=root.appendingPathComponent("control-pending.json")
        try FileManager.default.createDirectory(at:control,withIntermediateDirectories:false)
        let change=try JSONEncoder().encode(DesktopControlRequest(targetID:UUID(),userControl:true))
        let failed=await bridge.handle(request("/v1/desktop/control",body:change)); XCTAssertEqual(failed.status,409)
        XCTAssertTrue(FileManager.default.fileExists(atPath:pending.path))
        try FileManager.default.removeItem(at:control)
        let restarted=try DesktopBridge(token:String(repeating:"t",count:43),device:guest,journalURL:journal)
        let response=await restarted.handle(request())
        let value=try JSONDecoder().decode(GuestAccessibilitySnapshot.self,from:response.body)
        let blocked=await restarted.handle(request("/v1/accessibility/action",body:try JSONEncoder().encode(action(value))))
        XCTAssertEqual(blocked.status,409); let before=await guest.effects; XCTAssertEqual(before,0)
        let confirmed=await restarted.handle(request("/v1/desktop/control",body:change)); XCTAssertEqual(confirmed.status,200)
        XCTAssertFalse(FileManager.default.fileExists(atPath:pending.path))
        let refreshed=await restarted.handle(request())
        let current=try JSONDecoder().decode(GuestAccessibilitySnapshot.self,from:refreshed.body)
        let posted=await restarted.handle(request("/v1/accessibility/action",body:try JSONEncoder().encode(action(current,human:true))))
        XCTAssertEqual(posted.status,200); let after=await guest.effects; XCTAssertEqual(after,1)
    }
}
