import Foundation

public struct GuestAccessibilityBounds: Codable, Sendable, Equatable {
    public var x: Double, y: Double, width: Double, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) { self.x=x; self.y=y; self.width=width; self.height=height }
    public var valid: Bool { [x,y,width,height].allSatisfy(\.isFinite) && width >= 0 && height >= 0 }
}

public struct GuestAccessibilityAttributes: Sendable, Equatable {
    public var role: String, name: String, identifier: String
    public var states: [String: Bool], actions: [String], bounds: GuestAccessibilityBounds?
    public var properties: [String: JSONValue]
    public init(role: String, name: String = "", identifier: String = "", states: [String: Bool] = [:],
                actions: [String] = [], bounds: GuestAccessibilityBounds? = nil, properties: [String: JSONValue] = [:]) {
        self.role=role; self.name=name; self.identifier=identifier; self.states=states
        self.actions=actions; self.bounds=bounds; self.properties=properties
    }
}

public struct GuestAccessibilityNode: Codable, Sendable, Equatable {
    public var id: String, parentId: String?, depth: Int
    public var role: String, name: String, identifier: String
    public var states: [String: Bool], actions: [String], bounds: GuestAccessibilityBounds?
    public var properties: [String: JSONValue]
    public init(id: String, parentId: String?, depth: Int, attributes: GuestAccessibilityAttributes) {
        self.id=id; self.parentId=parentId; self.depth=depth; role=attributes.role; name=attributes.name
        identifier=attributes.identifier; states=attributes.states; actions=attributes.actions
        bounds=attributes.bounds; properties=attributes.properties
    }
    public var attributes: GuestAccessibilityAttributes {
        .init(role: role, name: name, identifier: identifier, states: states, actions: actions, bounds: bounds, properties: properties)
    }
    private enum CodingKeys: String, CodingKey { case id,parentId,depth,role,name,identifier,states,actions,bounds,properties }
    public func encode(to encoder: any Encoder) throws {
        var c=encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id,forKey:.id); try c.encode(depth,forKey:.depth)
        if let parentId { try c.encode(parentId,forKey:.parentId) } else { try c.encodeNil(forKey:.parentId) }
        if let bounds { try c.encode(bounds,forKey:.bounds) } else { try c.encodeNil(forKey:.bounds) }
        try c.encode(role,forKey:.role); try c.encode(name,forKey:.name); try c.encode(identifier,forKey:.identifier)
        try c.encode(states,forKey:.states); try c.encode(actions,forKey:.actions); try c.encode(properties,forKey:.properties)
    }
}

public struct GuestAccessibilitySnapshot: Codable, Sendable, Equatable {
    public var snapshotId: UUID, capturedAt: Double
    public var source: String, coordinateSpace: String
    public var nodes: [GuestAccessibilityNode], truncated: Bool, unavailableNodes: Int, coverage: String
    public init(snapshotId: UUID = UUID(), capturedAt: Double = Date().timeIntervalSince1970,
                nodes: [GuestAccessibilityNode], truncated: Bool = false, unavailableNodes: Int = 0) {
        self.snapshotId=snapshotId; self.capturedAt=capturedAt; source="macos-accessibility"; coordinateSpace="screen-points"
        self.nodes=nodes; self.truncated=truncated; self.unavailableNodes=unavailableNodes
        coverage="Native macOS accessibility; inaccessible, custom-rendered or budget-truncated controls may be absent."
    }
    public func validate() throws {
        guard capturedAt.isFinite, capturedAt >= 0, source == "macos-accessibility", coordinateSpace == "screen-points",
              nodes.count <= 2000, unavailableNodes >= 0, !coverage.isEmpty else { throw CanaveralError.invalid("Invalid guest accessibility snapshot.") }
        var depths: [String: Int]=[:]
        for node in nodes {
            guard !node.id.isEmpty, depths[node.id] == nil, (0...30).contains(node.depth),
                  node.depth == (node.parentId.flatMap { depths[$0].map { $0+1 } } ?? (node.parentId == nil ? 0 : -1)),
                  [node.role,node.name,node.identifier].allSatisfy({ $0.utf8.count <= 8192 }),
                  node.bounds?.valid != false, Set(node.actions).count == node.actions.count,
                  node.actions.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 200 }) else { throw CanaveralError.invalid("Invalid guest accessibility node.") }
            depths[node.id]=node.depth
        }
        guard try JSONEncoder().encode(self).count <= 6*1048576 else { throw CanaveralError.invalid("Guest accessibility snapshot exceeds its envelope.") }
    }
}

public struct GuestAccessibilityAction: Codable, Sendable {
    public var id: UUID, snapshotId: UUID, nodeId: String, nativeAction: String, human: Bool?
    public init(id: UUID = UUID(), snapshotId: UUID, nodeId: String, nativeAction: String, human: Bool? = nil) {
        self.id=id; self.snapshotId=snapshotId; self.nodeId=nodeId; self.nativeAction=nativeAction; self.human=human
    }
    public func validate() throws {
        guard !nodeId.isEmpty, nodeId.utf8.count <= 200, !nativeAction.isEmpty, nativeAction.utf8.count <= 200 else {
            throw CanaveralError.invalid("Invalid guest accessibility action.")
        }
    }
}

@MainActor public protocol GuestAccessibilityBackend {
    associatedtype Element
    func roots() throws -> [Element]
    func attributes(_ element: Element) throws -> GuestAccessibilityAttributes
    func children(_ element: Element, limit: Int) throws -> (elements: [Element], truncated: Bool)
    func hash(_ element: Element) -> Int
    func same(_ first: Element, _ second: Element) -> Bool
    func perform(_ element: Element, action: String) throws
}

