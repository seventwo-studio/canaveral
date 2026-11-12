#if os(macOS)
import Foundation
import XCTest
@testable import CanaveralMachines

final class SerialConsoleTests: XCTestCase {
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
