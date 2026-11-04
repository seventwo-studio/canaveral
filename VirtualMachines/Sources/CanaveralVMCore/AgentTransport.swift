import Foundation
public protocol AgentTransport: Sendable {
    func request(_ payload: JSONValue) async throws -> JSONValue
}
