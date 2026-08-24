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

  /// #199:display/usage 是后加的可选字段。带上时要解出来——
  /// usage 行给用量表,display 决定展开态上半区画哪个。
  func testDecodeFleetWithUsage() throws {
    let line = #"{"type":"state","state":{"agents":[],"focusedSessionId":null,"display":"usage","usage":[{"label":"DeepSeek V4 Flash","provider":"deepseek","today":1200,"d7":34000,"d14":56000}]}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    XCTAssertEqual(inbound.state.display, .usage)
    XCTAssertEqual(inbound.state.usage,
                   [UsageRow(label: "DeepSeek V4 Flash", provider: "deepseek",
                             today: 1200, d7: 34000, d14: 56000)])
  }

  /// 旧主进程不带新字段:解码不能炸,display 兜底 sessions、usage 兜底空表
  /// (协议向后兼容,同 SessionEvent 的规矩)。
  func testDecodeFleetWithoutUsageFields() throws {
    let line = #"{"type":"state","state":{"agents":[],"focusedSessionId":null}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    XCTAssertEqual(inbound.state.display, .sessions)
    XCTAssertEqual(inbound.state.usage, [])
  }

  /// #206:workspace 是分组键,主进程带全路径;旧主进程不带 → nil,解码不炸。
  func testDecodeAgentWorkspace() throws {
    let with = #"{"type":"state","state":{"agents":[{"sessionId":"s1","title":null,"phase":"idle","currentTool":null,"turnStartedAt":null,"pendingApproval":null,"workspace":"/Users/x/Github/Mr_Otto"}],"focusedSessionId":null}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: with.data(using: .utf8)!)
    XCTAssertEqual(inbound.state.agents[0].workspace, "/Users/x/Github/Mr_Otto")

    let without = #"{"type":"state","state":{"agents":[{"sessionId":"s1","title":null,"phase":"idle","currentTool":null,"turnStartedAt":null,"pendingApproval":null}],"focusedSessionId":null}}"#
    let old = try JSONDecoder().decode(Inbound.self, from: without.data(using: .utf8)!)
    XCTAssertNil(old.state.agents[0].workspace)
  }

  /// #345:turnDiff 是后加的可选字段("N 文件 +A −D" 摘要)。带上要解出来,
  /// 旧主进程不带 → nil,解码不炸(协议向后兼容,同 workspace 的规矩)。
  func testDecodeAgentTurnDiff() throws {
    let with = #"{"type":"state","state":{"agents":[{"sessionId":"s1","title":null,"phase":"active","currentTool":null,"turnStartedAt":null,"pendingApproval":null,"turnDiff":{"files":3,"additions":120,"deletions":45}}],"focusedSessionId":null}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: with.data(using: .utf8)!)
    XCTAssertEqual(inbound.state.agents[0].turnDiff,
                   TurnDiffSummary(files: 3, additions: 120, deletions: 45))

    let without = #"{"type":"state","state":{"agents":[{"sessionId":"s1","title":null,"phase":"idle","currentTool":null,"turnStartedAt":null,"pendingApproval":null}],"focusedSessionId":null}}"#
    let old = try JSONDecoder().decode(Inbound.self, from: without.data(using: .utf8)!)
    XCTAssertNil(old.state.agents[0].turnDiff)
  }

  func testOutboundJSON() throws {
    let line = Outbound.approve(sessionId: "s", callId: "c", grant: "session").jsonLine()
    let o = try JSONSerialization.jsonObject(with: line.data(using: .utf8)!) as! [String: Any]
    XCTAssertEqual(o["type"] as? String, "approve")
    XCTAssertEqual(o["grant"] as? String, "session")
  }
}
