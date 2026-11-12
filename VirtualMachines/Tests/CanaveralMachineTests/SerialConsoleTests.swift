#if os(macOS)
import Foundation
import XCTest
@testable import CanaveralMachines

final class SerialConsoleTests: XCTestCase {
    func testSerialFloodIsCappedAndTruncationRecorded() {
        let buffer = SerialBuffer()
        buffer.receiveForTesting(Data(repeating: 65, count: SerialBuffer.byteLimit))
        buffer.receiveForTesting(Data(repeating: 66, count: 8192))
        let tail = String(decoding: buffer.drain(), as: UTF8.self)
        XCTAssertLessThanOrEqual(tail.utf8.count, 65536)
        XCTAssertTrue(tail.contains("[serial output truncated at 16 MiB]"))
        buffer.receiveForTesting(Data(repeating: 67, count: 8192))
        XCTAssertTrue(buffer.drain().isEmpty)
    }
    @MainActor func testSerialCloseRetainsPendingFinalOutput() throws {
        let console = SerialConsole()
        try console.attachment.fileHandleForWriting?.write(contentsOf: Data("final boot marker\r\n".utf8))
        // No refresh or actor yield: close must drain bytes still in the pipe.
        console.close()
        XCTAssertEqual(console.output, "final boot marker\n")
        console.close()
        XCTAssertEqual(console.output, "final boot marker\n")
    }
}
#endif
