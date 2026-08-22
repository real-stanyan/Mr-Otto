import XCTest
@testable import MrOttoIsland

final class CodableTests: XCTestCase {
  func testDecodeStateLine() throws {
    let line = #"{"type":"state","state":{"sessionId":"s","model":"m","phase":"active","currentTool":{"verb":"终端","target":"npm test"},"turnStartedAt":1000,"pendingApproval":null}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    XCTAssertEqual(inbound.state.phase, .active)
    XCTAssertEqual(inbound.state.currentTool, ToolRef(verb: "终端", target: "npm test"))
    XCTAssertNil(inbound.state.pendingApproval)
  }

  func testDecodeApproval() throws {
    let line = #"{"type":"state","state":{"sessionId":"s","model":null,"phase":"approval","currentTool":null,"turnStartedAt":null,"pendingApproval":{"callId":"c9","verb":"写入","target":"foo.ts","fullPath":"src/foo.ts"}}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    XCTAssertEqual(inbound.state.pendingApproval,
                   PendingApproval(callId: "c9", verb: "写入", target: "foo.ts", fullPath: "src/foo.ts"))
  }

  func testOutboundJSON() throws {
    let line = Outbound.approve(sessionId: "s", callId: "c", grant: "session").jsonLine()
    let o = try JSONSerialization.jsonObject(with: line.data(using: .utf8)!) as! [String: Any]
    XCTAssertEqual(o["type"] as? String, "approve")
    XCTAssertEqual(o["grant"] as? String, "session")
  }
}
