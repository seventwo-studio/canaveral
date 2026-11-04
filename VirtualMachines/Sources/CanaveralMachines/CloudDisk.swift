#if os(macOS)
import Foundation
import CryptoKit
import zlib
import CanaveralVMCore

/// Read-only import of standalone QCOW2 v2/v3 disks into Apple's sparse raw disk format.
/// No hypervisor or command-line conversion dependency. See QEMU's published format specification.
public enum CloudDisk {
    public static func convert(_ source: URL, to target: URL) throws {
        let input = try FileHandle(forReadingFrom: source); defer { try? input.close() }
        let size = try input.seekToEnd()
        func read(_ offset: UInt64, _ count: Int) throws -> Data {
            guard offset <= size, UInt64(count) <= size - offset else { throw CanaveralError.invalid("Cloud disk contains an invalid offset.") }
            try input.seek(toOffset: offset)
            guard let bytes = try input.read(upToCount: count), bytes.count == count else { throw CanaveralError.invalid("Cloud disk is truncated.") }; return bytes
        }
        func number(_ data: Data, _ offset: Int, _ count: Int) -> UInt64 { data[offset..<(offset + count)].reduce(0) { ($0 << 8) | UInt64($1) } }
        let header = try read(0, 104)
        guard number(header, 0, 4) == 0x514649fb else { try FileManager.default.copyItem(at: source, to: target); return }
        let version = number(header, 4, 4), bits = number(header, 20, 4), virtualSize = number(header, 24, 8)
        guard [2, 3].contains(version), (9...21).contains(bits), virtualSize >= 512, virtualSize <= 16 * 1073741824, virtualSize % 512 == 0,
              number(header, 8, 8) == 0, number(header, 32, 4) == 0,
              version == 2 || number(header, 72, 8) == 0 else {
            throw CanaveralError.invalid("Unsupported cloud disk. Use a clean standalone QCOW2 v2/v3 disk without encryption, backing files, or extended features, up to 16 GB.")
        }
        let cluster = 1 << Int(bits), entries = cluster / 8, l1Count = number(header, 36, 4), l1Offset = number(header, 40, 8)
        let needed = (virtualSize + UInt64(cluster * entries) - 1) / UInt64(cluster * entries)
        guard l1Count >= needed, l1Count <= 4_194_304, l1Offset % UInt64(cluster) == 0 else { throw CanaveralError.invalid("Invalid cloud disk mapping table.") }
        let l1 = try read(l1Offset, Int(l1Count) * 8), mask: UInt64 = 0x00ff_ffff_ffff_fe00
        guard FileManager.default.createFile(atPath: target.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CanaveralError.unavailable("Cannot create the agent disk.") }
        let output = try FileHandle(forWritingTo: target); defer { try? output.close() }
        do {
            try output.truncate(atOffset: virtualSize)
            for index in 0..<Int(needed) {
                try Task.checkCancellation()
                let tableOffset = number(l1, index * 8, 8) & mask
                if tableOffset == 0 { continue }
                guard tableOffset % UInt64(cluster) == 0 else { throw CanaveralError.invalid("Invalid L2 table alignment.") }
                let l2 = try read(tableOffset, cluster)
                for inner in 0..<entries {
                    let destination = UInt64(index * entries + inner) * UInt64(cluster)
                    if destination >= virtualSize { break }
                    let entry = number(l2, inner * 8, 8)
                    if entry == 0 { continue }
                    var data: Data
                    if entry & (1 << 62) != 0 {
                        let shift = 62 - (Int(bits) - 8), offset = entry & ((1 << shift) - 1)
                        let sectors = ((entry >> shift) & ((1 << (Int(bits) - 8)) - 1)) + 1
                        let compressed = try read(offset, Int(sectors * 512 - (offset % 512)))
                        data = try inflateCluster(compressed, size: cluster)
                    } else {
                        if entry & 1 != 0 || entry & mask == 0 { continue }
                        let offset = entry & mask
                        guard offset % UInt64(cluster) == 0 else { throw CanaveralError.invalid("Invalid cluster alignment.") }
                        data = try read(offset, cluster)
                    }
                    let count = Int(min(UInt64(cluster), virtualSize - destination))
                    // Zero clusters stay sparse, including preallocation in the source image.
                    if data.prefix(count).contains(where: { $0 != 0 }) { try output.seek(toOffset: destination); try output.write(contentsOf: data.prefix(count)) }
                }
            }
            try output.synchronize()
        } catch { try? output.close(); try? FileManager.default.removeItem(at: target); throw error }
    }
    private static func inflateCluster(_ compressed: Data, size: Int) throws -> Data {
        var stream = z_stream()
        guard inflateInit2_(&stream, -12, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { throw CanaveralError.invalid("Cannot initialize cloud disk decompression.") }
        defer { inflateEnd(&stream) }
        var bytes = [UInt8](repeating: 0, count: size)
        let status = compressed.withUnsafeBytes { input in bytes.withUnsafeMutableBytes { output in
            stream.next_in = UnsafeMutablePointer(mutating: input.bindMemory(to: Bytef.self).baseAddress)
            stream.avail_in = uInt(input.count); stream.next_out = output.bindMemory(to: Bytef.self).baseAddress; stream.avail_out = uInt(size)
            return inflate(&stream, Z_FINISH)
        } }
        guard status == Z_STREAM_END, stream.total_out == size else { throw CanaveralError.invalid("Invalid compressed cloud disk cluster.") }
        return Data(bytes)
    }
    public static func ubuntuMinimal() async throws -> URL {
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "amd64"
        #endif
        let name = "ubuntu-26.04-minimal-cloudimg-\(arch).img"
        let base = URL(string: "https://cloud-images.ubuntu.com/minimal/releases/resolute/release/")!
        let config = URLSessionConfiguration.ephemeral; config.timeoutIntervalForRequest = 60; config.timeoutIntervalForResource = 600
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let (sums, sumsResponse) = try await session.data(from: base.appendingPathComponent("SHA256SUMS"))
        guard (sumsResponse as? HTTPURLResponse)?.statusCode == 200, sums.count < 100000,
              let row = String(decoding: sums, as: UTF8.self).split(separator: "\n").first(where: { $0.hasSuffix("*" + name) || $0.hasSuffix(" " + name) }),
              let expected = row.split(whereSeparator: \.isWhitespace).first, expected.count == 64 else { throw CanaveralError.unavailable("Ubuntu did not supply this image's checksum.") }
        let (file, response) = try await session.download(from: base.appendingPathComponent(name))
        defer { try? FileManager.default.removeItem(at: file) }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw CanaveralError.unavailable("Ubuntu's cloud image download failed.") }
        let expectedHash = String(expected)
        return try await Task.detached {
            let input = try FileHandle(forReadingFrom: file); defer { try? input.close() }
            var hash = SHA256()
            while let bytes = try input.read(upToCount: 1048576), !bytes.isEmpty { try Task.checkCancellation(); hash.update(data: bytes) }
            guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == expectedHash else { throw CanaveralError.invalid("Ubuntu image checksum did not match. Try the download again.") }
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("canaveral-cloud-\(UUID()).img")
            try FileManager.default.moveItem(at: file, to: copy); return copy
        }.value
    }
}
#endif
