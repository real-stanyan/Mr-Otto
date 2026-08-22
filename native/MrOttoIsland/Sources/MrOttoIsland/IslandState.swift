import Foundation

enum Phase: String, Codable { case idle, active, approval }

struct ToolRef: Codable, Equatable { let verb: String; let target: String }

struct PendingApproval: Codable, Equatable {
  let callId: String
  let verb: String
  let target: String
  let fullPath: String?
}

struct IslandSnapshot: Codable, Equatable {
  let sessionId: String?
  let model: String?
  let phase: Phase
  let currentTool: ToolRef?
  let turnStartedAt: Double?
  let pendingApproval: PendingApproval?
}

/// 主进程 → helper
struct Inbound: Codable { let type: String; let state: IslandSnapshot }

/// helper → 主进程
enum Outbound {
  case ready
  case send(sessionId: String, text: String)
  case approve(sessionId: String, callId: String, grant: String?)
  case deny(sessionId: String, callId: String)

  func jsonLine() -> String {
    let obj: [String: Any]
    switch self {
    case .ready: obj = ["type": "ready"]
    case let .send(s, t): obj = ["type": "send", "sessionId": s, "text": t]
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
