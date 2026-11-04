import Foundation
import Darwin
import CryptoKit

public protocol GuestWorkspaceService: Sendable {
    func handle(_ request: HTTPRequest) async throws -> HTTPResponse
}

private struct GuestFileIdentity: Codable, Equatable {
    let device: UInt64, inode: UInt64, size: Int64
    let modifiedSeconds: Int64, modifiedNanos: Int64, changedSeconds: Int64, changedNanos: Int64
    init(_ value: stat) {
        device=UInt64(truncatingIfNeeded:value.st_dev); inode=UInt64(value.st_ino); size=value.st_size
        modifiedSeconds=Int64(value.st_mtimespec.tv_sec); modifiedNanos=Int64(value.st_mtimespec.tv_nsec)
        changedSeconds=Int64(value.st_ctimespec.tv_sec); changedNanos=Int64(value.st_ctimespec.tv_nsec)
    }
}

private struct GuestFileRecord: Codable {
    var version=1
    let id: UUID, direction: String, fingerprint: String, path: String, size: Int64
    var phase: String
    var temporary: String? = nil, device: UInt64? = nil, inode: UInt64? = nil, sha256: String? = nil
    var parentDevice: UInt64? = nil, parentInode: UInt64? = nil
    var requestPath: String? = nil
}

private final class GuestFileTransfer {
    let descriptor: Int32, parent: Int32, name: String
    var record: GuestFileRecord, offset: Int64=0, digest=SHA256(), verification=SHA256(), verified: Int64=0
    var identity: GuestFileIdentity
    init(descriptor: Int32, parent: Int32, name: String, record: GuestFileRecord, metadata: stat) {
        self.descriptor=descriptor; self.parent=parent; self.name=name; self.record=record; identity=GuestFileIdentity(metadata)
    }
    deinit { Darwin.close(descriptor); Darwin.close(parent) }
}

