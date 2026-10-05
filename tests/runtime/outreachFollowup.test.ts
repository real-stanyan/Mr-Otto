// 外联挂断后那段打字的兜底（#1663）：真机上朋友挂断后打字「要不你再发一次？」，智能体答「我带回去」却没调 relay_to_owner。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOutreachFollowup, outreachFollowupText, OUTREACH_FOLLOWUP_IDLE_MS } from "../../services/runtime/src/outreachFollowup.js";
import type { SessionEvent } from "../../src/session/events.js";

const PEER = "u_stan";
let seq = 0;
const ev = (e: Record<string, unknown>): SessionEvent => ({ sessionId: "s", seq: ++seq, ts: seq, ...e }) as SessionEvent;
const peer = (text: string) => ev({ type: "user_message", content: `[Stan Yan]: ${text}`, fromUid: PEER, mentions: ["admin"] });
const reply = (content: string, extra: Record<string, unknown> = {}) => ev({ type: "assistant_message", agentId: "admin", content, ...extra });
const ended = () => ev({ type: "turn_ended", agentId: "admin", outcome: "completed" });

function harness() {
  const sent: string[] = [];
  let pending: { fn: () => void; ms: number } | null = null;
  let archived = false;
  const f = createOutreachFollowup({
    peerUid: PEER, peerName: "Stan Yan", agentName: () => "雨姐",
    send: async (t) => { sent.push(t); return "ok"; },
    archived: () => archived,
    setTimer: (fn, ms) => (pending = { fn, ms }),
    clearTimer: () => { pending = null; },
    log: () => {},
  });
  return {
    f, sent,
    tick: async () => { const p = pending; pending = null; p?.fn(); await Promise.resolve(); },
    pending: () => pending,
    archive: () => { archived = true; },
  };
}

describe("外联挂断后那段打字", () => {
  it("真机那一段：挂断后来回几句、没调 relay_to_owner → 安静 2 分钟后原话带回主人", async () => {
    const h = harness();
    h.f.observe(peer("没找到，要不你再发一次？"), false);
    h.f.observe(reply("我这头发不了东西，回去跟他讲一声。"), false);
    h.f.observe(ended(), false);
    expect(h.pending()?.ms).toBe(OUTREACH_FOLLOWUP_IDLE_MS);
    h.f.observe(peer("行"), false); // 对面又说话：先不送
    expect(h.pending()).toBeNull();
    h.f.observe(reply("行，那我带回去。拜。"), false);
    h.f.observe(ended(), false);
    await h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("电话挂断后 Stan Yan 在通话记录里打字");
    expect(h.sent[0]).toContain("Stan Yan：没找到，要不你再发一次？");
    expect(h.sent[0]).toContain("雨姐：行，那我带回去。拜。");
    await h.tick();
    expect(h.sent).toHaveLength(1); // 送过就清空，不重复送
  });

  it("这段里调过 relay_to_owner → 不再兜底；通话中说的话不管（挂断汇报带走）；归档了不送；应承短句不算", async () => {
    const a = harness();
    a.f.observe(peer("帮我跟他说一声"), false);
    a.f.observe(reply("", { toolCalls: [{ id: "c1", name: "relay_to_owner", args: { text: "x" } }] }), false);
    a.f.observe(reply("已经转告了"), false);
    a.f.observe(ended(), false);
    await a.tick();
    expect(a.sent).toEqual([]);

    const b = harness();
    b.f.observe(peer("喂"), true);
    b.f.observe(ended(), true);
    expect(b.pending()).toBeNull();

    const c = harness();
    c.f.observe(peer("在吗"), false);
    c.f.observe(reply("嗯嗯，马上。", { ack: true }), false);
    c.f.observe(ended(), false);
    c.archive();
    await c.tick();
    expect(c.sent).toEqual([]);
  });

  it("超长留尾巴：最近的话最要紧", () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ who: "peer" as const, text: `第 ${i} 句`.padEnd(40, "啊") }));
    const t = outreachFollowupText("Stan Yan", "雨姐", lines);
    expect([...t].length).toBeLessThanOrEqual(1000);
    expect(t).toContain("第 39 句");
    expect(t).not.toContain("第 0 句");
  });

  it("接线：外联会话一建好就挂（第一句就要算进去），每条事件都喂；relay_to_owner 的说明写死「答应了就当场调」", () => {
    const svc = readFileSync("services/runtime/src/sessionService.ts", "utf8");
    expect(svc).toContain("outreachFollowup?.observe(e, activeOutreach(outreachFold) !== null);");
    expect(svc.indexOf("outreachFollowup = createOutreachFollowup(")).toBeLessThan(svc.indexOf("function notify(e: SessionEvent)"));
    expect(readFileSync("services/runtime/src/relayToOwnerTool.ts", "utf8")).toContain("就在同一轮里调这把刀");
  });
});
