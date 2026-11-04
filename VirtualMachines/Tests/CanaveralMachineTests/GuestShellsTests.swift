import XCTest
import Foundation
import Darwin
import CanaveralVMCore

private final class ShellFixture: GuestPTY, @unchecked Sendable {
    private let lock=NSLock()
    private var input=Data(), sizes: [(UInt16,UInt16)]=[]
    private var stopped=false, failed=false
    private var stopSucceeds=true
    func stopResult(_ result: Bool) { lock.lock(); stopSucceeds=result; lock.unlock() }
    func write(_ data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard !stopped else { throw CanaveralError.interrupted }
        input.append(data)
        if failed { throw CanaveralError.interrupted }
    }
    func resize(columns: UInt16, rows: UInt16) throws { lock.lock(); sizes.append((columns,rows)); lock.unlock() }
    func output(offset: Int64) throws -> GuestPTYOutput {
        lock.lock(); defer { lock.unlock() }
        return .init(data:Data(input.dropFirst(Int(offset))),offset:Int64(input.count),truncated:false,exited:stopped,exitCode:stopped ? 0 : nil)
    }
    func stop() throws -> Bool { lock.lock(); defer { lock.unlock() }; stopped=stopSucceeds; return stopped }
    func isStopped() -> Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func failInput() { lock.lock(); failed=true; lock.unlock() }
}
private final class ShellFactory: @unchecked Sendable {
    private let lock=NSLock()
    private var terminals: [ShellFixture]=[]
    func open(_ columns: UInt16, _ rows: UInt16) -> any GuestPTY {
        lock.lock(); defer { lock.unlock() }; let value=ShellFixture(); terminals.append(value); return value
    }
    func all() -> [ShellFixture] { lock.lock(); defer { lock.unlock() }; return terminals }
}
private actor ShellDesktopFixture: GuestDesktopDevice {
    func capture() async throws -> DesktopFrame { throw CanaveralError.interrupted }
    func perform(_ action: DesktopAction) async throws { throw CanaveralError.interrupted }
}

