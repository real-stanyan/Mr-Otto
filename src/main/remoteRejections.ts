// 被挡下的握手 → 用户看得见的东西(issue #485)。
//
// 桥每被敲一次门就报一次(remoteBridge 的 onRejected,刻意不节流),而传输层是
// 退避重连的:手机开着、桌面没配对,这个回调一分钟能来好几次。所以这一层的
// 全部职责就是**别把它变成通知风暴**,以及**别让提示在问题解决之后还挂着**。
//
// 纯逻辑,不碰 Electron:时间由调用方注入,通知怎么发在 index.ts 那一侧。

import type { RemotePeerInfo, RemoteRejection } from "../shared/shellBridge.js";

/** 同一台设备的同一种拒绝,这段时间内只通知一次。
    10 分钟是按"人回到桌面前"的尺度选的:再短就是风暴,再长的话用户配对失败后
    换台手机再试,第二次会被自己的冷却期吃掉 */
export const REJECTION_COOLDOWN_MS = 10 * 60_000;

/** 去重的键。deviceId + reason —— 换了原因要能重新通知:
    "还没配对"和"身份对不上"是两件事,后者是告警,不该被前者的冷却期压住 */
function key(r: { deviceId: string; reason: RemoteRejection["reason"] }): string {
  return `${r.deviceId} ${r.reason}`;
}

export function createRejectionLedger(deps: {
  now: () => number;
  cooldownMs?: number;
}): {
  /** 记一次被挡下的握手。返回 true = 该发系统通知(第一次 / 过了冷却期) */
  record(r: { deviceId: string; reason: RemoteRejection["reason"] }): boolean;
  /** 最近一次被挡下的握手;null = 这一轮启动以来没有过 */
  latest(): RemoteRejection | null;
} {
  const cooldown = deps.cooldownMs ?? REJECTION_COOLDOWN_MS;
  const notifiedAt = new Map<string, number>();
  let last: RemoteRejection | null = null;

  return {
    record(r) {
      const at = deps.now();
      last = { deviceId: r.deviceId, reason: r.reason, at };
      const prev = notifiedAt.get(key(r));
      if (prev !== undefined && at - prev < cooldown) return false;
      notifiedAt.set(key(r), at);
      return true;
    },
    latest() {
      return last;
    },
  };
}

/**
 * 设置页真正该看到的那一条 —— **从"目录里这台设备现在配没配上"现推**,
 * 而不是在配对成功时去清一个标志位。
 *
 * 为什么不清标志位:一台桌面只 pin 得住一把公钥(peerIdentity 是单值),所以
 * 第二台手机是**永久**被拒的。"握手成功就清提示"会让第一台手机每次连上来
 * 都把第二台的提示抹掉 —— 而第二台那条恰恰是用户唯一需要看见的。
 * 按 deviceId 现算就没有这个问题:配上了自然不显示,没配上一直显示。
 */
export function visibleRejection(
  latest: RemoteRejection | null,
  peers: RemotePeerInfo[]
): RemoteRejection | null {
  if (!latest) return null;
  const peer = peers.find((p) => p.deviceId === latest.deviceId);
  return peer?.pinned ? null : latest;
}
