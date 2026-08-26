// 被挡下的握手怎么变成"用户看得见的东西"(issue #485)。
//
// 这一层唯一的难点是**它天然会被重复调用**:传输层退避重连,每重连一次就重新
// 握手一次,没配对的话每一次都被挡。下面第一组用例就是钉这件事的。

import { describe, expect, it } from "vitest";
import {
  REJECTION_COOLDOWN_MS,
  createRejectionLedger,
  visibleRejection,
} from "../../src/main/remoteRejections.js";
import type { RemotePeerInfo } from "../../src/shared/shellBridge.js";

function peer(over: Partial<RemotePeerInfo> = {}): RemotePeerInfo {
  return { deviceId: "m1", label: "iPhone", lastSeen: "2026-08-26T00:00:00Z", code: "097162", pinned: false, ...over };
}

describe("createRejectionLedger", () => {
  it("重连风暴里只通知第一次", () => {
    let t = 1_000;
    const ledger = createRejectionLedger({ now: () => t });
    expect(ledger.record({ deviceId: "m1", reason: "unpaired" })).toBe(true);
    for (let i = 0; i < 20; i++) {
      t += 5_000; // 退避重连的节奏
      expect(ledger.record({ deviceId: "m1", reason: "unpaired" })).toBe(false);
    }
  });

  it("过了冷却期再通知一次 —— 人可能已经离开又回来了", () => {
    let t = 1_000;
    const ledger = createRejectionLedger({ now: () => t });
    ledger.record({ deviceId: "m1", reason: "unpaired" });
    t += REJECTION_COOLDOWN_MS;
    expect(ledger.record({ deviceId: "m1", reason: "unpaired" })).toBe(true);
  });

  it("身份对不上不被「还没配对」的冷却期压住 —— 那是告警,不是同一件事", () => {
    const ledger = createRejectionLedger({ now: () => 1_000 });
    expect(ledger.record({ deviceId: "m1", reason: "unpaired" })).toBe(true);
    expect(ledger.record({ deviceId: "m1", reason: "identity-mismatch" })).toBe(true);
  });

  it("另一台设备各算各的冷却期", () => {
    const ledger = createRejectionLedger({ now: () => 1_000 });
    expect(ledger.record({ deviceId: "m1", reason: "unpaired" })).toBe(true);
    expect(ledger.record({ deviceId: "m2", reason: "unpaired" })).toBe(true);
  });

  it("latest 记的是最近一次,不管它有没有过闸", () => {
    let t = 1_000;
    const ledger = createRejectionLedger({ now: () => t });
    ledger.record({ deviceId: "m1", reason: "unpaired" });
    t = 2_000;
    ledger.record({ deviceId: "m1", reason: "unpaired" }); // 被冷却期吃掉
    expect(ledger.latest()).toEqual({ deviceId: "m1", reason: "unpaired", at: 2_000 });
  });

  it("没被挡过就是 null", () => {
    expect(createRejectionLedger({ now: () => 1 }).latest()).toBeNull();
  });
});

describe("visibleRejection", () => {
  it("这台设备后来配上了就不显示 —— 提示不该在问题解决之后还挂着", () => {
    const latest = { deviceId: "m1", reason: "unpaired" as const, at: 1 };
    expect(visibleRejection(latest, [peer({ pinned: true })])).toBeNull();
  });

  it("还没配上就一直显示", () => {
    const latest = { deviceId: "m1", reason: "unpaired" as const, at: 1 };
    expect(visibleRejection(latest, [peer({ pinned: false })])).toEqual(latest);
  });

  it("被挡的是第二台手机时,第一台配上了也照样显示", () => {
    // 一台桌面只 pin 得住一把公钥,所以第二台是永久被拒的 —— 而"握手成功就清提示"
    // 会让第一台每次连上来都把第二台那条抹掉。这条用例钉的就是那个坑
    const latest = { deviceId: "m2", reason: "identity-mismatch" as const, at: 1 };
    const peers = [peer({ deviceId: "m1", pinned: true }), peer({ deviceId: "m2", pinned: false })];
    expect(visibleRejection(latest, peers)).toEqual(latest);
  });

  it("目录里根本没有这台设备时照样显示 —— 它敲过门是事实", () => {
    const latest = { deviceId: "ghost", reason: "unpaired" as const, at: 1 };
    expect(visibleRejection(latest, [peer({ pinned: true })])).toEqual(latest);
  });
});