@MainActor final class GuestShellsTests: XCTestCase {
    private var transcript: [JSONValue]?
    private func directory() throws -> URL {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("CanaveralPTY-\(UUID())")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        addTeardownBlock { try? FileManager.default.removeItem(at:root) }; return root
    }
    private func request(_ route: String, _ values: [String:JSONValue]) throws -> HTTPRequest {
        .init(method:"POST",target:"/v1/shell/"+route,headers:[:],body:try JSONEncoder().encode(JSONValue.object(values)))
    }
    @discardableResult private func call(_ shells: GuestShells, _ route: String, _ values: [String:JSONValue]) async throws -> [String:JSONValue] {
        let response=try await shells.handle(request(route,values)); XCTAssertEqual(response.status,200)
        let result=try XCTUnwrap(JSONDecoder().decode(JSONValue.self,from:response.body).object)
        if transcript != nil { transcript!.append(.object(["route":.string("/v1/shell/"+route),"request":.object(values),"response":.object(result)])) }
        return result
    }
    private func identity(_ id: UUID) -> [String:JSONValue] { ["session":.string(id.uuidString)] }
    private func open(_ shells: GuestShells, _ id: UUID, columns: Int = 80) async throws {
        try await call(shells,"open",["session":.string(id.uuidString),"cols":.number(Double(columns)),"rows":.number(24)])
    }
    private func rejected(_ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected refusal",file:file,line:line) } catch {}
    }
    func testGuardRefusesBeforeJournalOrFactory() throws {
        let root=try directory(), state=root.appendingPathComponent("not-created")
        XCTAssertThrowsError(try GuestShells(state:state,permitted:{ false }) { _,_ in throw CanaveralError.interrupted })
        XCTAssertFalse(FileManager.default.fileExists(atPath:state.path))
        XCTAssertThrowsError(try GuestNativePTY(directory:root,argv:["/bin/sh"],environment:[:],columns:80,rows:24,permitted:{ false }))
    }
    func testNineIndependentShellsWithoutCountCap() async throws {
        let root=try directory(), factory=ShellFactory(), shells=try GuestShells(state:root,permitted:{ true },factory:factory.open)
        var ids: [UUID]=[]
        for index in 0..<9 {
            let id=UUID(); ids.append(id); try await open(shells,id)
            try await call(shells,"write",["session":.string(id.uuidString),"text":.string("session \(index)\n")])
            try await call(shells,"resize",["session":.string(id.uuidString),"cols":.number(Double(90+index)),"rows":.number(30)])
        }
        XCTAssertEqual(factory.all().count,9)
        try await call(shells,"close",identity(ids[0])); XCTAssertTrue(factory.all()[0].isStopped())
        for (index,id) in ids.dropFirst().enumerated() {
            let result=try await call(shells,"read",["session":.string(id.uuidString),"offset":.number(0)])
            XCTAssertEqual(Data(base64Encoded:try XCTUnwrap(result["data"]?.string)),Data("session \(index+1)\n".utf8))
            XCTAssertFalse(factory.all()[index+1].isStopped())
        }
        let revoked=await shells.revoke(); XCTAssertTrue(revoked); XCTAssertTrue(factory.all().allSatisfy { $0.isStopped() })
        await rejected { try await self.open(shells,UUID()) }
    }
    func testDuplicateOpenDoesNotLaunchTwiceAndChangedArgumentsConflict() async throws {
        let factory=ShellFactory(), shells=try GuestShells(state:directory(),permitted:{ true },factory:factory.open), id=UUID()
        try await open(shells,id); try await open(shells,id); XCTAssertEqual(factory.all().count,1)
        await rejected { try await self.open(shells,id,columns:81) }
        try await call(shells,"close",identity(id)); try await call(shells,"close",identity(id))
        await rejected { try await self.open(shells,id) }; XCTAssertEqual(factory.all().count,1)
    }
    func testRestartNeverResumesOrSignalsRecoveredProcessIdentity() async throws {
        let state=try directory(), factory=ShellFactory(), first=try GuestShells(state:state,permitted:{ true },factory:factory.open), id=UUID()
        try await open(first,id)
        let second=try GuestShells(state:state,permitted:{ true },factory:factory.open)
        await rejected { try await self.open(second,id) }
        await rejected { try await self.call(second,"close",self.identity(id)) }
        await rejected { try await self.call(second,"read",["session":.string(id.uuidString),"offset":.number(0)]) }
        XCTAssertEqual(factory.all().count,1); XCTAssertFalse(factory.all()[0].isStopped())
        try await call(first,"close",identity(id))
    }
    func testFailedFactoryKeepsDurableIdentityAndCannotAutomaticallyRelaunch() async throws {
        let state=try directory(), factory=ShellFactory(), id=UUID()
        let first=try GuestShells(state:state,permitted:{ true }) { _,_ in throw CanaveralError.interrupted }
        await rejected { try await self.open(first,id) }
        let second=try GuestShells(state:state,permitted:{ true },factory:factory.open)
        await rejected { try await self.open(second,id) }; XCTAssertEqual(factory.all().count,0)
    }
    func testReceiptSymlinkNeverLaunchesOrRemovesForeignData() async throws {
        let root=try directory(), factory=ShellFactory(), id=UUID(), foreign=root.appendingPathComponent("foreign")
        try Data("foreign".utf8).write(to:foreign)
        try FileManager.default.createSymbolicLink(at:root.appendingPathComponent(id.uuidString.lowercased()+".json"),withDestinationURL:foreign)
        let shells=try GuestShells(state:root,permitted:{ true },factory:factory.open)
        await rejected { try await self.open(shells,id) }; XCTAssertTrue(factory.all().isEmpty)
        XCTAssertEqual(try Data(contentsOf:foreign),Data("foreign".utf8))
    }
    func testInvalidInputsAreRefusedBeforeNativeEffect() async throws {
        let factory=ShellFactory(), shells=try GuestShells(state:directory(),permitted:{ true },factory:factory.open), id=UUID()
        for value: JSONValue in [.bool(true),.number(0),.number(501),.number(1.5)] {
            await rejected { try await self.call(shells,"open",["session":.string(id.uuidString),"cols":value,"rows":.number(24)]) }
        }
        XCTAssertTrue(factory.all().isEmpty); try await open(shells,id)
        for text in ["\0","x".padding(toLength:17000,withPad:"x",startingAt:0)] {
            await rejected { try await self.call(shells,"write",["session":.string(id.uuidString),"text":.string(text)]) }
        }
        await rejected { try await self.call(shells,"read",["session":.string(id.uuidString),"offset":.bool(true)]) }
        let result=try await call(shells,"read",["session":.string(id.uuidString),"offset":.number(0)]); XCTAssertEqual(result["data"]?.string,"")
        try await call(shells,"close",identity(id))
    }
    func testUncertainWriteIsNeverAutomaticallyReplayed() async throws {
        let factory=ShellFactory(), shells=try GuestShells(state:directory(),permitted:{ true },factory:factory.open), id=UUID()
        try await open(shells,id); factory.all()[0].failInput()
        await rejected { try await self.call(shells,"write",["session":.string(id.uuidString),"text":.string("one command\n")]) }
        let result=try await call(shells,"read",["session":.string(id.uuidString),"offset":.number(0)])
        XCTAssertEqual(Data(base64Encoded:try XCTUnwrap(result["data"]?.string)),Data("one command\n".utf8))
        try await call(shells,"close",identity(id))
    }
    func testBridgeRequiresCredentialAndRejectsBrowserForShells() async throws {
        let root=try directory(), factory=ShellFactory(), shells=try GuestShells(state:root.appendingPathComponent("shells"),permitted:{ true },factory:factory.open)
        let token=String(repeating:"t",count:43), bridge=try DesktopBridge(token:token,device:ShellDesktopFixture(),journalURL:root.appendingPathComponent("input.json"),workspace:shells), id=UUID()
        var query=try request("open",["session":.string(id.uuidString),"cols":.number(80),"rows":.number(24)])
        var response=await bridge.handle(query); XCTAssertEqual(response.status,401)
        query.headers=["authorization":"Bearer "+token,"origin":"https://fixture.invalid"]
        response=await bridge.handle(query); XCTAssertEqual(response.status,403); XCTAssertTrue(factory.all().isEmpty)
        query.headers.removeValue(forKey:"origin"); response=await bridge.handle(query); XCTAssertEqual(response.status,200)
        try await call(shells,"close",identity(id))
    }
    func testUnconfirmedStopRetainsOwnershipAndCanBeRetriedAfterBatchFence() async throws {
        let state=try directory(), factory=ShellFactory(), shells=try GuestShells(state:state,permitted:{ true },factory:factory.open)
        let first=UUID(), second=UUID(); try await open(shells,first); try await open(shells,second)
        factory.all()[0].stopResult(false)
        var result=await shells.revoke(); XCTAssertFalse(result)
        XCTAssertFalse(factory.all()[0].isStopped()); XCTAssertTrue(factory.all()[1].isStopped())
        let journal=try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:state.appendingPathComponent(first.uuidString.lowercased()+".json")))
        XCTAssertEqual(journal.object?["state"]?.string,"closing")
        await rejected { try await self.call(shells,"write",["session":.string(first.uuidString),"text":.string("must not run")]) }
        factory.all()[0].stopResult(true); result=await shells.revoke(); XCTAssertTrue(result)
        XCTAssertTrue(factory.all().allSatisfy { $0.isStopped() })
    }
    func testJournalFailureStillStopsOwnedTerminalButCannotConfirmDurableClose() async throws {
        let state=try directory(), factory=ShellFactory(), shells=try GuestShells(state:state,permitted:{ true },factory:factory.open), id=UUID()
        try await open(shells,id)
        let journal=state.appendingPathComponent(id.uuidString.lowercased()+".json")
        try FileManager.default.removeItem(at:journal); try FileManager.default.createDirectory(at:journal,withIntermediateDirectories:false)
        await rejected { try await self.call(shells,"close",self.identity(id)) }
        XCTAssertTrue(factory.all()[0].isStopped())
        try FileManager.default.removeItem(at:journal)
        let result=try await call(shells,"close",identity(id)); XCTAssertEqual(result["closed"],.bool(true))
    }
    func testDurableStartingReceiptPrecedesFactoryLaunch() async throws {
        let state=try directory(), id=UUID()
        let shells=try GuestShells(state:state,permitted:{ true }) { _,_ in
            let path=state.appendingPathComponent(id.uuidString.lowercased()+".json")
            let record=try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:path))
            guard record.object?["state"]?.string == "starting" else { throw CanaveralError.invalid("Missing durable identity") }
            return ShellFixture()
        }
        try await open(shells,id); try await call(shells,"close",identity(id))
    }
    func testSharedTerminalAdapterTranscript() async throws {
        let factory=ShellFactory(), shells=try GuestShells(state:directory(),permitted:{ true },factory:factory.open)
        let id=UUID(uuidString:"30303030-3030-4030-8030-303030303030")!
        transcript=[]; try await open(shells,id)
        try await call(shells,"resize",["session":.string(id.uuidString),"cols":.number(120),"rows":.number(40)])
        try await call(shells,"write",["session":.string(id.uuidString),"text":.string("printf 'terminal fixture'\n")])
        try await call(shells,"read",["session":.string(id.uuidString),"offset":.number(0)])
        try await call(shells,"close",identity(id))
        if let output=ProcessInfo.processInfo.environment["CANAVERAL_PTY_FIXTURE_OUTPUT"] {
            try JSONEncoder().encode(JSONValue.object(["format":.string("canaveral-native-pty-transcript-v1"),"events":.array(transcript!)])).write(to:URL(fileURLWithPath:output),options:.atomic)
        }
        transcript=nil
    }
    private func native(_ root: URL) throws -> GuestNativePTY {
        let terminal=try GuestNativePTY(directory:root,argv:["/bin/sh","-i"],environment:["HOME":root.path,"PATH":"/usr/bin:/bin","TERM":"xterm-256color","LANG":"C","TMPDIR":root.path],columns:80,rows:24,permitted:{ true })
        addTeardownBlock {
            for _ in 0..<100 { if (try? terminal.stop()) == true { return }; try await Task.sleep(for:.milliseconds(10)) }
            XCTFail("Disposable PTY did not confirm direct-child cleanup")
        }
        return terminal
    }
    private func collect(_ terminal: GuestNativePTY, contains marker: String, offset: Int64 = 0) async throws -> GuestPTYOutput {
        let end=NativeLeaseClock.now()+3
        repeat {
            let output=try terminal.output(offset:offset)
            if String(decoding:output.data,as:UTF8.self).contains(marker) { return output }
            try await Task.sleep(for:.milliseconds(10))
        } while NativeLeaseClock.now() < end
        throw CanaveralError.unavailable("Disposable PTY output did not contain expected marker: \(marker)")
    }
    func testNineNativePTYsKeepEnvironmentInputAndCloseIndependent() async throws {
        var terminals: [GuestNativePTY]=[]
        for index in 0..<9 {
            let terminal=try native(directory()); terminals.append(terminal)
            try terminal.write(Data("value=\(index); stty -echo; printf '\\164\\145\\162\\155\\055%s\\n' \"$value\"\n".utf8))
        }
        for (index,terminal) in terminals.enumerated() {
            let result=try await collect(terminal,contains:"term-\(index)")
            for other in 0..<9 where other != index { XCTAssertFalse(String(decoding:result.data,as:UTF8.self).contains("term-\(other)")) }
        }
        for _ in 0..<100 { if try terminals[0].stop() { break }; try await Task.sleep(for:.milliseconds(10)) }
        XCTAssertTrue(try terminals[0].stop())
        for (index,terminal) in terminals.dropFirst().enumerated() {
            let before=try terminal.output(offset:0)
            try terminal.write(Data("printf '\\141\\147\\141\\151\\156\\055%s\\n' \"$value\"\n".utf8))
            _=try await collect(terminal,contains:"again-\(index+1)",offset:before.offset)
        }
    }
    func testNativePTYHasControllingTerminalResizeAndKeyboardInterrupt() async throws {
        let terminal=try native(directory())
        try terminal.write(Data("stty -echo; printf '\\120\\124\\131\\117\\113\\n'; ( : </dev/tty ) && printf '\\103\\124\\124\\131\\n'\n".utf8))
        let ready=try await collect(terminal,contains:"CTTY")
        XCTAssertTrue(String(decoding:ready.data,as:UTF8.self).contains("PTYOK"))
        XCTAssertFalse(String(decoding:ready.data,as:UTF8.self).contains("no job control"))
        try terminal.resize(columns:123,rows:37)
        try terminal.write(Data("stty size; /bin/sh -c 'printf RUNNING; sleep 30'\n".utf8))
        let resized=try await collect(terminal,contains:"RUNNING",offset:ready.offset)
        XCTAssertTrue(String(decoding:resized.data,as:UTF8.self).contains("37 123"))
        try terminal.write(Data([3])); try terminal.write(Data("printf '\\111\\116\\124\\105\\122\\122\\125\\120\\124\\105\\104\\n'\n".utf8))
        _=try await collect(terminal,contains:"INTERRUPTED",offset:resized.offset)
    }
    func testNativePTYOutputIsBoundedAndReportsTruncation() async throws {
        let terminal=try native(directory())
        try terminal.write(Data("stty -echo; printf '%0100000d\\n' 1; printf '\\104\\117\\116\\105\\n'\n".utf8))
        let output=try await collect(terminal,contains:"DONE")
        XCTAssertTrue(output.truncated); XCTAssertLessThanOrEqual(output.data.count,65536); XCTAssertGreaterThan(output.offset,65536)
    }
    func testNativeCloseSignalsHeldTTYForegroundJobThatIgnoresHangup() async throws {
        let terminal=try native(directory())
        try terminal.write(Data("stty -echo; /bin/sh -c 'trap \"\" HUP; printf \"\\103\\110\\111\\114\\104=%s\\n\" \"$$\"; exec sleep 30'\n".utf8))
        let ready=try await collect(terminal,contains:"CHILD=")
        let text=String(decoding:ready.data,as:UTF8.self)
        let expression=try NSRegularExpression(pattern:"CHILD=([0-9]+)")
        let match=try XCTUnwrap(expression.firstMatch(in:text,range:NSRange(text.startIndex...,in:text)))
        let range=try XCTUnwrap(Range(match.range(at:1),in:text)), pid=try XCTUnwrap(Int32(text[range]))
        for _ in 0..<100 { if try terminal.stop() { break }; try await Task.sleep(for:.milliseconds(10)) }
        XCTAssertTrue(try terminal.stop())
        var exited=false
        for _ in 0..<100 {
            // This is only the PID emitted by the disposable foreground fixture.
            var mib: [Int32]=[CTL_KERN,KERN_PROC,KERN_PROC_PID,pid], metadata=kinfo_proc(), size=MemoryLayout<kinfo_proc>.stride
            guard sysctl(&mib,u_int(mib.count),&metadata,&size,nil,0) == 0 else { throw CanaveralError.unavailable("Fixture child observation failed") }
            if size == 0 || metadata.kp_proc.p_stat == SZOMB { exited=true; break }
            try await Task.sleep(for:.milliseconds(10))
        }
        XCTAssertTrue(exited,"Disposable foreground child continued executing after PTY close")
    }
    func testNativePTYExitRemainsWaitableUntilOwnedClose() async throws {
        let terminal=try native(directory()); try terminal.write(Data("exit 7\n".utf8))
        let deadline=NativeLeaseClock.now()+3
        var output=try terminal.output(offset:0)
        while !output.exited && NativeLeaseClock.now() < deadline { try await Task.sleep(for:.milliseconds(10)); output=try terminal.output(offset:0) }
        XCTAssertTrue(output.exited); XCTAssertEqual(output.exitCode,7)
        XCTAssertEqual(try terminal.output(offset:0).exitCode,7) // Observation must not reap the leader.
        XCTAssertTrue(try terminal.stop()); XCTAssertTrue(try terminal.stop())
        XCTAssertThrowsError(try terminal.write(Data("ignored".utf8)))
    }
}
