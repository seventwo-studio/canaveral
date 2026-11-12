#if os(macOS)
import Foundation
import Testing
@testable import CanaveralMachines

@MainActor @Test func serialCloseRetainsPendingFinalOutput() throws {
    let console = SerialConsole()
    try console.attachment.fileHandleForWriting?.write(contentsOf: Data("final boot marker\r\n".utf8))
    // No refresh or actor yield: close must drain bytes still in the pipe.
    console.close()
    #expect(console.output == "final boot marker\n")
    console.close()
    #expect(console.output == "final boot marker\n")
}
#endif
