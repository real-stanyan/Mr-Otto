// friendNotifier — 好友动静 → 系统通知的判定层(ADR-0027)。
// 纯函数在上,碰 Electron 的组装在下(同 supabaseFriendsApi 的分层),单测只吃上半段。
//
// 判定原则:通知是打断,不是日志。只在**窗口没聚焦**时发,而且只发"新出现的东西"——
// 快照式推送(好友请求)每次都是全量,不做差集会把同一条请求反复弹出来。

import type { FriendsSnapshot } from "../shared/friends.js";
import type { NotificationTarget } from "../shared/shellBridge.js";

/** 一条待发的系统通知。target 决定用户点它之后落到哪个面板 */
export interface NotifySpec {
  title: string;
  body: string;
  target: NotificationTarget;
  /** macOS 系统音名(如 "Glass")。不设 = 静默——好友类通知一直没有声音,保持原样 */
  sound?: string;
}

/** 通知正文最多这么长,再长就截断——通知中心本来也不给显示完 */
const BODY_MAX = 120;

export function truncate(text: string, max = BODY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function dmNotification(senderName: string, body: string, friendId: string): NotifySpec {
  return { title: senderName || "好友", body: truncate(body), target: { kind: "dm", friendId } };
}

export function friendRequestNotification(name: string): NotifySpec {
  return { title: "新的好友请求", body: truncate(`${name || "有人"} 想加你好友`), target: { kind: "friendRequest" } };
}

/** 会话类通知的四个音各管一件事(听声辨事,mac 系统音名,win 播同名 wav):
    完成 Funk / 失败 Sosumi / 审批 Ping / 问题 Pop */
function sessionNotification(
  sessionTitle: string | null,
  suffix: string,
  body: string,
  sessionId: string,
  sound: string
): NotifySpec {
  return {
    title: `${truncate(sessionTitle ?? "", 40) || "会话"} · ${suffix}`,
    body: truncate(body),
    target: { kind: "session", sessionId },
    sound,
  };
}

/** turn 正常收口(outcome=completed)的完成通知(issue #290)。文件名虽叫 friend——
    它实际是"系统通知判定层"(ADR-0027),完成通知走同一套聚焦判定/点击落点。
    带提示音:完成是用户在等的事,不同于好友动静的静默角标 */
export function turnCompleteNotification(
  sessionTitle: string | null,
  userText: string,
  sessionId: string
): NotifySpec {
  return sessionNotification(sessionTitle, "任务完成", userText, sessionId, "Funk");
}

/** turn 抛错(outcome=error)。aborted 不通知——停止是用户自己按的 */
export function turnFailedNotification(
  sessionTitle: string | null,
  errText: string,
  sessionId: string
): NotifySpec {
  return sessionNotification(sessionTitle, "任务失败", errText || "任务中途出错了", sessionId, "Sosumi");
}

/** 危险操作等审批:agent 停在原地等人,比完成更值得把人叫回来 */
export function approvalRequestNotification(
  sessionTitle: string | null,
  toolName: string,
  sessionId: string
): NotifySpec {
  return sessionNotification(sessionTitle, "等待审批", `Mr Otto 想用 ${toolName},回来批一下`, sessionId, "Ping");
}

/** ask_user 提问:同审批,turn 悬停在等人回答 */
export function askUserNotification(
  sessionTitle: string | null,
  question: string,
  sessionId: string
): NotifySpec {
  return sessionNotification(sessionTitle, "有问题问你", question || "Mr Otto 有问题要问你", sessionId, "Pop");
}

/** 一台手机来握手被挡下了(issue #485)。点通知落到设置页「手机」栏目——
    这两种情况该做的事都在那一页上(核对安全码 / 看清是哪台设备)。

    **静默**:上面那四个音各自钉着一件会话里的事(听声辨事),给远程再借一个
    会把那套对应关系搅浑。提示的强度靠"通知 + 设置页横幅"两处同时在,不靠响声。 */
export function remotePairingNotification(reason: "unpaired" | "identity-mismatch"): NotifySpec {
  const target: NotificationTarget = { kind: "settings", section: "remote" };
  return reason === "unpaired"
    ? {
        title: "有手机想连上来",
        body: truncate("它还没配对过。去「设置 → 手机」核对 6 位安全码。"),
        target,
      }
    : {
        // 告警语气:这条也可能只是手机重装,但分不出来——文案不替用户下结论
        title: "有手机连不上来:身份对不上",
        body: truncate("它的身份跟已配对的那把公钥不一致。你刚重装过手机端就重新核对安全码;没有的话,这是有人在中间换了公钥。"),
        target,
      };
}

/** 两次快照之间**新增**的收到请求(按 friendshipId 差集)。全量推送的去重口 */
export function newIncomingRequests(prev: FriendsSnapshot | null, next: FriendsSnapshot): string[] {
  if (!prev) return []; // 第一份快照是"补课",不是"来了新东西",不该弹一屏通知
  const had = new Set(prev.incoming.map((e) => e.friendshipId));
  return next.incoming.filter((e) => !had.has(e.friendshipId)).map((e) => e.friendshipId);
}

/** Electron 侧的接线口:窗口聚焦时不弹横幅只响声,点通知则聚焦窗口 + 告诉渲染层去哪 */
export interface NotifierDeps {
  /** 窗口是否正被用户看着 */
  isFocused(): boolean;
  /** 真发一条系统通知;点击回调由组装层接到 focus + IPC 上。
      失焦时的声音也归它按平台播(mac 原生音名 / win 静默 toast + 渲染层 wav) */
  show(spec: NotifySpec, onClick: () => void): void;
  /** 用户点了通知:聚焦窗口并把 target 推给渲染层 */
  activate(target: NotificationTarget): void;
  /** 只响声不弹横幅(聚焦分支):渲染层播同名 wav,mac/win 一条路径 */
  playSound(sound: string): void;
}

export function createNotifier(deps: NotifierDeps): (spec: NotifySpec) => void {
  return (spec) => {
    if (deps.isFocused()) {
      // 人就在屏幕前:横幅是重复(答案/审批卡已经渲染出来了),但声音留着——
      // 盯着别的窗口时靠听声辨事。好友类通知本来就没声,维持完全静默
      if (spec.sound) deps.playSound(spec.sound);
      return;
    }
    deps.show(spec, () => deps.activate(spec.target));
  };
}
