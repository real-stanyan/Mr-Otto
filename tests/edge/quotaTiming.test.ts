import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  attachQuotaTiming, formatQuotaTiming, parseTiming, QUOTA_TIMING_HEADER,
  type QuotaSample,
} from "../../services/edge/src/quotaTiming.js";

const T = { total: 612, plan: 580, planCold: true, state: 20, rebuilt: false };

describe("parseTiming", () => {
  it("五格齐了才认", () => {
    expect(parseTiming(T)).toEqual(T);
  });
  it("少任何一格回 null —— 不拿 0 / false 冒充（假的 in=0 会把整趟记到往返头上）", () => {
    for (const k of ["total", "plan", "state", "planCold", "rebuilt"] as const) {
      const { [k]: _dropped, ...rest } = T;
      expect(parseTiming(rest)).toBeNull();
    }
  });
  it("非有限数 / 类型不对也回 null", () => {
    expect(parseTiming({ ...T, total: Number.NaN })).toBeNull();
    expect(parseTiming({ ...T, plan: "580" })).toBeNull();
    expect(parseTiming({ ...T, planCold: 1 })).toBeNull();
    expect(parseTiming(null)).toBeNull();
    expect(parseTiming(undefined)).toBeNull();
    expect(parseTiming("nope")).toBeNull();
  });
});

describe("formatQuotaTiming", () => {
  it("有内层：往返由读的人自己减（outer - in）", () => {
    expect(formatQuotaTiming([{ label: "view", outerMs: 1340, inner: T }])).toBe(
      "view outer=1340 in=612 plan=580 cold=1 state=20 reb=0"
    );
  });
  it("没有内层：整段 in= 缺席 —— 「没有数据」与「内层是 0」必须长得不一样", () => {
    expect(formatQuotaTiming([{ label: "me:db", outerMs: 210, inner: null }])).toBe("me:db outer=210");
    expect(formatQuotaTiming([{ label: "view", outerMs: 1340, inner: { ...T, total: 0, plan: 0, state: 0 } }])).toBe(
      "view outer=1340 in=0 plan=0 cold=1 state=0 reb=0"
    );
  });
  it("多趟用 ; 隔开；冷启动重建那两格是 1", () => {
    const s: QuotaSample[] = [
      { label: "hold", outerMs: 900, inner: { total: 800, plan: 300, planCold: true, state: 480, rebuilt: true } },
      { label: "settle", outerMs: 700, inner: { total: 60, plan: 0, planCold: false, state: 5, rebuilt: false } },
    ];
    expect(formatQuotaTiming(s)).toBe(
      "hold outer=900 in=800 plan=300 cold=1 state=480 reb=1; settle outer=700 in=60 plan=0 cold=0 state=5 reb=0"
    );
  });
  it("标签里的换行会被剥掉 —— 响应头注入", () => {
    expect(formatQuotaTiming([{ label: "ho\r\nx-evil: 1", outerMs: 1, inner: null }])).toBe("hox-evil:1 outer=1");
  });
  it("时钟倒走出来的负数夹成 0（负的耗时是噪声不是事实）", () => {
    expect(formatQuotaTiming([{ label: "view", outerMs: -3, inner: null }])).toBe("view outer=0");
  });
});

describe("attachQuotaTiming", () => {
  const fake = (): { headers: { set(k: string, v: string): void }; seen: [string, string][] } => {
    const seen: [string, string][] = [];
    return { headers: { set: (k, v) => void seen.push([k, v]) }, seen };
  };

  it("有样本就挂一格", () => {
    const res = fake();
    attachQuotaTiming(res, [{ label: "view", outerMs: 10, inner: null }]);
    expect(res.seen).toEqual([[QUOTA_TIMING_HEADER, "view outer=10"]]);
  });
  it("一趟都没打过：原样不碰（中继那条 101 升级响应本来就不碰 DO）", () => {
    const res = fake();
    attachQuotaTiming(res, []);
    expect(res.seen).toEqual([]);
  });
  it("只读头抛了就算了 —— 一个诊断头不值得把一次正常响应变成 500", () => {
    const res = { headers: { set: (): never => { throw new TypeError("immutable"); } } };
    expect(() => attachQuotaTiming(res, [{ label: "view", outerMs: 10, inner: null }])).not.toThrow();
  });
});

// ── 接线断言（#1304）────────────────────────────────────────────────────
// `worker.ts` 进不了 vitest（一 import 就要 `cloudflare:workers` 的运行时），
// 而这套东西的失败模式全是静默的：DO 少回一格 `timing`，头上就只剩 `outer=`，
// 读的人会把整趟记成「纯往返」—— 那正好是这次要分辨的那件事。
// 判据只好落在源码上，同 tests/runtime/sandbox.test.ts 的 freeKib 接线断言。
describe("worker.ts 把打点接上了", () => {
  const read = async (): Promise<string> =>
    readFile(new URL("../../services/edge/src/worker.ts", import.meta.url), "utf8");

  it("DO 回执里那格 timing 的字段与 parseTiming 要的**一格不差**", async () => {
    const src = await read();
    const lit = /timing: \{([^}]*)\}/.exec(src);
    expect(lit).not.toBeNull();
    const produced = new Set([...(lit as RegExpExecArray)[1]!.matchAll(/(\w+):/g)].map((m) => m[1] as string));
    // 要的那几格从模块自己身上取，不在这儿抄第二份：哪天 QuotaTiming 多一格而 DO 没跟上，
    // 这条当场红（而线上只会安静地少半个头）
    const wanted = parseTiming({ total: 1, plan: 2, planCold: true, state: 3, rebuilt: false });
    expect(produced).toEqual(new Set(Object.keys(wanted as object)));
  });

  it("两个 port 与挂头收的是同一个数组", async () => {
    const src = await read();
    expect(src).toContain("quotaPort(env, timing)");
    expect(src).toContain("billingPort(env, timing)");
    expect(src).toContain("attachQuotaTiming(res, timing)");
  });

  it("rebuilt 的记号置在 `again` 那道闸之后（排在重建后面的请求什么都没重建）", async () => {
    const src = await read();
    const gate = src.indexOf("if (again) return again;");
    const mark = src.indexOf("led.rebuilt = true");
    expect(gate).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(gate);
  });
});
