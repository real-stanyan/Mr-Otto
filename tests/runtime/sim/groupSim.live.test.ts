// 群聊座位制的大规模模拟（#1682）：十几个欧美模拟用户、各自的主场与专员、六个真实场景，模型走线上网关（真钱）。
// 默认跳过。跑法见 OTTO_LIVE_* 那几格（同 groupSeats.live.test.ts）；OTTO_SIM_ONLY=tahoe,family 只跑几场；结果写到 OTTO_SIM_OUT（JSON）。
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { createCity } from "./simCity.js";
import { CAST, SCENARIOS } from "./cast.js";
import { checkScenario, type ScenarioReport } from "./checks.js";

const LIVE = process.env.OTTO_LIVE === "1";

describe.skipIf(!LIVE)("群座位制 · 欧美用户模拟", () => {
  it("建人 → 建专员 → 六个群场景 → 自动检查", async () => {
    const only = (process.env.OTTO_SIM_ONLY ?? "").split(",").filter((x) => x !== "");
    const scenarios = SCENARIOS.filter((s) => only.length === 0 || only.includes(s.id));
    const ids = new Set(scenarios.flatMap((s) => [s.owner, ...s.members, ...s.beats.flatMap((b) => (b.kind === "invite" ? b.add : []))]));
    const cast = CAST.filter((p) => ids.has(p.id));
    const city = await createCity({
      edgeBase: process.env.OTTO_LIVE_EDGE!, runtimeSecret: process.env.OTTO_LIVE_SECRET!, payer: process.env.OTTO_LIVE_OWNER!, payerWs: process.env.OTTO_LIVE_WS!,
      personas: cast,
    });
    const out = process.env.OTTO_SIM_OUT;
    const reports: ScenarioReport[] = [];
    const setup: { persona: string; agents: { name: string; domain?: string; description: string }[]; dm: string[] }[] = [];
    const flush = (): void => {
      if (!out) return;
      const usage = city.calls.reduce((a, c) => ({ prompt: a.prompt + c.promptTokens, completion: a.completion + c.completionTokens, calls: a.calls + 1 }), { prompt: 0, completion: 0, calls: 0 });
      writeFileSync(out, JSON.stringify({
        setup, reports, usage, personaCalls: city.personaCalls,
        routines: city.routines.rows().map((r) => ({ owner: CAST.find((p) => p.uid === r.ownerUid)?.name, title: r.title, schedule: r.schedule, tz: r.tz, sessionId: r.sessionId ?? null, instruction: r.instruction })),
        friendMessages: city.friendMessages, log: city.log,
      }, null, 2));
    };
    try {
      // ① 每个人先在和自己管理员的私聊里，让它建自己会用的专员
      for (const p of cast) {
        await city.setupAgents(p);
        const h = city.homes.get(p.id)!;
        setup.push({
          persona: p.name,
          agents: h.writer.specs(h.ws).map((a) => ({ name: a.name, description: a.description, ...(a.domain !== undefined ? { domain: a.domain } : {}) })),
          dm: h.store.load(`dm-${p.id}`).flatMap((e) =>
            e.type === "user_message" && e.greeting === undefined ? [`${p.name}: ${e.content.replace(/^\[[^\]]*\]:\s*/, "")}`]
              : e.type === "assistant_message" && e.content.trim() !== "" ? [`${p.adminName}: ${e.content}`]
                : e.type === "assistant_message" && (e.toolCalls ?? []).length > 0 ? [`(${p.adminName} 调 ${(e.toolCalls ?? []).map((c) => c.name).join(", ")})`] : []),
        });
        flush();
      }
      // ② 一场一场跑
      for (const sc of scenarios) {
        const r = await city.runScenario(sc);
        reports.push(checkScenario(r, city, { chineseOk: ["stan"] }));
        flush();
      }
    } finally {
      flush();
      await city.destroy();
    }
    expect(reports.length).toBe(scenarios.length);
  }, 4 * 60 * 60_000);
});