/// Native handles stay inside the guest. Public node IDs never identify a host object.
@MainActor public final class GuestAccessibilityTree<Backend: GuestAccessibilityBackend> {
    private struct Capture {
        var snapshot: GuestAccessibilitySnapshot, started: Double
        var elements: [String: Backend.Element]
    }
    private let backend: Backend
    private let clock: @Sendable () -> Double
    private var captures: [UUID: Capture]=[:]
    public init(backend: Backend, clock: @escaping @Sendable () -> Double = { NativeLeaseClock.now() }) {
        self.backend=backend; self.clock=clock
    }
    public func inspect() throws -> GuestAccessibilitySnapshot {
        let captured=try scan(), now=clock()
        captures=captures.filter { now >= $0.value.started && now-$0.value.started < 15 }
        if captures.count >= 180, let oldest=captures.min(by: { $0.value.started < $1.value.started }) { captures.removeValue(forKey: oldest.key) }
        captures[captured.snapshot.snapshotId]=captured
        return captured.snapshot
    }
    public func perform(_ action: GuestAccessibilityAction, expected: GuestAccessibilitySnapshot) throws {
        try action.validate()
        guard let saved=captures[action.snapshotId], saved.snapshot == expected,
              clock() >= saved.started, clock()-saved.started < 15,
              let old=saved.snapshot.nodes.first(where: { $0.id == action.nodeId }),
              old.states["enabled"] == true, old.actions.contains(action.nativeAction),
              let bounds=old.bounds, bounds.width > 0, bounds.height > 0,
              let element=saved.elements[old.id] else { throw CanaveralError.invalid("Accessibility target is stale or unavailable. Inspect again.") }
        let fresh=try scan()
        guard let current=fresh.snapshot.nodes.first(where: { node in fresh.elements[node.id].map { backend.same(element,$0) } ?? false }) else {
            throw CanaveralError.invalid("Accessibility element was replaced. Inspect again.")
        }
        var previous: GuestAccessibilityNode?=old, next: GuestAccessibilityNode?=current
        while let a=previous, let b=next {
            guard a.attributes == b.attributes, let ea=saved.elements[a.id], let eb=fresh.elements[b.id], backend.same(ea,eb) else {
                throw CanaveralError.invalid("Accessibility target or its context changed. Inspect again.")
            }
            previous=a.parentId.flatMap { id in saved.snapshot.nodes.first { $0.id == id } }
            next=b.parentId.flatMap { id in fresh.snapshot.nodes.first { $0.id == id } }
        }
        guard previous == nil, next == nil, clock() >= saved.started, clock()-saved.started < 15 else {
            throw CanaveralError.invalid("Accessibility target expired or changed context. Inspect again.")
        }
        try Task.checkCancellation()
        // Once dispatch is attempted this snapshot cannot authorize another effect.
        captures.removeValue(forKey: action.snapshotId)
        try backend.perform(element,action:action.nativeAction)
    }
    private func scan() throws -> Capture {
        let started=clock()
        guard started.isFinite, started >= 0 else { throw CanaveralError.unavailable("Guest inspection clock is unavailable.") }
        var nodes: [GuestAccessibilityNode]=[], elements: [String: Backend.Element]=[:], visited: [Int: [Backend.Element]]=[:]
        var truncated=false, unavailable=0, bytes=0
        func walk(_ element: Backend.Element, parent: String?, depth: Int, protected: Bool = false) throws {
            try Task.checkCancellation()
            guard nodes.count < 2000, depth <= 30, clock() >= started, clock()-started < 3 else { truncated=true; return }
            let hash=backend.hash(element)
            if visited[hash,default:[]].contains(where: { backend.same($0,element) }) { truncated=true; return }
            visited[hash,default:[]].append(element)
            do {
                var attributes=try backend.attributes(element)
                let secure=protected || attributes.states["password"] == true
                if secure {
                    attributes.name="[redacted]"; attributes.states["password"]=true
                    let retained: Set<String>=["AXRole","AXSubrole","AXIdentifier","processId","processStartedAt","applicationIdentifier","availableAttributes","nativeActions"]
                    attributes.properties=attributes.properties.filter { retained.contains($0.key) }
                    attributes.properties["value"] = .string("[redacted]")
                }
                let node=GuestAccessibilityNode(id:"ax-\(nodes.count+1)",parentId:parent,depth:depth,attributes:attributes)
                let size=try JSONEncoder().encode(node).count
                guard size <= 65536, bytes+size < 6*1048576-4096 else { truncated=true; return }
                nodes.append(node); elements[node.id]=element; bytes+=size+1
                let children=try backend.children(element,limit:max(0,2000-nodes.count))
                truncated = truncated || children.truncated
                for child in children.elements {
                    if nodes.count >= 2000 || clock()-started >= 3 { truncated=true; break }
                    try walk(child,parent:node.id,depth:depth+1,protected:secure)
                }
            } catch is CancellationError { throw CancellationError() }
            catch { unavailable+=1 }
        }
        for root in try backend.roots() {
            if nodes.count >= 2000 || clock()-started >= 3 { truncated=true; break }
            try walk(root,parent:nil,depth:0)
        }
        let result=GuestAccessibilitySnapshot(nodes:nodes,truncated:truncated,unavailableNodes:unavailable)
        try result.validate()
        return Capture(snapshot:result,started:started,elements:elements)
    }
}
