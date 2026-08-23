import XCTest
@testable import MrOttoIsland

final class CodableTests: XCTestCase {
  func testDecodeFleet() throws {
    let line = #"{"type":"state","state":{"agents":[{"sessionId":"s1","title":"改点东西","phase":"active","currentTool":{"verb":"终端","target":"npm test"},"turnStartedAt":1000,"pendingApproval":null},{"sessionId":"s2","title":null,"phase":"approval","currentTool":null,"turnStartedAt":null,"pendingApproval":{"callId":"c9","verb":"写入","target":"foo.ts","fullPath":"src/foo.ts"}}],"focusedSessionId":"s1"}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    XCTAssertEqual(inbound.state.agents.count, 2)
    XCTAssertEqual(inbound.state.focusedSessionId, "s1")
    XCTAssertEqual(inbound.state.agents[0].currentTool, ToolRef(verb: "终端", target: "npm test"))
    XCTAssertNil(inbound.state.agents[1].title)
    XCTAssertEqual(inbound.state.agents[1].pendingApproval,
                   PendingApproval(callId: "c9", verb: "写入", target: "foo.ts", fullPath: "src/foo.ts"))
  }

  func testOutboundJSON() throws {
    let line = Outbound.approve(sessionId: "s", callId: "c", grant: "session").jsonLine()
    let o = try JSONSerialization.jsonObject(with: line.data(using: .utf8)!) as! [String: Any]
    XCTAssertEqual(o["type"] as? String, "approve")
    XCTAssertEqual(o["grant"] as? String, "session")
  }
}
