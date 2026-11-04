import XCTest
import Foundation
import CryptoKit
import CanaveralVMCore

private actor FilesDesktopFixture: GuestDesktopDevice {
    func capture() async throws -> DesktopFrame { throw CanaveralError.unavailable("Unused fixture display") }
    func perform(_ action: DesktopAction) async throws { throw CanaveralError.unavailable("Unused fixture input") }
}

@MainActor final class GuestFilesTests: XCTestCase {
    private var transcript: [JSONValue]?
    private func directory() throws -> URL {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralFiles-\(UUID())")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        addTeardownBlock { try? FileManager.default.removeItem(at:root) }; return root
    }
    private func service(_ root: URL, boundary: @escaping @Sendable (GuestFiles.Boundary) throws -> Void = { _ in }) throws -> GuestFiles {
        try GuestFiles(root:root.appendingPathComponent("drive"),state:root.appendingPathComponent("state"),permitted:{ true },boundary:boundary)
    }
    private func fixture() throws -> URL {
        let root=try directory(); try FileManager.default.createDirectory(at:root.appendingPathComponent("drive"),withIntermediateDirectories:true); return root
    }
    private func request(_ route: String, _ object: [String:JSONValue]) throws -> HTTPRequest {
        .init(method:"POST",target:"/v1/files/"+route,headers:[:],body:try JSONEncoder().encode(JSONValue.object(object)))
    }
    @discardableResult private func call(_ service: GuestFiles, _ route: String, _ object: [String:JSONValue]) async throws -> [String:JSONValue] {
        let response=try await service.handle(request(route,object)); XCTAssertEqual(response.status,200)
        let result=try XCTUnwrap(JSONDecoder().decode(JSONValue.self,from:response.body).object)
        if transcript != nil { transcript!.append(.object(["route":.string("/v1/files/"+route),"request":.object(object),"response":.object(result)])) }
        return result
    }
    private func identity(_ id: UUID) -> [String:JSONValue] { ["id":.string(id.uuidString)] }
    private func hash(_ data: Data) -> String { SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined() }
    private func begin(_ service: GuestFiles, id: UUID, path: String = "/target", size: Int) async throws {
        try await call(service,"upload/begin",["id":.string(id.uuidString),"path":.string(path),"size":.number(Double(size))])
    }
    private func write(_ service: GuestFiles, id: UUID, data: Data, offset: Int = 0) async throws {
        try await call(service,"upload/chunk",["id":.string(id.uuidString),"offset":.number(Double(offset)),"data":.string(data.base64EncodedString())])
    }
    private func finish(_ service: GuestFiles, id: UUID, data: Data) async throws -> [String:JSONValue] {
        try await call(service,"upload/finish",["id":.string(id.uuidString),"bytes":.number(Double(data.count)),"sha256":.string(hash(data))])
    }
    private func rejected(_ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected refusal",file:file,line:line) } catch {}
    }
    func testGuestGuardRunsBeforeAnyStateCreation() throws {
        let root=try directory(), state=root.appendingPathComponent("never-created")
        XCTAssertThrowsError(try GuestFiles(root:root,state:state,permitted:{ false }))
        XCTAssertFalse(FileManager.default.fileExists(atPath:state.path))
    }
    func testBridgeAuthenticatesAndRejectsBrowserBeforeFileDispatch() async throws {
        let root=try fixture(), files=try service(root), token=String(repeating:"t",count:43)
        let bridge=try DesktopBridge(token:token,device:FilesDesktopFixture(),journalURL:root.appendingPathComponent("inputs.json"),workspace:files)
        var query=try request("list",["path":.string("/")])
        var response=await bridge.handle(query); XCTAssertEqual(response.status,401)
        query.headers=["authorization":"Bearer "+token,"origin":"https://fixture.invalid"]
        response=await bridge.handle(query); XCTAssertEqual(response.status,403)
        query.headers.removeValue(forKey:"origin"); response=await bridge.handle(query); XCTAssertEqual(response.status,200)
    }
    func testBinaryChunksVerifyBeforeAtomicReplacementAndReplay() async throws {
        let root=try fixture(), files=try service(root), id=UUID(), target=root.appendingPathComponent("drive/target")
        let original=Data("original".utf8), data=Data((0..<(GuestFiles.chunkBytes+37)).map { UInt8($0 % 251) })
        try original.write(to:target); try await begin(files,id:id,size:data.count)
        try await write(files,id:id,data:Data(data.prefix(GuestFiles.chunkBytes)))
        try await write(files,id:id,data:Data(data.dropFirst(GuestFiles.chunkBytes)),offset:GuestFiles.chunkBytes)
        XCTAssertEqual(try Data(contentsOf:target),original)
        var result=try await finish(files,id:id,data:data); XCTAssertEqual(result["state"]?.string,"verifyingUpload")
        XCTAssertEqual(try Data(contentsOf:target),original)
        result=try await call(files,"upload/verify",identity(id)); XCTAssertEqual(result["state"]?.string,"committed")
        XCTAssertEqual(result["durable"],.bool(true)); XCTAssertEqual(try Data(contentsOf:target),data)
        result=try await finish(files,id:id,data:data); XCTAssertEqual(result["state"]?.string,"committed")
        await rejected { _=try await self.finish(files,id:id,data:original) }
        XCTAssertEqual(try Data(contentsOf:target),data)
    }
    func testEmptyFileAndLargeDeclaredUploadHaveNoFeatureSizeCap() async throws {
        let root=try fixture(), files=try service(root), id=UUID()
        try await begin(files,id:id,size:0)
        let result=try await finish(files,id:id,data:Data()); XCTAssertEqual(result["state"]?.string,"committed")
        XCTAssertEqual(try Data(contentsOf:root.appendingPathComponent("drive/target")),Data())
        let large=UUID(); try await begin(files,id:large,path:"/huge",size:1 << 40)
        let staging=root.appendingPathComponent("drive/.canaveral-upload-"+large.uuidString.lowercased())
        XCTAssertEqual(try Data(contentsOf:staging).count,0)
        try await call(files,"abort",identity(large)); XCTAssertFalse(FileManager.default.fileExists(atPath:staging.path))
    }
    func testMalformedLengthsOffsetsAndDigestsNeverPublish() async throws {
        let root=try fixture(), files=try service(root), id=UUID(), data=Data("abc".utf8)
        for number: JSONValue in [.bool(true),.number(-1),.number(1.5),.number(9007199254740992)] {
            await rejected { try await self.call(files,"upload/begin",["id":.string(UUID().uuidString),"path":.string("/bad"),"size":number]) }
        }
        try await begin(files,id:id,size:3)
        await rejected { try await self.write(files,id:id,data:data,offset:1) }
        await rejected { try await self.write(files,id:id,data:Data(repeating:1,count:GuestFiles.chunkBytes+1)) }
        try await write(files,id:id,data:data)
        await rejected { _=try await self.finish(files,id:id,data:Data("xyz".utf8)) }
        XCTAssertFalse(FileManager.default.fileExists(atPath:root.appendingPathComponent("drive/target").path))
        try await call(files,"abort",identity(id))
    }
    func testChangedBeginCannotReuseTransferIdentity() async throws {
        let root=try fixture(), files=try service(root), id=UUID()
        try await begin(files,id:id,size:3); try await begin(files,id:id,size:3)
        await rejected { try await self.begin(files,id:id,path:"/other",size:3) }
        await rejected { try await self.begin(files,id:id,size:4) }
    }
    func testForeignStagingReplacementNeitherPublishesNorDeletes() async throws {
        let root=try fixture(), files=try service(root), id=UUID(), data=Data("abc".utf8)
        try await begin(files,id:id,size:3); try await write(files,id:id,data:data)
        let staging=root.appendingPathComponent("drive/.canaveral-upload-"+id.uuidString.lowercased())
        try FileManager.default.moveItem(at:staging,to:root.appendingPathComponent("held-original"))
        try Data("foreign".utf8).write(to:staging)
        await rejected { _=try await self.finish(files,id:id,data:data) }
        await rejected { try await self.call(files,"abort",self.identity(id)) }
        XCTAssertEqual(try Data(contentsOf:staging),Data("foreign".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath:root.appendingPathComponent("drive/target").path))
    }
    func testInPlaceStagingMutationDuringVerificationIsRefused() async throws {
        let root=try fixture(), files=try service(root), id=UUID(), data=Data(repeating:7,count:GuestFiles.chunkBytes+1)
        try await begin(files,id:id,size:data.count)
        try await write(files,id:id,data:Data(data.prefix(GuestFiles.chunkBytes)))
        try await write(files,id:id,data:Data(data.suffix(1)),offset:GuestFiles.chunkBytes)
        _=try await finish(files,id:id,data:data)
        let staging=root.appendingPathComponent("drive/.canaveral-upload-"+id.uuidString.lowercased())
        let handle=try FileHandle(forWritingTo:staging); try handle.write(contentsOf:Data([8])); try handle.close()
        await rejected { try await self.call(files,"upload/verify",self.identity(id)) }
        XCTAssertFalse(FileManager.default.fileExists(atPath:root.appendingPathComponent("drive/target").path))
    }
    func testUncertainPublicationCannotReplayOrRemoveDestination() async throws {
        for after in [false,true] {
            let root=try fixture(), files=try service(root) { point in
                if (after && point == .afterPublish) || (!after && point == .beforePublish) { throw CanaveralError.interrupted }
            }, id=UUID(), data=Data("new".utf8), target=root.appendingPathComponent("drive/target")
            try Data("old".utf8).write(to:target); try await begin(files,id:id,size:3); try await write(files,id:id,data:data)
            await rejected { _=try await self.finish(files,id:id,data:data) }
            let restarted=try service(root)
            await rejected { _=try await self.finish(restarted,id:id,data:data) }
            await rejected { try await self.call(restarted,"abort",self.identity(id)) }
            let status=try await call(restarted,"status",identity(id)); XCTAssertEqual(status["state"]?.string,"publishing")
            XCTAssertEqual(try Data(contentsOf:target),after ? data : Data("old".utf8))
        }
    }
    func testRestartNeverResumesWritesAndCanCleanOnlyOwnedStage() async throws {
        let root=try fixture(), id=UUID()
        do { let files=try service(root); try await begin(files,id:id,size:3); try await write(files,id:id,data:Data([1])) }
        let files=try service(root)
        await rejected { try await self.begin(files,id:id,size:3) }
        await rejected { try await self.write(files,id:id,data:Data([2]),offset:1) }
        let result=try await call(files,"abort",identity(id)); XCTAssertEqual(result["state"]?.string,"aborted")
        XCTAssertFalse(FileManager.default.fileExists(atPath:root.appendingPathComponent("drive/.canaveral-upload-"+id.uuidString.lowercased()).path))
    }
    func testSymlinksWithinRootWorkAndEscapesAreRefused() async throws {
        let root=try fixture(), files=try service(root), drive=root.appendingPathComponent("drive")
        try FileManager.default.createDirectory(at:drive.appendingPathComponent("nested"),withIntermediateDirectories:true)
        try FileManager.default.createSymbolicLink(atPath:drive.appendingPathComponent("link").path,withDestinationPath:"nested")
        try FileManager.default.createSymbolicLink(atPath:drive.appendingPathComponent("escape").path,withDestinationPath:root.path)
        let id=UUID(); try await begin(files,id:id,path:"/link/file",size:0); _=try await finish(files,id:id,data:Data())
        XCTAssertTrue(FileManager.default.fileExists(atPath:drive.appendingPathComponent("nested/file").path))
        await rejected { try await self.begin(files,id:UUID(),path:"/escape/foreign",size:0) }
        await rejected { try await self.call(files,"list",["path":.string("/../")]) }
        let result=try await call(files,"list",["path":.string("/")])
        guard case .array(let entries)=result["entries"] else { return XCTFail("Missing entries") }
        XCTAssertTrue(entries.contains { $0.object?["name"]?.string == "escape" && $0.object?["kind"]?.string == "symlink" })
    }
    func testDownloadBinaryUsesBoundedSecondPassAndDurableReplay() async throws {
        let root=try fixture(), files=try service(root), id=UUID(), data=Data(repeating:192,count:GuestFiles.chunkBytes+13)
        try data.write(to:root.appendingPathComponent("drive/source"))
        try await call(files,"download/begin",["id":.string(id.uuidString),"path":.string("/source")])
        var received=Data()
        for offset in [0,GuestFiles.chunkBytes] {
            let result=try await call(files,"download/chunk",["id":.string(id.uuidString),"offset":.number(Double(offset))])
            received.append(try XCTUnwrap(Data(base64Encoded:try XCTUnwrap(result["data"]?.string))))
        }
        XCTAssertEqual(received,data)
        var result=try await call(files,"download/finish",identity(id)); XCTAssertEqual(result["state"]?.string,"verifying")
        result=try await call(files,"download/verify",identity(id)); XCTAssertEqual(result["state"]?.string,"verified"); XCTAssertEqual(result["sha256"]?.string,hash(data))
        let restarted=try service(root); result=try await call(restarted,"download/finish",identity(id)); XCTAssertEqual(result["state"]?.string,"verified")
    }
    func testDownloadRejectsReplacementMutationAndParentRebinding() async throws {
        for mode in ["replacement","mutation","parent"] {
            let root=try fixture(), files=try service(root), id=UUID(), drive=root.appendingPathComponent("drive"), folder=drive.appendingPathComponent("folder")
            try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
            let source=folder.appendingPathComponent("source"), data=Data("same".utf8); try data.write(to:source)
            try await call(files,"download/begin",["id":.string(id.uuidString),"path":.string("/folder/source")])
            try await call(files,"download/chunk",["id":.string(id.uuidString),"offset":.number(0)])
            if mode == "replacement" { try FileManager.default.moveItem(at:source,to:drive.appendingPathComponent("held")); try data.write(to:source) }
            if mode == "mutation" { let handle=try FileHandle(forWritingTo:source); try handle.write(contentsOf:Data("diff".utf8)); try handle.close() }
            if mode == "parent" { try FileManager.default.moveItem(at:folder,to:drive.appendingPathComponent("old")); try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true); try data.write(to:source) }
            await rejected { try await self.call(files,"download/finish",self.identity(id)) }
        }
    }
    func testEmptyDownloadAndNonregularSources() async throws {
        let root=try fixture(), files=try service(root), id=UUID(); try Data().write(to:root.appendingPathComponent("drive/empty"))
        try await call(files,"download/begin",["id":.string(id.uuidString),"path":.string("/empty")])
        let result=try await call(files,"download/finish",identity(id)); XCTAssertEqual(result["sha256"]?.string,hash(Data()))
        await rejected { try await self.call(files,"download/begin",["id":.string(UUID().uuidString),"path":.string("/")]) }
    }
    func testRenamedParentCanOnlyCleanItsOriginalPinnedStage() async throws {
        let root=try fixture(), files=try service(root), id=UUID(), drive=root.appendingPathComponent("drive")
        let original=drive.appendingPathComponent("folder"), moved=drive.appendingPathComponent("moved")
        try FileManager.default.createDirectory(at:original,withIntermediateDirectories:true)
        try await begin(files,id:id,path:"/folder/target",size:3); try await write(files,id:id,data:Data("abc".utf8))
        try FileManager.default.moveItem(at:original,to:moved)
        try FileManager.default.createDirectory(at:original,withIntermediateDirectories:true)
        let stage=".canaveral-upload-"+id.uuidString.lowercased()
        try Data("foreign".utf8).write(to:original.appendingPathComponent(stage))
        await rejected { _=try await self.finish(files,id:id,data:Data("abc".utf8)) }
        try await call(files,"abort",identity(id))
        XCTAssertFalse(FileManager.default.fileExists(atPath:moved.appendingPathComponent(stage).path))
        XCTAssertEqual(try Data(contentsOf:original.appendingPathComponent(stage)),Data("foreign".utf8))
    }
    func testRestartDoesNotCleanReboundParentOrForeignReceipt() async throws {
        let root=try fixture(), id=UUID(), drive=root.appendingPathComponent("drive"), folder=drive.appendingPathComponent("folder")
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        do { let files=try service(root); try await begin(files,id:id,path:"/folder/target",size:0) }
        try FileManager.default.moveItem(at:folder,to:drive.appendingPathComponent("moved"))
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        let stage=folder.appendingPathComponent(".canaveral-upload-"+id.uuidString.lowercased()); try Data("foreign".utf8).write(to:stage)
        let files=try service(root)
        await rejected { try await self.call(files,"abort",self.identity(id)) }
        XCTAssertEqual(try Data(contentsOf:stage),Data("foreign".utf8))
        let receipt=root.appendingPathComponent("state/"+id.uuidString.lowercased()+".json")
        try FileManager.default.removeItem(at:receipt)
        try FileManager.default.createSymbolicLink(at:receipt,withDestinationURL:stage)
        await rejected { try await self.call(files,"abort",self.identity(id)) }
        XCTAssertEqual(try Data(contentsOf:stage),Data("foreign".utf8))
    }
    func testPublicationBoundaryReplacementRemainsUncertain() async throws {
        let root=try fixture(), id=UUID(), data=Data("abc".utf8)
        let stage=root.appendingPathComponent("drive/.canaveral-upload-"+id.uuidString.lowercased())
        let files=try service(root) { boundary in
            if boundary == .beforePublish {
                try FileManager.default.moveItem(at:stage,to:root.appendingPathComponent("held"))
                try Data("foreign".utf8).write(to:stage)
            }
        }
        try await begin(files,id:id,size:3); try await write(files,id:id,data:data)
        await rejected { _=try await self.finish(files,id:id,data:data) }
        let status=try await call(files,"status",identity(id)); XCTAssertEqual(status["state"]?.string,"publishing")
        XCTAssertFalse(FileManager.default.fileExists(atPath:root.appendingPathComponent("drive/target").path))
        await rejected { try await self.call(files,"abort",self.identity(id)) }
    }
    func testHardLinkedStageCannotAcknowledgeAmbiguousRename() async throws {
        let root=try fixture(), files=try service(root), id=UUID()
        try await begin(files,id:id,size:0)
        let stage=root.appendingPathComponent("drive/.canaveral-upload-"+id.uuidString.lowercased())
        try FileManager.default.linkItem(at:stage,to:root.appendingPathComponent("drive/target"))
        await rejected { _=try await self.finish(files,id:id,data:Data()) }
        XCTAssertTrue(FileManager.default.fileExists(atPath:stage.path))
    }
    func testStrictRequestShapeAndQueryAreRejected() async throws {
        let root=try fixture(), files=try service(root)
        for path in ["/v1/files/list?path=/", "/v1/files/list"] {
            var query=try request("list",["path":.string("/"),"extra":.bool(true)]); query.target=path
            await rejected { _=try await files.handle(query) }
        }
        var query=try request("list",["path":.string("/")]); query.method="GET"
        let invalid=query; await rejected { _=try await files.handle(invalid) }
    }

    func testSharedAdapterWireTranscript() async throws {
        let root=try fixture(), files=try service(root)
        let upload=UUID(uuidString:"10101010-1010-4010-8010-101010101010")!, download=UUID(uuidString:"20202020-2020-4020-8020-202020202020")!
        let data=Data((0..<(GuestFiles.chunkBytes+37)).map { UInt8($0 % 251) })
        transcript=[]
        try await begin(files,id:upload,size:data.count)
        try await write(files,id:upload,data:Data(data.prefix(GuestFiles.chunkBytes)))
        try await write(files,id:upload,data:Data(data.dropFirst(GuestFiles.chunkBytes)),offset:GuestFiles.chunkBytes)
        _=try await finish(files,id:upload,data:data)
        try await call(files,"upload/verify",identity(upload))
        try await call(files,"download/begin",["id":.string(download.uuidString),"path":.string("/target")])
        try await call(files,"download/check",identity(download))
        try await call(files,"download/chunk",["id":.string(download.uuidString),"offset":.number(0)])
        try await call(files,"download/chunk",["id":.string(download.uuidString),"offset":.number(Double(GuestFiles.chunkBytes))])
        try await call(files,"download/finish",identity(download))
        try await call(files,"download/verify",identity(download))
        XCTAssertEqual(transcript?.count,11)
        if let output=ProcessInfo.processInfo.environment["CANAVERAL_FILE_FIXTURE_OUTPUT"] {
            try JSONEncoder().encode(JSONValue.object(["format":.string("canaveral-native-file-transcript-v1"),"events":.array(transcript!),"bytes":.number(Double(data.count)),"sha256":.string(hash(data))])).write(to:URL(fileURLWithPath:output),options:.atomic)
        }
        transcript=nil
    }
    func testRetargetedSymlinkCannotVerifyOldDownload() async throws {
        let root=try fixture(), files=try service(root), drive=root.appendingPathComponent("drive"), id=UUID()
        try Data("same".utf8).write(to:drive.appendingPathComponent("first")); try Data("same".utf8).write(to:drive.appendingPathComponent("second"))
        let link=drive.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(atPath:link.path,withDestinationPath:"first")
        try await call(files,"download/begin",["id":.string(id.uuidString),"path":.string("/alias")])
        try await call(files,"download/chunk",["id":.string(id.uuidString),"offset":.number(0)])
        try FileManager.default.removeItem(at:link); try FileManager.default.createSymbolicLink(atPath:link.path,withDestinationPath:"second")
        await rejected { try await self.call(files,"download/finish",self.identity(id)) }
    }

}
