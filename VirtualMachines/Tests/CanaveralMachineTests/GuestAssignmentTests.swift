import XCTest
import Foundation
import CanaveralVMCore

private actor BindingWorkspace: GuestWorkspaceService {
    var count=0
    func handle(_ request: HTTPRequest) async throws -> HTTPResponse { count+=1; return try .json(["ok":true]) }
}
private struct BindingDevice: GuestDesktopDevice {
    func capture() async throws -> DesktopFrame { throw CanaveralError.interrupted }
    func perform(_ action: DesktopAction) async throws { XCTFail("Unexpected device delegation") }
}
@MainActor final class GuestAssignmentTests: XCTestCase {
    private func vector() throws -> [String:Any] {
        let url=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("fixtures/guest-binding-v2.json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with:Data(contentsOf:url)) as? [String:Any])
    }
    func testSharedGoldenVectorsAndStrictTuple() throws {
        let v=try vector(), raw=try XCTUnwrap(v["assignment"] as? [String:Any])
        let context=try GuestAssignmentContext(data:JSONSerialization.data(withJSONObject:raw))
        for item in try XCTUnwrap(v["vectors"] as? [[String:String]]) {
            let purpose=GuestAssignmentContext.Purpose(rawValue:item["kind"]!)!
            let incarnation=purpose == .identityRequest ? nil : v["incarnation"] as? String
            let nonce=purpose == .request ? nil : v["nonce"] as? String
            let bytes=try context.canonicalBytes(purpose:purpose,nonce:nonce,incarnation:incarnation)
            XCTAssertEqual(String(data:bytes,encoding:.utf8),item["canonical"])
            XCTAssertEqual(bytes.map { String(format:"%02x",$0) }.joined(),item["hex"])
            XCTAssertEqual(try context.mac(credential:v["credential"] as! String,purpose:purpose,nonce:nonce,incarnation:incarnation),item["mac"])
            if let auth=item["authorization"] { XCTAssertEqual(try context.authorization(credential:v["credential"] as! String,incarnation:incarnation,nonce:nonce),auth) }
        }
        for key in ["machineId","leaseId","launchId","fingerprint"] {
            var bad=raw; bad[key]=(raw[key] as! String)+"\n"
            XCTAssertThrowsError(try GuestAssignmentContext(data:JSONSerialization.data(withJSONObject:bad)))
        }
        for (key,value) in [("version",true as Any),("extra",1),("machineId","ABC"),("leaseId","ABC"),("launchId","ABC"),("fingerprint","ABC")] {
            var bad=raw; bad[key]=value
            XCTAssertThrowsError(try GuestAssignmentContext(data:JSONSerialization.data(withJSONObject:bad)))
        }
    }
    func testActualIdentityProducerMatchesSharedDTO() throws {
        let v=try vector(), raw=v["assignment"] as! [String:Any]
        let context=try GuestAssignmentContext(data:JSONSerialization.data(withJSONObject:raw))
        let response=try HTTPResponse.json(context.identity(credential:v["credential"] as! String,nonce:v["nonce"] as! String,incarnation:v["incarnation"] as! String))
        let actual=try JSONSerialization.jsonObject(with:response.body) as! NSDictionary
        XCTAssertEqual(actual,v["response"] as! NSDictionary)
        XCTAssertLessThanOrEqual(response.body.count,4096)
        if let output=ProcessInfo.processInfo.environment["CANAVERAL_IDENTITY_DTO"] { try response.body.write(to:URL(fileURLWithPath:output)) }
    }
    func testBoundCredentialShapePreservesLegacyCompatibility() throws {
        let v=try vector(), raw=v["assignment"] as! [String:Any]
        let context=try GuestAssignmentContext(data:JSONSerialization.data(withJSONObject:raw))
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("Binding-Credentials-\(UUID())")
        defer { try? FileManager.default.removeItem(at:root) }
        for token in [String(repeating:"a",count:31),String(repeating:"a",count:4097),String(repeating:"é",count:32),String(repeating:"a",count:31)+" ",String(repeating:"a",count:32)+"\n"] {
            XCTAssertThrowsError(try DesktopBridge(token:token,device:BindingDevice(),journalURL:root.appendingPathComponent("rejected/receipts.json"),assignment:context))
        }
        for count in [32,4096] {
            _ = try DesktopBridge(token:String(repeating:"a",count:count),device:BindingDevice(),journalURL:root.appendingPathComponent("accepted-\(count)/receipts.json"),assignment:context)
        }
        _ = try DesktopBridge(token:String(repeating:"é",count:32),device:BindingDevice(),journalURL:root.appendingPathComponent("legacy/receipts.json"))
    }
    func testRealBridgeFencesBeforeWorkspaceDelegation() async throws {
        let v=try vector(), raw=v["assignment"] as! [String:Any], token=v["credential"] as! String
        let context=try GuestAssignmentContext(data:JSONSerialization.data(withJSONObject:raw))
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("Binding-\(UUID())")
        defer { try? FileManager.default.removeItem(at:root) }
        let workspace=BindingWorkspace()
        let bridge=try DesktopBridge(token:token,device:BindingDevice(),journalURL:root.appendingPathComponent("first/receipts.json"),workspace:workspace,assignment:context)
        func request(_ auth: String, target: String = "/v1/files/list", method: String = "POST", body: Data = Data("{}".utf8)) -> HTTPRequest {
            .init(method:method,target:target,headers:["authorization":auth],body:body)
        }
        let nonce=v["nonce"] as! String
        let identityAuth=try context.authorization(credential:token,nonce:nonce)
        let identity=await bridge.handle(request(identityAuth,target:"/v1/identity",method:"GET",body:Data()))
        XCTAssertEqual(identity.status,200); XCTAssertLessThanOrEqual(identity.body.count,4096)
        let fields=try XCTUnwrap(JSONSerialization.jsonObject(with:identity.body) as? [String:Any])
        XCTAssertEqual(Set(fields.keys),["version","machineId","leaseId","fingerprint","launchId","incarnation","nonce","proof"])
        XCTAssertEqual(fields["version"] as? Int,1)
        for key in ["machineId","leaseId","fingerprint","launchId"] { XCTAssertEqual(fields[key] as? String,raw[key] as? String) }
        let incarnation=try XCTUnwrap(fields["incarnation"] as? String)
        XCTAssertTrue(GuestAssignmentContext.canonicalUUID(incarnation))
        XCTAssertEqual(fields["nonce"] as? String,nonce)
        XCTAssertEqual(fields["proof"] as? String,try context.mac(credential:token,purpose:.identityResponse,nonce:nonce,incarnation:incarnation))
        let auth=try context.authorization(credential:token,incarnation:incarnation)
        let historicalURL=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("fixtures/guest-binding-v1.json")
        let historical=try JSONSerialization.jsonObject(with:Data(contentsOf:historicalURL)) as! [String:Any]
        let oldHeaders=(historical["vectors"] as! [[String:String]]).map { $0["authorization"]! }
        var refusals=oldHeaders + ["Bearer "+token,identityAuth,"Canaveral-Binding-v2 " + String(repeating:"A",count:43),try context.authorization(credential:String(repeating:"x",count:32),incarnation:incarnation),try context.authorization(credential:token,incarnation:UUID().uuidString.lowercased())]
        for key in ["machineId","leaseId","fingerprint","launchId"] {
            var changed=raw; changed[key]=key == "fingerprint" ? String(repeating:"f",count:64) : UUID().uuidString.lowercased()
            let wrong=try GuestAssignmentContext(data:JSONSerialization.data(withJSONObject:changed))
            refusals.append(try wrong.authorization(credential:token,incarnation:incarnation))
        }
        for refusal in refusals { let response=await bridge.handle(request(refusal)); XCTAssertEqual(response.status,401) }
        for malformed in [request(identityAuth,target:"/v1/identity?x",method:"GET",body:Data()),request(identityAuth,target:"/v1/identity"),request(auth,target:"/v1/identity",method:"GET",body:Data())] {
            let response=await bridge.handle(malformed); XCTAssertNotEqual(response.status,200)
        }
        for bad in oldHeaders + [identityAuth+"=",identityAuth.replacingOccurrences(of:nonce,with:String(repeating:"A",count:42)+"B"),identityAuth.replacingOccurrences(of:nonce,with:String(repeating:"A",count:5000)),identityAuth.replacingOccurrences(of:"v2",with:"v1"),try context.authorization(credential:String(repeating:"x",count:32),nonce:nonce)] {
            let response=await bridge.handle(request(bad,target:"/v1/identity",method:"GET",body:Data())); XCTAssertEqual(response.status,401)
        }
        let before=await workspace.count; XCTAssertEqual(before,0)
        let accepted=await bridge.handle(request(auth)); XCTAssertEqual(accepted.status,200)
        let count=await workspace.count; XCTAssertEqual(count,1)
        let restarted=try DesktopBridge(token:token,device:BindingDevice(),journalURL:root.appendingPathComponent("second/receipts.json"),workspace:workspace,assignment:context)
        let restartResponse=await restarted.handle(request(auth)); XCTAssertEqual(restartResponse.status,401)
        let legacy=try DesktopBridge(token:token,device:BindingDevice(),journalURL:root.appendingPathComponent("legacy/receipts.json"),workspace:workspace)
        let legacyResponse=await legacy.handle(request(auth)); XCTAssertEqual(legacyResponse.status,401)
        let finalCount=await workspace.count; XCTAssertEqual(finalCount,1)
        let manual=await legacy.handle(request("Bearer "+token)); XCTAssertEqual(manual.status,200)
    }
}
