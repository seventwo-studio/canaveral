#if os(macOS)
import XCTest
import Darwin
@testable import CanaveralMachines

final class DirectBootPumpTests: XCTestCase {
    private func pair() throws -> [Int32] {
        var fds: [Int32] = [-1, -1]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0 else { throw POSIXError(.EIO) }
        for fd in fds {
            var small: Int32 = 4096, yes: Int32 = 1
            _ = setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &small, 4)
            _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, 4)
            _ = fcntl(fd, F_SETFL, O_NONBLOCK)
        }
        return fds
    }
    private static func send(_ bytes: [UInt8], to fd: Int32) -> Bool {
        let deadline = ContinuousClock.now + .seconds(15)
        var offset = 0
        while offset < bytes.count, ContinuousClock.now < deadline {
            let n = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), bytes.count - offset) }
            if n > 0 { offset += n }
            else if n < 0 && (errno == EAGAIN || errno == EINTR) {
                var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0); _ = poll(&p, 1, 50)
            } else { return false }
        }
        return offset == bytes.count
    }
    private static func receive(_ expected: [UInt8], from fd: Int32) -> Bool {
        let deadline = ContinuousClock.now + .seconds(15)
        var got: [UInt8] = [], buffer = [UInt8](repeating: 0, count: 8192)
        while ContinuousClock.now < deadline {
            let n = Darwin.read(fd, &buffer, buffer.count)
            if n > 0 { got.append(contentsOf: buffer.prefix(n)); if got.count > expected.count { return false } }
            else if n == 0 { return got == expected }
            else if errno == EAGAIN || errno == EINTR {
                var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0); _ = poll(&p, 1, 50)
            } else { return false }
        }
        return false
    }
    func testFourMiBBothDirectionsAndHalfCloses() throws {
        let a = try pair(), b = try pair()
        defer { close(a[0]); close(b[0]); close(b[1]) }
        let pump = DirectBootPump(local: a[1]); defer { pump.stop() }
        let finished = expectation(description: "finished once"); finished.assertForOverFulfill = true
        pump.start(remote: b[1]) { finished.fulfill() }
        let outgoing = (0..<(4 * 1024 * 1024)).map { UInt8($0 % 251) }
        let incoming = outgoing.reversed().map { $0 }
        let transfers = (0..<4).map { expectation(description: "transfer \($0)") }
        DispatchQueue.global().async {
            XCTAssertTrue(Self.send(outgoing, to: a[0])); shutdown(a[0], SHUT_WR); transfers[0].fulfill()
        }
        DispatchQueue.global().async {
            XCTAssertTrue(Self.receive(outgoing, from: b[0])); transfers[1].fulfill()
            // Respond only after EOF: proves one half-close leaves the reverse direction live.
            XCTAssertTrue(Self.send(incoming, to: b[0])); shutdown(b[0], SHUT_WR); transfers[2].fulfill()
        }
        DispatchQueue.global().async {
            XCTAssertTrue(Self.receive(incoming, from: a[0])); transfers[3].fulfill()
        }
        wait(for: transfers + [finished], timeout: 35)
        pump.stop(); pump.stop()
        XCTAssertEqual(fcntl(a[1], F_GETFD), -1); XCTAssertEqual(errno, EBADF)
    }
    func testStopDuringStallClosesDescriptors() throws {
        let a = try pair(), b = try pair()
        defer { close(a[0]); close(b[0]); close(b[1]) }
        let pump = DirectBootPump(local: a[1])
        let finished = expectation(description: "finished once"); finished.assertForOverFulfill = true
        pump.start(remote: b[1]) { finished.fulfill() }
        let bytes = [UInt8](repeating: 71, count: 4 * 1024 * 1024)
        // Fill the unconsumed remote receive buffer and the bounded relay buffer.
        let stalled = expectation(description: "backpressure observed")
        DispatchQueue.global().async {
            var offset = 0
            let deadline = ContinuousClock.now + .seconds(5)
            while offset < bytes.count, ContinuousClock.now < deadline {
                let n = bytes.withUnsafeBytes { Darwin.write(a[0], $0.baseAddress!.advanced(by: offset), bytes.count - offset) }
                if n > 0 { offset += n; continue }
                if errno == EINTR { continue }
                XCTAssertEqual(errno, EAGAIN)
                var p = pollfd(fd: a[0], events: Int16(POLLOUT), revents: 0)
                if poll(&p, 1, 250) == 0 { break }
            }
            XCTAssertLessThan(offset, bytes.count); stalled.fulfill()
        }
        wait(for: [stalled], timeout: 6)
        let stopped = expectation(description: "stop returned")
        DispatchQueue.global().async { pump.stop(); stopped.fulfill() }
        wait(for: [stopped, finished], timeout: 2)
        pump.stop()
        XCTAssertEqual(fcntl(a[1], F_GETFD), -1); XCTAssertEqual(errno, EBADF)
        XCTAssertTrue(pump.descriptorsClosed)
    }
    func testFailedStartAndStopBeforeStart() throws {
        for stopFirst in [false, true] {
            let fds = try pair(); defer { close(fds[0]) }
            let pump = DirectBootPump(local: fds[1])
            let finished = expectation(description: "failed start finishes once"); finished.assertForOverFulfill = true
            if stopFirst { pump.stop() }
            pump.start(remote: -1) { finished.fulfill() }
            pump.stop(); wait(for: [finished], timeout: 1)
            XCTAssertTrue(pump.descriptorsClosed)
            XCTAssertEqual(fcntl(fds[1], F_GETFD), -1); XCTAssertEqual(errno, EBADF)
        }
    }
    @MainActor func testPeerCredentialsFailClosed() throws {
        let fds = try pair(); defer { close(fds[0]); close(fds[1]) }
        XCTAssertTrue(DirectBootRelay.authorizedPeer(fds[0]))
        XCTAssertFalse(DirectBootRelay.authorizedPeer(-1))
    }
}
#endif
