import Foundation
import XCTest
import CanaveralMachines
import zlib

final class CloudDiskTests: XCTestCase {
    func testSparseMappingZeroClustersAndCompressedImport() throws {
        for compressed in [false, true] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let source = root.appendingPathComponent("cloud.img"), target = root.appendingPathComponent("raw.img")
            let payload = Data(repeating: 0x41, count: 512)
            var fixture = Data(repeating: 0, count: 2048)
            func put(_ offset: Int, _ value: UInt64, _ count: Int) { for i in 0..<count { fixture[offset + i] = UInt8(truncatingIfNeeded: value >> ((count-i-1)*8)) } }
            put(0, 0x514649fb, 4); put(4, 3, 4); put(20, 9, 4); put(24, 1536, 8); put(36, 1, 4); put(40, 512, 8); put(100, 104, 4)
            put(512, 1024, 8)
            if compressed {
                var stream = z_stream(); XCTAssertEqual(deflateInit2_(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED, -12, 8, Z_DEFAULT_STRATEGY, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)), Z_OK)
                var output = [UInt8](repeating: 0, count: 512)
                let status = payload.withUnsafeBytes { input in output.withUnsafeMutableBytes { out in
                    stream.next_in = UnsafeMutablePointer(mutating: input.bindMemory(to: Bytef.self).baseAddress); stream.avail_in = 512
                    stream.next_out = out.bindMemory(to: Bytef.self).baseAddress; stream.avail_out = 512
                    return deflate(&stream, Z_FINISH)
                } }
                XCTAssertEqual(status, Z_STREAM_END); let count = Int(stream.total_out); deflateEnd(&stream)
                put(1024, (1 << 62) | 1536, 8); fixture.replaceSubrange(1536..<(1536 + count), with: output.prefix(count))
            } else { put(1024, 1536, 8); fixture.replaceSubrange(1536..<2048, with: payload) }
            put(1032, 1, 8) // explicit zero cluster; third cluster is unallocated
            try fixture.write(to: source); try CloudDisk.convert(source, to: target)
            XCTAssertEqual(try Data(contentsOf: target), payload + Data(repeating: 0, count: 1024))
            // Backing files and unsupported feature bits must be rejected before creating a disk.
            put(8, 1, 8); try fixture.write(to: source)
            XCTAssertThrowsError(try CloudDisk.convert(source, to: root.appendingPathComponent("rejected.img")))
        }
    }
    func testMalformedDiskOffsetAndTruncatedInputRejected() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("bad.img"), target = root.appendingPathComponent("out.img")
        try Data([0x51,0x46,0x49,0xfb]).write(to: source)
        XCTAssertThrowsError(try CloudDisk.convert(source, to: target)); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
}
