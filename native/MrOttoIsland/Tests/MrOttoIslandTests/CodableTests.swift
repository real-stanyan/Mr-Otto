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

  /// #1229:额度页脚。主进程算好拍平,这边纯渲染——所以解码要把每一格都解出来。
  func testDecodeFleetRailQuota() throws {
    let line = #"{"type":"state","state":{"agents":[],"focusedSessionId":null,"unreadMentions":3,"rail":{"kind":"quota","plan":"pro","pastDue":false,"windowLabel":"5h","remainPercent":22,"remainLabel":"22.0%","tone":"warn","exhausted":false,"countdown":"1h 38m 后刷新","title":"已用 243 / 311.5 credit"}}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    let rail = try XCTUnwrap(inbound.state.rail)
    XCTAssertTrue(rail.isQuota)
    XCTAssertEqual(rail.plan, "pro")
    XCTAssertEqual(rail.windowLabel, "5h")
    XCTAssertEqual(rail.remainLabel, "22.0%")
    XCTAssertEqual(rail.tone, .warn)
    XCTAssertEqual(rail.countdown, "1h 38m 后刷新")
    XCTAssertEqual(inbound.state.unreadMentions, 3)
  }

  /// spend 那一支(没订阅但跑过计费调用):报 token 不报钱,quota 那几格全缺席。
  func testDecodeFleetRailSpend() throws {
    let line = #"{"type":"state","state":{"agents":[],"focusedSessionId":null,"rail":{"kind":"spend","plan":"free","tokens":38000,"tokensLabel":"38K","calls":38,"title":"近 7 天 38,000 tokens · 38 次调用"}}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    let rail = try XCTUnwrap(inbound.state.rail)
    XCTAssertFalse(rail.isQuota)
    XCTAssertEqual(rail.tokensLabel, "38K")
    XCTAssertEqual(rail.calls, 38)
    XCTAssertNil(rail.remainLabel)
  }

  /// 旧主进程不带这两格:解码不能炸,两格都是 nil = 不画
  /// (协议向后兼容,同 SessionEvent 的规矩)。**nil 与 0 不是一回事** ——
  /// 「还没查到」和「查到了,是零」在这枚角标上该做的事相反。
  func testDecodeFleetWithoutRailFields() throws {
    let line = #"{"type":"state","state":{"agents":[],"focusedSessionId":null}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    XCTAssertNil(inbound.state.rail)
    XCTAssertNil(inbound.state.unreadMentions)
  }

  /// #1229:每行自带「归哪一档」+ 组头。旧主进程不带 → 回落项目档、
  /// 组头照旧从路径末段推(改动前的行为)。
  func testDecodeAgentTabAndGroupLabel() throws {
    let line = #"{"type":"state","state":{"agents":[{"sessionId":"c1","title":null,"phase":"idle","currentTool":null,"turnStartedAt":null,"pendingApproval":null,"workspace":"/__otto-cloud-session__/wk-9f1c","kind":"team","groupLabel":"Otto 核心组"},{"sessionId":"s2","title":null,"phase":"idle","currentTool":null,"turnStartedAt":null,"pendingApproval":null,"workspace":"/Users/x/Github/Mr_Otto"}],"focusedSessionId":null}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    XCTAssertEqual(inbound.state.agents[0].tab, .team)
    XCTAssertEqual(inbound.state.agents[0].workspaceLabel, "Otto 核心组")
    // 旧主进程那一行:回落项目档,组头仍从路径末段推
    XCTAssertEqual(inbound.state.agents[1].tab, .project)
    XCTAssertEqual(inbound.state.agents[1].workspaceLabel, "Mr_Otto")
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

  /// #690:projectRoot / branch 是后加的可选字段。带上时组头名与分组键取项目根,
  /// 分支拿来画行上那枚 chip。
  func testDecodeAgentProjectRootAndBranch() throws {
    let line = #"{"type":"state","state":{"agents":[{"sessionId":"s1","title":null,"phase":"idle","currentTool":null,"turnStartedAt":null,"pendingApproval":null,"workspace":"/Users/x/Library/Application Support/Mr Otto/worktrees/d3dbc74d37b3-a29018","projectRoot":"/Users/x/Github/Mr_Otto","branch":"otto/friends-a29018"}],"focusedSessionId":null}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    let a = inbound.state.agents[0]
    XCTAssertEqual(a.projectRoot, "/Users/x/Github/Mr_Otto")
    XCTAssertEqual(a.branch, "otto/friends-a29018")
    // 组头名是**项目**末段,不是副本目录名——这条正是 #690 要修的那个回归
    XCTAssertEqual(a.workspaceLabel, "Mr_Otto")
    XCTAssertEqual(a.groupKey, "/Users/x/Github/Mr_Otto")
  }

  /// 旧主进程不带 projectRoot:回落 workspace,岛的行为与引入这个字段之前逐字一致。
  func testDecodeAgentFallsBackToWorkspaceWithoutProjectRoot() throws {
    let line = #"{"type":"state","state":{"agents":[{"sessionId":"s1","title":null,"phase":"idle","currentTool":null,"turnStartedAt":null,"pendingApproval":null,"workspace":"/Users/x/Github/Mr_Otto"}],"focusedSessionId":null}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    let a = inbound.state.agents[0]
    XCTAssertNil(a.projectRoot)
    XCTAssertNil(a.branch)
    XCTAssertEqual(a.workspaceLabel, "Mr_Otto")
    XCTAssertEqual(a.groupKey, "/Users/x/Github/Mr_Otto")
  }

  /// workspace 也没有的史前会话:归"其他"组,不炸。
  func testDecodeAgentWithoutAnyPath() throws {
    let line = #"{"type":"state","state":{"agents":[{"sessionId":"s1","title":null,"phase":"idle","currentTool":null,"turnStartedAt":null,"pendingApproval":null}],"focusedSessionId":null}}"#
    let inbound = try JSONDecoder().decode(Inbound.self, from: line.data(using: .utf8)!)
    XCTAssertEqual(inbound.state.agents[0].workspaceLabel, "其他")
    XCTAssertEqual(inbound.state.agents[0].groupKey, "其他")
  }

  func testOutboundJSON() throws {
    let line = Outbound.approve(sessionId: "s", callId: "c", grant: "session").jsonLine()
    let o = try JSONSerialization.jsonObject(with: line.data(using: .utf8)!) as! [String: Any]
    XCTAssertEqual(o["type"] as? String, "approve")
    XCTAssertEqual(o["grant"] as? String, "session")
  }
}
