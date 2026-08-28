import Foundation

enum Phase: String, Codable { case idle, active, approval }

struct ToolRef: Codable, Equatable { let verb: String; let target: String }

struct PendingApproval: Codable, Equatable {
  let callId: String
  let verb: String
  let target: String
  let fullPath: String?
}

/// 本轮聚合改动摘要(issue #345):"N 文件 +A −D"。主进程从 turn 级聚合 diff
/// 拍平——与主窗对话视图消费同一份推送,两处数字必然一致。
struct TurnDiffSummary: Codable, Equatable {
  let files: Int
  let additions: Int
  let deletions: Int
}

/// 一只水獭(一个 session)在灵动岛里的状态。
/// workspace = 工程文件夹全路径(旧主进程不带 → nil,
/// synthesized Codable 对 Optional 走 decodeIfPresent,天然向后兼容)。
struct IslandAgent: Codable, Equatable, Identifiable {
  let sessionId: String
  let title: String?
  let phase: Phase
  let currentTool: ToolRef?
  let turnStartedAt: Double?
  let pendingApproval: PendingApproval?
  var workspace: String?
  /// 所属**项目**根目录全路径:worktree 折回主仓,主进程算好(main/workspaceLens.ts)。
  /// 分组键与组头名都取它——每只水獭一份独立 worktree 之后(ADR-0157),按 workspace
  /// 分组会让组头变成副本目录名的哈希,同一个项目还裂成 N 组。
  /// Optional → 旧主进程不带时回落 workspace,岛的行为与从前逐字一致。
  var projectRoot: String?
  /// 这只水獭在一份独立副本上干活时的当前分支名;不是副本 → nil。
  /// 折回项目分组之后,"这一行在副本上"就只剩行上这枚 chip 能说了。
  var branch: String?
  /// Optional → decodeIfPresent,旧主进程不带此字段照常解码(向后兼容同 workspace)
  var turnDiff: TurnDiffSummary?
  var id: String { sessionId }

  /// 分组键:项目根优先,回落 workspace(旧主进程),都没有归"其他"。
  var groupKey: String { projectRoot ?? workspace ?? "其他" }

  /// 组头显示名:项目根的路径末段。nil(旧主进程且无 workspace)归到"其他"组。
  var workspaceLabel: String {
    guard let path = projectRoot ?? workspace else { return "其他" }
    return (path as NSString).lastPathComponent
  }
}

/// 展开态上半区画哪个(#199):会话列表 or 用量表。设置页切,主进程随快照推。
enum Display: String, Codable { case sessions, usage }

/// 用量表的一行:一个模型在 今天/7天/14天 三个窗口的 token 合计。
/// label 是主进程拍平好的目录显示名,这边纯渲染;provider 是厂商 id,
/// 对应资源 bundle 里 providers/<id>.png 的 logo(#209;Optional 向后兼容)。
struct UsageRow: Codable, Equatable, Identifiable {
  let label: String
  var provider: String?
  let today: Double
  let d7: Double
  let d14: Double
  var id: String { label }
}

/// 主进程推来的全量快照:所有 session 的列表 + 主窗当前聚焦的那个。
/// display/usage 是后加字段:旧主进程不带,解码兜底 sessions/空表——
/// NDJSON 协议向后兼容(同 SessionEvent 的规矩)。
struct IslandFleet: Codable, Equatable {
  let agents: [IslandAgent]
  let focusedSessionId: String?
  let display: Display
  let usage: [UsageRow]

  init(agents: [IslandAgent], focusedSessionId: String?,
       display: Display = .sessions, usage: [UsageRow] = []) {
    self.agents = agents
    self.focusedSessionId = focusedSessionId
    self.display = display
    self.usage = usage
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    agents = try c.decode([IslandAgent].self, forKey: .agents)
    focusedSessionId = try c.decodeIfPresent(String.self, forKey: .focusedSessionId)
    display = try c.decodeIfPresent(Display.self, forKey: .display) ?? .sessions
    usage = try c.decodeIfPresent([UsageRow].self, forKey: .usage) ?? []
  }
}

/// 主进程 → helper
struct Inbound: Codable { let type: String; let state: IslandFleet }

/// helper → 主进程
enum Outbound {
  case ready
  case send(sessionId: String, text: String)
  case approve(sessionId: String, callId: String, grant: String?)
  case deny(sessionId: String, callId: String)
  /// 点列表行(#210):请主窗聚焦并切到这个会话
  case focusSession(sessionId: String)

  func jsonLine() -> String {
    let obj: [String: Any]
    switch self {
    case .ready: obj = ["type": "ready"]
    case let .send(s, t): obj = ["type": "send", "sessionId": s, "text": t]
    case let .focusSession(s): obj = ["type": "focusSession", "sessionId": s]
    case let .approve(s, c, g):
      var o: [String: Any] = ["type": "approve", "sessionId": s, "callId": c]
      if let g { o["grant"] = g }
      obj = o
    case let .deny(s, c): obj = ["type": "deny", "sessionId": s, "callId": c]
    }
    let data = try! JSONSerialization.data(withJSONObject: obj)
    return String(data: data, encoding: .utf8)! + "\n"
  }
}
