// cloudSessionState —— 云会话客户端那一格的两条状态规则 + 两句文案（#1356 A1）。
// 规则原来长在桌面 store 的回调里（那边的集成测试照旧在 tests/renderer/ 里跑），
// 这份钉的是规则本身：手机端的 chat store 用的是同一份函数。

import { describe, expect, it } from "vitest";
import {
  applyCloudStatus, cloudDeniedText, insertCloudEvent, unknownSendNote, type CloudSessionCore,
} from "../../src/shared/cloudSessionState.js";
import { CS_PROTOCOL_VERSION } from "../../src/shared/remote/cloudSession.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { CloudSessionStatus } from "../../src/shared/shellBridge.js";

const ev = (seq: number): SessionEvent =>
  ({ type: "session_archived", seq, sessionId: "s1", ts: 1000 + seq, by: "user" }) as unknown as SessionEvent;
const seqs = (es: readonly SessionEvent[] | null) => es?.map((e) => e.seq) ?? null;

describe("insertCloudEvent", () => {
  it("空的与比末尾大的走追加", () => {
    expect(seqs(insertCloudEvent([], ev(0)))).toEqual([0]);
    expect(seqs(insertCloudEvent([ev(0), ev(1)], ev(5)))).toEqual([0, 1, 5]);
  });
  it("同一个 seq 再来一次回 null（:gone 之后重连会把 backlog 全量再推一遍）", () => {
    expect(insertCloudEvent([ev(0), ev(1), ev(2)], ev(1))).toBeNull();
    expect(insertCloudEvent([ev(0), ev(1), ev(2)], ev(2))).toBeNull();
    expect(insertCloudEvent([ev(0)], ev(0))).toBeNull();
  });
  it("往前翻的那一页落在前面：按 seq 升序到达的一页逐条插，结果仍然升序", () => {
    let es: SessionEvent[] = [ev(10), ev(11)];
    for (const s of [3, 4, 5]) es = insertCloudEvent(es, ev(s))!;
    expect(seqs(es)).toEqual([3, 4, 5, 10, 11]);
  });
  it("插在中间", () => {
    expect(seqs(insertCloudEvent([ev(1), ev(5)], ev(3)))).toEqual([1, 3, 5]);
  });
  it("不改入参（store 靠引用变化判断要不要重画）", () => {
    const before = [ev(1), ev(5)];
    insertCloudEvent(before, ev(3));
    expect(seqs(before)).toEqual([1, 5]);
  });
});

const core = (o: Partial<CloudSessionCore> = {}): CloudSessionCore => ({
  workspaceId: "w1", sessionId: "s1", state: "connecting",
  initiatorUid: null, ownerUid: "", selfUid: "me",
  modelRoute: null, gapNote: null, chat: undefined, hasOlder: false,
  ...o,
});
const status = (o: Partial<CloudSessionStatus> = {}): CloudSessionStatus => ({
  workspaceId: "w1", sessionId: "s1", state: "ready",
  initiatorUid: "u1", ownerUid: "owner", selfUid: "me", modelRoute: null,
  ...o,
});

describe("applyCloudStatus", () => {
  it("state / initiator / owner / self / modelRoute 照抄", () => {
    const next = applyCloudStatus(core(), status({ modelRoute: { kind: "blocked", reason: "x" } as never }));
    expect(next).toMatchObject({ state: "ready", initiatorUid: "u1", ownerUid: "owner", selfUid: "me" });
    expect(next.modelRoute).toEqual({ kind: "blocked", reason: "x" });
  });
  it("gapNote / hasOlder 照抄推送、**缺席即结论**（补齐了就不带，留旧值等于说一句不成立的话）", () => {
    const withGap = applyCloudStatus(core(), status({ gapNote: "缺了 3 条", hasOlder: true }));
    expect(withGap.gapNote).toBe("缺了 3 条");
    expect(withGap.hasOlder).toBe(true);
    const healed = applyCloudStatus(withGap, status());
    expect(healed.gapNote).toBeNull();
    expect(healed.hasOlder).toBe(false);
  });
  it("chat **缺席就留着种子**（#1301：welcome 每条连接只说一次），null / 值才覆盖", () => {
    const seeded = core({ chat: { kind: "dm", agentIds: ["a_000000000001"] } });
    expect(applyCloudStatus(seeded, status()).chat).toEqual({ kind: "dm", agentIds: ["a_000000000001"] });
    expect(applyCloudStatus(seeded, status({ chat: null })).chat).toBeNull();
    const group = { kind: "group" as const, agentIds: ["admin", "a_000000000001"] };
    expect(applyCloudStatus(core(), status({ chat: group })).chat).toEqual(group);
  });
  it("deniedCode / deniedServerVersion 来了才覆盖、没来就留着", () => {
    const denied = applyCloudStatus(core(), status({ state: "denied", deniedCode: "version_mismatch", deniedServerVersion: 19 }));
    expect(denied.deniedCode).toBe("version_mismatch");
    expect(denied.deniedServerVersion).toBe(19);
    const again = applyCloudStatus(denied, status({ state: "denied" }));
    expect(again.deniedCode).toBe("version_mismatch");
    expect(again.deniedServerVersion).toBe(19);
  });
  it("没来的可选键不会被写成 undefined（exactOptionalPropertyTypes：键不存在与值是 undefined 是两回事）", () => {
    const next = applyCloudStatus(core(), status());
    expect("deniedCode" in next).toBe(false);
    expect("deniedServerVersion" in next).toBe(false);
  });
  it("不改入参", () => {
    const before = core();
    applyCloudStatus(before, status({ gapNote: "x" }));
    expect(before.gapNote).toBeNull();
    expect(before.state).toBe("connecting");
  });
});

describe("cloudDeniedText", () => {
  it("五个码逐一给人话", () => {
    expect(cloudDeniedText("bad_jwt")).toBe("登录状态已过期，请重新登录后再试");
    expect(cloudDeniedText("not_member")).toBe("你不是这个团队的成员");
    expect(cloudDeniedText("no_session")).toBe("云会话不存在或已归档");
    expect(cloudDeniedText("not_authorized")).toBe("没有权限执行此操作");
    expect(cloudDeniedText("version_mismatch")).toBe("客户端版本与云端不匹配，请更新 Mr Otto 后再试");
  });
  it("版本不匹配说得出方向：服务端比本端低 = 云端还没升级", () => {
    expect(cloudDeniedText("version_mismatch", CS_PROTOCOL_VERSION - 1)).toBe(
      `云端协议版本（${CS_PROTOCOL_VERSION - 1}）低于本客户端（${CS_PROTOCOL_VERSION}），云端还没升级，联系维护者`,
    );
    expect(cloudDeniedText("version_mismatch", CS_PROTOCOL_VERSION + 1)).toBe("客户端版本与云端不匹配，请更新 Mr Otto 后再试");
  });
  it("认不出的码原样带出来，缺席给通用那句", () => {
    expect(cloudDeniedText("weird")).toBe("无法加入云会话（weird）");
    expect(cloudDeniedText(undefined)).toBe("无法加入云会话");
  });
});

describe("unknownSendNote", () => {
  it("正文只回显前 40 字", () => {
    expect(unknownSendNote("你好")).toBe("没有收到回执，不确定有没有发出去：你好");
    const long = "字".repeat(41);
    expect(unknownSendNote(long)).toBe(`没有收到回执，不确定有没有发出去：${"字".repeat(40)}…`);
  });
});