/// The native app supplies a guest-only guard; tests supply an explicitly confined root.
public actor GuestFiles: GuestWorkspaceService {
    public static let chunkBytes=524288
    public enum Boundary: Sendable { case beforePublish, afterPublish }
    private let root: URL, rootDescriptor: Int32, stateDescriptor: Int32
    private let permitted: @Sendable () -> Bool
    private let boundary: @Sendable (Boundary) throws -> Void
    private var active: [UUID:GuestFileTransfer]=[:]
    public init(root: URL, state: URL, permitted: @escaping @Sendable () -> Bool,
                boundary: @escaping @Sendable (Boundary) throws -> Void = { _ in }) throws {
        guard permitted() else { throw CanaveralError.unavailable("Guest files are unavailable outside an authorized virtual guest.") }
        guard let resolvedRoot=realpath(root.path,nil) else { throw CanaveralError.unavailable("Guest filesystem root is unavailable.") }
        let canonical=URL(fileURLWithPath:String(cString:resolvedRoot)); free(resolvedRoot)
        let descriptor=Darwin.open(canonical.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
        guard descriptor >= 0 else { throw CanaveralError.unavailable("Guest filesystem root is unavailable.") }
        do {
            try FileManager.default.createDirectory(at:state,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            let journal=Darwin.open(state.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
            guard journal >= 0 else { throw CanaveralError.unavailable("Guest transfer state is unavailable.") }
            guard fchmod(journal,mode_t(0o700)) == 0 else { Darwin.close(journal); throw CanaveralError.unavailable("Guest transfer state could not be made private.") }
            self.root=canonical; rootDescriptor=descriptor; stateDescriptor=journal
            self.permitted=permitted; self.boundary=boundary
        } catch { Darwin.close(descriptor); throw error }
    }
    deinit { Darwin.close(rootDescriptor); Darwin.close(stateDescriptor) }
    public func handle(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard permitted() else { throw CanaveralError.unavailable("Guest file authorization ended.") }
        guard request.method == "POST", request.path == request.target, request.body.count <= 1_000_000,
              let object=try JSONDecoder().decode(JSONValue.self,from:request.body).object else {
            throw CanaveralError.invalid("Expected a bounded guest file request.")
        }
        let result: [String:JSONValue]
        switch request.path {
        case "/v1/files/list":
            try fields(object,["path"]); result=try list(text(object,"path"))
        case "/v1/files/upload/begin", "/v1/files/download/begin":
            let upload=request.path.contains("/upload/")
            try fields(object,upload ? ["id","path","size"] : ["id","path"])
            result=try begin(id:id(object),path:text(object,"path"),size:upload ? number(object,"size") : nil,upload:upload)
        case "/v1/files/upload/chunk":
            try fields(object,["id","offset","data"])
            guard let encoded=object["data"]?.string, encoded.utf8.count <= 700000,
                  let data=Data(base64Encoded:encoded), !data.isEmpty, data.count <= Self.chunkBytes else {
                throw CanaveralError.invalid("Guest file chunks must contain at most 512 KiB.")
            }
            result=try write(id:id(object),offset:number(object,"offset"),data:data)
        case "/v1/files/upload/finish":
            try fields(object,["id","bytes","sha256"])
            result=try publish(id:id(object),bytes:number(object,"bytes"),sha256:text(object,"sha256"))
        case "/v1/files/upload/verify":
            try fields(object,["id"]); result=try verifyUpload(id:id(object))
        case "/v1/files/download/check":
            try fields(object,["id"])
            let identifier=try id(object)
            guard let transfer=active[identifier], transfer.record.direction == "download", transfer.record.phase == "reading" else {
                throw CanaveralError.invalid("Guest download is not active.")
            }
            try sourceUnchanged(transfer); result=try status(transfer.record)
        case "/v1/files/download/chunk":
            try fields(object,["id","offset"])
            result=try read(id:id(object),offset:number(object,"offset"))
        case "/v1/files/download/finish", "/v1/files/download/verify":
            try fields(object,["id"]); result=try verify(id:id(object),start:request.path.hasSuffix("/finish"))
        case "/v1/files/abort":
            try fields(object,["id"]); result=try abort(id:id(object))
        case "/v1/files/status":
            try fields(object,["id"])
            let transfer=try id(object); result=try status(active[transfer]?.record ?? load(transfer))
        default: return .error("Unknown guest file endpoint.",status:404)
        }
        return try .json(JSONValue.object(result))
    }
    private func fields(_ value: [String:JSONValue], _ expected: Set<String>) throws {
        guard Set(value.keys) == expected else { throw CanaveralError.invalid("Invalid guest file fields.") }
    }
    private func text(_ value: [String:JSONValue], _ name: String) throws -> String {
        guard let result=value[name]?.string, !result.isEmpty, !result.contains("\0"), result.utf8.count <= 32768 else {
            throw CanaveralError.invalid("Invalid guest file string.")
        }
        return result
    }
    private func id(_ value: [String:JSONValue]) throws -> UUID {
        guard let raw=value["id"]?.string, let result=UUID(uuidString:raw) else { throw CanaveralError.invalid("Guest transfer requires a UUID.") }
        return result
    }
    private func number(_ value: [String:JSONValue], _ name: String) throws -> Int64 {
        guard case .number(let raw)=value[name], raw.isFinite, raw >= 0, raw <= 9007199254740991, raw.rounded(.towardZero) == raw else {
            throw CanaveralError.invalid("Guest file length must be an exact nonnegative protocol integer.")
        }
        return Int64(raw)
    }
    private func logical(_ url: URL) throws -> String {
        let path=url.path, base=root.path
        guard path == base || (base == "/" ? path.hasPrefix("/") : path.hasPrefix(base+"/")) else {
            throw CanaveralError.invalid("Guest path escapes its filesystem root.")
        }
        return base == "/" ? path : path == base ? "/" : String(path.dropFirst(base.count))
    }
    private func resolve(_ path: String) throws -> URL {
        guard path.hasPrefix("/") else { throw CanaveralError.invalid("Use an absolute guest path.") }
        let candidate=root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        let resolved: URL
        if let native=realpath(candidate.path,nil) {
            defer { free(native) }; resolved=URL(fileURLWithPath:String(cString:native))
        } else {
            var metadata=stat()
            guard errno == ENOENT, lstat(candidate.path,&metadata) != 0,
                  let parent=realpath(candidate.deletingLastPathComponent().path,nil) else {
                throw CanaveralError.unavailable("Guest path cannot be resolved.")
            }
            defer { free(parent) }
            resolved=URL(fileURLWithPath:String(cString:parent)).appendingPathComponent(candidate.lastPathComponent)
        }
        _=try logical(resolved); return resolved
    }
    private func directory(_ url: URL) throws -> Int32 {
        let path=try logical(url)
        var descriptor=Darwin.dup(rootDescriptor)
        guard descriptor >= 0 else { throw CanaveralError.unavailable("Guest directory is unavailable.") }
        _=fcntl(descriptor,F_SETFD,FD_CLOEXEC)
        for component in path.split(separator:"/") {
            let next=Darwin.openat(descriptor,String(component),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
            Darwin.close(descriptor)
            guard next >= 0 else { throw CanaveralError.unavailable("Guest directory identity changed or access was denied.") }
            descriptor=next
        }
        return descriptor
    }
    private func locate(_ path: String) throws -> (parent:Int32,name:String,path:String) {
        let url=try resolve(path), canonical=try logical(url)
        guard canonical != "/" else { throw CanaveralError.invalid("Select a regular guest file.") }
        return (try directory(url.deletingLastPathComponent()),url.lastPathComponent,canonical)
    }
    private func list(_ path: String) throws -> [String:JSONValue] {
        let url=try resolve(path), descriptor=try directory(url)
        guard let stream=fdopendir(descriptor) else { Darwin.close(descriptor); throw CanaveralError.unavailable("Guest directory listing is unavailable.") }
        defer { closedir(stream) }
        var entries: [(String,JSONValue)]=[], truncated=false
        while true {
            errno=0
            guard let item=readdir(stream) else {
                guard errno == 0 else { throw CanaveralError.unavailable("Guest directory listing was interrupted.") }; break
            }
            let name=withUnsafePointer(to:&item.pointee.d_name) { $0.withMemoryRebound(to:CChar.self,capacity:1024) { String(cString:$0) } }
            if name == "." || name == ".." { continue }
            if entries.count == 2000 { truncated=true; break }
            var value=stat(), data: [String:JSONValue]=["name":.string(name)]
            if fstatat(descriptor,name,&value,AT_SYMLINK_NOFOLLOW) == 0 {
                let kind=value.st_mode & S_IFMT
                data["kind"] = .string(kind == S_IFDIR ? "directory" : kind == S_IFLNK ? "symlink" : "file")
                data["size"] = .number(Double(value.st_size)); data["modifiedAt"] = .number(Double(value.st_mtimespec.tv_sec)+Double(value.st_mtimespec.tv_nsec)/1e9)
            } else { data["kind"] = .string("file"); data["unavailable"] = .bool(true) }
            entries.append((name,.object(data)))
        }
        return ["path":.string(try logical(url)),"entries":.array(entries.sorted { $0.0 < $1.0 }.map(\.1)),"truncated":.bool(truncated)]
    }
    private func filename(_ id: UUID) -> String { id.uuidString.lowercased()+".json" }
    private func load(_ id: UUID) throws -> GuestFileRecord {
        let descriptor=openat(stateDescriptor,filename(id),O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)
        guard descriptor >= 0 else { throw CanaveralError.invalid("Unknown guest transfer.") }
        defer { Darwin.close(descriptor) }
        var metadata=stat()
        guard fstat(descriptor,&metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, metadata.st_size <= 65536 else {
            throw CanaveralError.unavailable("Guest transfer receipt is unavailable.")
        }
        var data=Data()
        while data.count < 65537 { let part=try bytes(descriptor,maximum:65537-data.count); if part.isEmpty { break }; data.append(part) }
        let value=try JSONDecoder().decode(GuestFileRecord.self,from:data)
        guard value.version == 1, value.id == id, ["upload","download"].contains(value.direction), value.size >= 0, value.size <= 9007199254740991,
              ["starting","receiving","reading","verifying","verifyingUpload","publishing","committed","verified","aborted","uncertain"].contains(value.phase),
              value.path.hasPrefix("/"), !value.path.contains("\0") else {
            throw CanaveralError.invalid("Guest transfer receipt identity differs.")
        }
        return value
    }
    private func persist(_ value: GuestFileRecord) throws {
        let temporary=".receipt-"+UUID().uuidString.lowercased()
        let descriptor=openat(stateDescriptor,temporary,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,mode_t(0o600))
        guard descriptor >= 0 else { throw CanaveralError.unavailable("Guest transfer receipt could not be created.") }
        defer { Darwin.close(descriptor); unlinkat(stateDescriptor,temporary,0) }
        try writeAll(descriptor,try JSONEncoder().encode(value))
        guard fsync(descriptor) == 0, renameat(stateDescriptor,temporary,stateDescriptor,filename(value.id)) == 0, fsync(stateDescriptor) == 0 else {
            throw CanaveralError.unavailable("Guest transfer receipt publication is uncertain.")
        }
    }
    private func status(_ value: GuestFileRecord) throws -> [String:JSONValue] {
        var result: [String:JSONValue]=["id":.string(value.id.uuidString),"state":.string(value.phase),"bytes":.number(Double(value.size))]
        if let sha=value.sha256 { result["sha256"] = .string(sha) }
        if value.phase == "committed" { result["durable"] = .bool(true) }
        return result
    }
    private func bytes(_ descriptor: Int32, maximum: Int, position: Int64? = nil) throws -> Data {
        var data=[UInt8](repeating:0,count:maximum)
        while true {
            let count=position.map { Darwin.pread(descriptor,&data,maximum,off_t($0)) } ?? Darwin.read(descriptor,&data,maximum)
            if count >= 0 { return Data(data.prefix(count)) }
            if errno != EINTR { throw CanaveralError.unavailable("Guest file read failed.") }
        }
    }
    private func writeAll(_ descriptor: Int32, _ data: Data) throws {
        try data.withUnsafeBytes { raw in
            var offset=0
            while offset < raw.count {
                let count=Darwin.write(descriptor,raw.baseAddress!.advanced(by:offset),raw.count-offset)
                if count > 0 { offset+=count }
                else if count < 0 && errno == EINTR { continue }
                else { throw CanaveralError.unavailable("Guest file write failed.") }
            }
        }
    }
    private func checksum(_ digest: SHA256) -> String { digest.finalize().map { String(format:"%02x",$0) }.joined() }
    private func begin(id: UUID, path: String, size: Int64?, upload: Bool) throws -> [String:JSONValue] {
        let kind=upload ? "upload" : "download", fingerprint=Secrets.hash("\(upload ? "upload" : "download")\0\(path)\0\(size ?? -1)")
        var existing=stat()
        if fstatat(stateDescriptor,filename(id),&existing,AT_SYMLINK_NOFOLLOW) == 0 {
            let record=try load(id)
            guard record.fingerprint == fingerprint else { throw CanaveralError.invalid("Guest transfer ID belongs to another request.") }
            guard active[id] != nil || ["committed","verified","aborted"].contains(record.phase) else {
                throw CanaveralError.unavailable("Previous transfer requires inspection; it will not be reopened.")
            }
            return try status(active[id]?.record ?? record)
        }
        guard errno == ENOENT else { throw CanaveralError.unavailable("Guest transfer identity could not be checked.") }
        let location=try locate(path)
        var record=GuestFileRecord(id:id,direction:kind,fingerprint:fingerprint,path:location.path,size:size ?? 0,phase:"starting")
        do { try persist(record) } catch { Darwin.close(location.parent); throw error }
        let temporary=upload ? ".canaveral-upload-"+id.uuidString.lowercased() : nil
        let descriptor=openat(location.parent,temporary ?? location.name,
                              upload ? O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC : O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC,mode_t(0o600))
        guard descriptor >= 0 else { Darwin.close(location.parent); throw CanaveralError.unavailable("Guest transfer file could not be opened; inspect its receipt.") }
        var metadata=stat()
        guard fstat(descriptor,&metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, metadata.st_size >= 0, metadata.st_size <= 9007199254740991 else {
            Darwin.close(descriptor); Darwin.close(location.parent); throw CanaveralError.invalid("Guest transfers require a regular file.")
        }
        if !upload { record=GuestFileRecord(id:id,direction:kind,fingerprint:fingerprint,path:location.path,size:metadata.st_size,phase:"reading") }
        else { record.phase="receiving"; record.temporary=temporary; record.device=UInt64(truncatingIfNeeded:metadata.st_dev); record.inode=UInt64(metadata.st_ino) }
        var parentMetadata=stat()
        guard fstat(location.parent,&parentMetadata) == 0 else {
            Darwin.close(descriptor); Darwin.close(location.parent); throw CanaveralError.unavailable("Guest parent identity is unavailable.")
        }
        record.requestPath=path
        record.parentDevice=UInt64(truncatingIfNeeded:parentMetadata.st_dev); record.parentInode=UInt64(parentMetadata.st_ino)
        let transfer=GuestFileTransfer(descriptor:descriptor,parent:location.parent,name:location.name,record:record,metadata:metadata)
        active[id]=transfer; try persist(record)
        return try status(record)
    }
    private func write(id: UUID, offset: Int64, data: Data) throws -> [String:JSONValue] {
        guard let transfer=active[id], transfer.record.direction == "upload", transfer.record.phase == "receiving",
              transfer.offset == offset, Int64(data.count) <= transfer.record.size-offset else { throw CanaveralError.invalid("Guest upload offset or length differs.") }
        do { try writeAll(transfer.descriptor,data) }
        catch { transfer.record.phase="uncertain"; try? persist(transfer.record); throw error }
        transfer.digest.update(data:data); transfer.offset+=Int64(data.count)
        return ["id":.string(id.uuidString),"offset":.number(Double(transfer.offset))]
    }
    private func publish(id: UUID, bytes: Int64, sha256: String) throws -> [String:JSONValue] {
        if let receipt=try? load(id), receipt.phase == "committed" {
            guard receipt.size == bytes, receipt.sha256 == sha256 else { throw CanaveralError.invalid("Completed guest upload identity differs.") }
            return try status(receipt)
        }
        guard let transfer=active[id], transfer.record.phase == "receiving", transfer.record.direction == "upload",
              transfer.offset == bytes, bytes == transfer.record.size, sha256 == checksum(transfer.digest) else {
            throw CanaveralError.invalid("Guest upload completion was not verified.")
        }
        guard fsync(transfer.descriptor) == 0 else { throw CanaveralError.unavailable("Guest upload data synchronization failed.") }
        var metadata=stat()
        guard fstat(transfer.descriptor,&metadata) == 0, metadata.st_size == bytes else { throw CanaveralError.unavailable("Guest staging length changed.") }
        transfer.identity=GuestFileIdentity(metadata)
        try stagingUnchanged(transfer)
        guard lseek(transfer.descriptor,0,SEEK_SET) == 0 else { throw CanaveralError.unavailable("Guest staging verification could not start.") }
        transfer.record.sha256=sha256; transfer.record.phase="verifyingUpload"
        return try verifyUpload(id:id)
    }
    private func parentUnchanged(_ transfer: GuestFileTransfer) throws {
        let url=try resolve(transfer.record.requestPath ?? transfer.record.path)
        guard try logical(url) == transfer.record.path else { throw CanaveralError.unavailable("Guest file path changed.") }
        let descriptor=try directory(url.deletingLastPathComponent()); defer { Darwin.close(descriptor) }
        var metadata=stat()
        guard fstat(descriptor,&metadata) == 0,
              UInt64(truncatingIfNeeded:metadata.st_dev) == transfer.record.parentDevice,
              UInt64(metadata.st_ino) == transfer.record.parentInode else { throw CanaveralError.unavailable("Guest parent path changed.") }
    }
    private func stagingUnchanged(_ transfer: GuestFileTransfer) throws {
        try parentUnchanged(transfer)
        var descriptor=stat(), path=stat()
        guard let temporary=transfer.record.temporary, fstat(transfer.descriptor,&descriptor) == 0,
              fstatat(transfer.parent,temporary,&path,AT_SYMLINK_NOFOLLOW) == 0,
              path.st_mode & S_IFMT == S_IFREG, path.st_nlink == 1,
              GuestFileIdentity(descriptor) == transfer.identity, GuestFileIdentity(path) == transfer.identity else {
            throw CanaveralError.unavailable("Guest staging identity or contents changed.")
        }
    }
    private func verifyUpload(id: UUID) throws -> [String:JSONValue] {
        guard let transfer=active[id], transfer.record.direction == "upload", transfer.record.phase == "verifyingUpload" else {
            throw CanaveralError.invalid("Guest upload is not awaiting verification.")
        }
        try stagingUnchanged(transfer)
        let count=Int(min(Int64(Self.chunkBytes),transfer.record.size-transfer.verified)), data=try bytes(transfer.descriptor,maximum:count,position:transfer.verified)
        guard data.count == count else { throw CanaveralError.unavailable("Guest staging verification ended early.") }
        transfer.verification.update(data:data); transfer.verified+=Int64(data.count)
        try stagingUnchanged(transfer)
        if transfer.verified != transfer.record.size {
            return ["id":.string(id.uuidString),"state":.string("verifyingUpload"),"verified":.number(Double(transfer.verified))]
        }
        guard checksum(transfer.verification) == transfer.record.sha256 else { throw CanaveralError.unavailable("Guest staging digest differs.") }
        var publishing=transfer.record; publishing.phase="publishing"
        transfer.record.phase="uncertain"
        try persist(publishing); transfer.record=publishing
        try boundary(.beforePublish)
        try stagingUnchanged(transfer)
        guard let temporary=transfer.record.temporary,
              renameat(transfer.parent,temporary,transfer.parent,transfer.name) == 0 else {
            throw CanaveralError.unavailable("Guest upload publication was not confirmed; inspect before retrying.")
        }
        try boundary(.afterPublish)
        guard fsync(transfer.parent) == 0 else { throw CanaveralError.unavailable("Guest upload directory synchronization was not confirmed.") }
        var committed=transfer.record; committed.phase="committed"
        try persist(committed)
        active.removeValue(forKey:id); return try status(committed)
    }
    private func sourceUnchanged(_ transfer: GuestFileTransfer) throws {
        try parentUnchanged(transfer)
        var current=stat(), path=stat()
        guard fstat(transfer.descriptor,&current) == 0, fstatat(transfer.parent,transfer.name,&path,AT_SYMLINK_NOFOLLOW) == 0,
              GuestFileIdentity(current) == transfer.identity, GuestFileIdentity(path) == transfer.identity else {
            throw CanaveralError.unavailable("Guest download source changed; no completion is acknowledged.")
        }
    }
    private func read(id: UUID, offset: Int64) throws -> [String:JSONValue] {
        guard let transfer=active[id], transfer.record.direction == "download", transfer.record.phase == "reading", offset == transfer.offset else {
            throw CanaveralError.invalid("Guest download offset differs or the session ended.")
        }
        try sourceUnchanged(transfer)
        let maximum=Int(min(Int64(Self.chunkBytes),transfer.record.size-offset)), data=try bytes(transfer.descriptor,maximum:maximum,position:offset)
        guard data.count == maximum else { throw CanaveralError.unavailable("Guest download ended before its declared length.") }
        transfer.digest.update(data:data); transfer.offset+=Int64(data.count); try sourceUnchanged(transfer)
        return ["id":.string(id.uuidString),"offset":.number(Double(transfer.offset)),"data":.string(data.base64EncodedString())]
    }
    private func verify(id: UUID, start: Bool) throws -> [String:JSONValue] {
        if let receipt=try? load(id), receipt.phase == "verified" { return try status(receipt) }
        guard let transfer=active[id], transfer.record.direction == "download", transfer.offset == transfer.record.size,
              (start ? transfer.record.phase == "reading" : transfer.record.phase == "verifying") else {
            throw CanaveralError.invalid("Guest download is incomplete or cannot resume verification.")
        }
        try sourceUnchanged(transfer)
        if start {
            guard lseek(transfer.descriptor,0,SEEK_SET) == 0 else { throw CanaveralError.unavailable("Guest source verification could not start.") }
            transfer.record.phase="verifying"
        }
        let count=Int(min(Int64(Self.chunkBytes),transfer.record.size-transfer.verified)), data=try bytes(transfer.descriptor,maximum:count,position:transfer.verified)
        guard data.count == count else { throw CanaveralError.unavailable("Guest verification source was truncated.") }
        transfer.verification.update(data:data); transfer.verified+=Int64(data.count); try sourceUnchanged(transfer)
        if transfer.verified != transfer.record.size { return ["id":.string(id.uuidString),"state":.string("verifying"),"verified":.number(Double(transfer.verified))] }
        guard checksum(transfer.verification) == checksum(transfer.digest) else { throw CanaveralError.unavailable("Guest download digest changed before completion.") }
        var verified=transfer.record; verified.phase="verified"; verified.sha256=checksum(transfer.digest)
        transfer.record.phase="uncertain"; try persist(verified)
        active.removeValue(forKey:id); return try status(verified)
    }
    private func abort(id: UUID) throws -> [String:JSONValue] {
        var record=try load(id)
        if ["committed","verified","aborted"].contains(record.phase) { return try status(record) }
        guard record.phase != "publishing" else { throw CanaveralError.unavailable("Guest publication is uncertain; abort cannot remove its destination.") }
        if record.direction == "upload", (record.temporary == nil || record.device == nil || record.inode == nil) {
            throw CanaveralError.unavailable("Guest staging ownership was not recorded; inspect before cleanup.")
        }
        if record.direction == "upload", let temporary=record.temporary, let device=record.device, let inode=record.inode {
            let parent: Int32
            if let live=active[id] { parent=Darwin.dup(live.parent) }
            else {
                // Resolve only the saved parent: the destination itself may have changed.
                let url=root.appendingPathComponent(String(record.path.dropFirst())).deletingLastPathComponent()
                parent=try directory(url)
            }
            guard parent >= 0 else { throw CanaveralError.unavailable("Guest cleanup parent is unavailable.") }
            defer { Darwin.close(parent) }
            var parentMetadata=stat()
            guard fstat(parent,&parentMetadata) == 0,
                  UInt64(truncatingIfNeeded:parentMetadata.st_dev) == record.parentDevice,
                  UInt64(parentMetadata.st_ino) == record.parentInode else {
                throw CanaveralError.unavailable("Guest cleanup parent identity changed.")
            }
            guard temporary == ".canaveral-upload-"+id.uuidString.lowercased() else { throw CanaveralError.invalid("Guest staging identity differs.") }
            var metadata=stat()
            if fstatat(parent,temporary,&metadata,AT_SYMLINK_NOFOLLOW) == 0 {
                guard metadata.st_mode & S_IFMT == S_IFREG, UInt64(truncatingIfNeeded:metadata.st_dev) == device, UInt64(metadata.st_ino) == inode else {
                    throw CanaveralError.unavailable("Guest staging ownership changed; no file was removed.")
                }
                guard unlinkat(parent,temporary,0) == 0, fsync(parent) == 0 else { throw CanaveralError.unavailable("Guest staging cleanup was not confirmed.") }
            } else if errno != ENOENT { throw CanaveralError.unavailable("Guest staging presence could not be checked.") }
        }
        record.phase="aborted"; try persist(record); active.removeValue(forKey:id); return try status(record)
    }
}
