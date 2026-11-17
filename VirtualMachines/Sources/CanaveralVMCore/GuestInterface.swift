import Foundation
import Darwin
public struct GuestInterfaceAddress: Sendable {
    public let name: String, mac: String, address: String
    public let up: Bool, loopback: Bool
    public init(name: String, mac: String, address: String, up: Bool = true, loopback: Bool = false) { self.name = name; self.mac = mac; self.address = address; self.up = up; self.loopback = loopback }
}
public enum GuestInterface {
    public static func expectedMAC(machineId: String) -> String {
        let hex = Array(machineId.replacingOccurrences(of: "-", with: "").lowercased().prefix(10))
        return "02:" + stride(from: 0, to: 10, by: 2).map { String(hex[$0...$0+1]) }.joined(separator: ":")
    }
    public static func select(_ rows: [GuestInterfaceAddress], mac: String) throws -> String {
        let matches = rows.filter { $0.up && !$0.loopback && $0.mac.lowercased() == mac.lowercased() }
        let names = Set(matches.map(\.name))
        let candidates = matches.filter { row in
            let n = row.address.split(separator: ".").compactMap { UInt8($0) }
            return row.address.split(separator: ".", omittingEmptySubsequences: false).count == 4 && n.count == 4 && (n[0] == 10 || n[0] == 172 && (16...31).contains(n[1]) || n[0] == 192 && n[1] == 168)
        }
        guard names.count == 1, candidates.count == 1 else { throw CanaveralError.unavailable("Assigned interface is unavailable or ambiguous.") }
        return candidates[0].address
    }
    public static func wait(machineId: String, seconds: Double = 20) async throws -> String {
        let end = ContinuousClock.now.advanced(by: .seconds(seconds))
        repeat {
            if let address = try? select(system(), mac: expectedMAC(machineId: machineId)) { return address }
            try await Task.sleep(for: .milliseconds(200))
        } while ContinuousClock.now < end
        throw CanaveralError.unavailable("Assigned interface wait expired.")
    }
    public static func system() throws -> [GuestInterfaceAddress] {
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0, let first else { throw CanaveralError.unavailable("Interface table unavailable.") }
        defer { freeifaddrs(first) }
        var macs: [String: String] = [:], linkFlags: [String: UInt32] = [:], rows: [(String, String, UInt32)] = []
        var item: UnsafeMutablePointer<ifaddrs>? = first
        while let current = item {
            let row = current.pointee; item = row.ifa_next
            guard let address = row.ifa_addr else { continue }
            let name = String(cString: row.ifa_name)
            if Int32(address.pointee.sa_family) == AF_LINK {
                let link = UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_dl.self).pointee
                if link.sdl_alen == 6 {
                    let offset = MemoryLayout<sockaddr_dl>.offset(of: \.sdl_data)! + Int(link.sdl_nlen)
                    guard offset + 6 <= Int(link.sdl_len) else { continue }
                    let bytes = UnsafeRawPointer(address).assumingMemoryBound(to: UInt8.self)
                    linkFlags[name] = row.ifa_flags
                    macs[name] = (offset..<offset+6).map { String(format: "%02x", bytes[$0]) }.joined(separator: ":")
                }
            } else if Int32(address.pointee.sa_family) == AF_INET {
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 { rows.append((name, String(cString: host), row.ifa_flags)) }
            }
        }
        for name in macs.keys where !rows.contains(where: { $0.0 == name }) { rows.append((name, "", linkFlags[name] ?? 0)) }
        return rows.map { GuestInterfaceAddress(name: $0.0, mac: macs[$0.0] ?? "", address: $0.1, up: $0.2 & UInt32(IFF_UP) != 0, loopback: $0.2 & UInt32(IFF_LOOPBACK) != 0) }
    }
}
