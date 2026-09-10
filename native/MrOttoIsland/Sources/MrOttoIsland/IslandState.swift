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
  /// 这一行归顶栏哪一档(#1229)。旧主进程不带 → nil,`tab` 里回落成 .project,
  /// 也就是改动前的行为(那时只有一份平铺的列表)。
  var kind: IslandTab?
  /// 组头写什么。主进程给了就用它,没给(旧主进程,或任务档那种不分组的)
  /// 回落到路径末段。**「这一档要不要画组头」不看这个字段看 `tab`** ——
  /// JSON 的 `null` 与「字段缺席」在 Swift 里都是 nil,拿它当判据的话
  /// 旧主进程推来的行会被当成「不分组」,而那时的行为是分组的。
  var groupLabel: String?
  var id: String { sessionId }

  /// 归哪一档;旧主进程不带 → 项目档
  var tab: IslandTab { kind ?? .project }

  /// 分组键:项目根优先,回落 workspace(旧主进程),都没有归"其他"。
  var groupKey: String { projectRoot ?? workspace ?? "其他" }

  /// 组头显示名:主进程给了就用它(#1229——云会话那一组的组头必须是团队名,
  /// 而它的 workspace 是一串合成路径,末段是 UUID),否则退回项目根的路径末段。
  /// 都没有归"其他"组。
  var workspaceLabel: String {
    if let label = groupLabel, !label.isEmpty { return label }
    guard let path = projectRoot ?? workspace else { return "其他" }
    return (path as NSString).lastPathComponent
  }
}

/// 展开态顶栏那三档(#1229),与侧栏那枚切换器同一套分法(ADR-0259)。
/// **「此刻在看哪一档」不在线上**:那是 helper 的内存态,同 selectedSessionId /
/// collapsedWorkspaces(ADR-0063)。线上只带「每一行归哪一档」。
enum IslandTab: String, Codable, CaseIterable {
  case task, project, team

  var label: String {
    switch self {
    case .task: return "任务"
    case .project: return "项目"
    case .team: return "团队"
    }
  }
}

/// 额度页脚的语义色档(#1229)。`quotaTone` 的 brand 一档在主进程就映射成了
/// neutral——ADR-0239:一根几乎满格的品牌蓝条会把「一切正常」画得比「快没了」
/// 还响。这一行上的颜色只用来说「出事了」。
enum RailTone: String, Codable { case neutral, warn, deny }

/// 展开态最底下那一条(#1229)。主进程算好拍平(shared/islandRail.ts),
/// 这边**一个判断都不做**——岛是纯渲染(ADR-0063)。
/// 两支:`quota` 有订阅、`spend` 没订阅但跑过计费调用。整条缺席 = 不画。
struct IslandRail: Codable, Equatable {
  let kind: String            // "quota" | "spend"
  let plan: String            // free / lite / pro / max
  /// quota 支
  var pastDue: Bool?
  var windowLabel: String?
  var remainPercent: Double?
  var remainLabel: String?
  var tone: RailTone?
  var exhausted: Bool?
  var countdown: String?
  /// spend 支
  var tokensLabel: String?
  var calls: Int?
  let title: String

  var isQuota: Bool { kind == "quota" }
}

/// 主进程推来的全量快照:所有 session 的列表 + 主窗当前聚焦的那个。
/// rail / unreadMentions 是 #1229 加的可选字段:旧主进程不带,解码兜底 nil ——
/// 两格都是「缺席 = 不画那一格」,NDJSON 协议向后兼容(同 SessionEvent 的规矩)。
struct IslandFleet: Codable, Equatable {
  let agents: [IslandAgent]
  let focusedSessionId: String?
  /// 展开态最底下那一条;nil = 整条不画(billing 还没查到,或既没订阅也没跑过调用)
  let rail: IslandRail?
  /// 「团队」那格右上角那枚未读点的数;nil = 还没查到(与 0 不是一回事,不画)
  let unreadMentions: Int?

  init(agents: [IslandAgent], focusedSessionId: String?,
       rail: IslandRail? = nil, unreadMentions: Int? = nil) {
    self.agents = agents
    self.focusedSessionId = focusedSessionId
    self.rail = rail
    self.unreadMentions = unreadMentions
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    agents = try c.decode([IslandAgent].self, forKey: .agents)
    focusedSessionId = try c.decodeIfPresent(String.self, forKey: .focusedSessionId)
    rail = try c.decodeIfPresent(IslandRail.self, forKey: .rail)
    unreadMentions = try c.decodeIfPresent(Int.self, forKey: .unreadMentions)
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
