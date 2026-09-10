import { describe, expect, it } from "vitest";
import { islandRail } from "../../src/shared/islandRail.js";
import type { BillingMe, WindowState } from "../../src/shared/billing.js";
import type { BillingSnapshotView } from "../../src/shared/shellBridge.js";
import type { BilledRow } from "../../src/shared/usageStats.js";

const NOW = 1_800_000_000_000;
const CR = 10_000; // 1 credit = 10_000 micro

const win = (usedCredit: number, limitCredit: number, resetInMs: number): WindowState => ({
  usedMicro: usedCredit * CR,
  limitMicro: limitCredit * CR,
  resetAt: NOW + resetInMs,
});

const me = (over: Partial<BillingMe> = {}): BillingMe => ({
  plan: "pro",
  status: "active",
  plans: [],
  windows: { h5: win(10, 100, 2 * 3_600_000), week: win(100, 2000, 4 * 86_400_000) },
  addon: { remainingMicro: 0, expiresAt: null },
  periodEnd: null,
  models: [],
  imageModels: [],
  ttsModels: [],
  modelPlatforms: {},
  ...over,
});

const snap = (over: Partial<BillingSnapshotView> = {}): BillingSnapshotView => ({
  me: me(),
  fetchedAt: NOW,
  exhausted: null,
  ...over,
});

const billed = (n: number, tokensEach = 1000): BilledRow[] =>
  Array.from({ length: n }, (_, i) => ({
    ts: NOW - i * 60_000,
    model: "glm-4.6",
    promptTokens: tokensEach / 2,
    completionTokens: tokensEach / 2,
  }));

describe("islandRail —— 灵动岛额度页脚的纯投影（#1229）", () => {
  it("billing 还没查到：一个像素都不画", () => {
    // 同 quotaAlert 判据①：冷启动那一瞬间「不知道」和「没有」长得一样，
    // 而这两件事该说的话相反。这里连 spend 都不能退——那会对一个订阅用户
    // 报一条他根本不该看到的 BYOK 账
    expect(islandRail({ billing: null, billed: billed(5), now: NOW })).toBeNull();
  });

  it("有订阅：报当主那扇窗的剩余百分比、倒计时与悬停精确数", () => {
    const r = islandRail({ billing: snap(), billed: [], now: NOW });
    expect(r).toMatchObject({
      kind: "quota",
      plan: "pro",
      pastDue: false,
      windowLabel: "5h", // 5h 已用 10% > 周窗 5%，bindingWindow 取它
      remainPercent: 90,
      remainLabel: "90.0%",
      exhausted: false,
      countdown: "2h 0m 后刷新",
      title: "已用 10 / 100 credit",
    });
  });

  it("充足时是中性灰，不是品牌蓝", () => {
    // ADR-0239 决定 1：一根几乎满格的蓝条会把「一切正常」画得比「快没了」还响。
    // quotaTone 的 brand 一档在岛上映射成 neutral
    expect(islandRail({ billing: snap(), billed: [], now: NOW })).toMatchObject({ tone: "neutral" });
  });

  it("色档按**已用**判：>75 警、>90 危", () => {
    const warn = snap({ me: me({ windows: { h5: win(80, 100, 60_000), week: win(10, 2000, 86_400_000) } }) });
    const deny = snap({ me: me({ windows: { h5: win(95, 100, 60_000), week: win(10, 2000, 86_400_000) } }) });
    expect(islandRail({ billing: warn, billed: [], now: NOW })).toMatchObject({ tone: "warn", remainLabel: "20.0%" });
    expect(islandRail({ billing: deny, billed: [], now: NOW })).toMatchObject({ tone: "deny", remainLabel: "5.0%" });
  });

  it("窗已经清零：不画倒计时（「100.0% 可用」和「已刷新」是同一句话说两遍）", () => {
    // 周窗也得是零 —— h5 一清零，两扇窗并列，bindingWindow 才仍然取 h5（它预算小、
    // 烧得快）。周窗留着占比的话当主那扇会换成周窗，这条用例就测不到它想测的东西
    const rolled = snap({ me: me({ windows: { h5: win(80, 100, -1), week: win(0, 2000, 86_400_000) } }) });
    const r = islandRail({ billing: rolled, billed: [], now: NOW });
    expect(r).toMatchObject({ remainLabel: "100.0%", countdown: null, tone: "neutral" });
  });

  it("exhausted 排在百分比前面：网关亲口说的拦住了，胜过从响应头换算的推论", () => {
    // 只走 429 那条路时窗口数还停在上一次的值——光看百分比会漏掉这一刻
    const r = islandRail({
      billing: snap({ exhausted: { window: "5h", resetAt: NOW + 600_000 } }),
      billed: [],
      now: NOW,
    });
    expect(r).toMatchObject({ kind: "quota", exhausted: true, tone: "deny" });
  });

  it("过期的 exhausted 记号不算数——这份快照是 push 来的，不会自己到点过期", () => {
    const r = islandRail({
      billing: snap({ exhausted: { window: "5h", resetAt: NOW - 1 } }),
      billed: [],
      now: NOW,
    });
    expect(r).toMatchObject({ exhausted: false, tone: "neutral" });
  });

  it("扣款失败：仍报原来的档，另起一格说出事了", () => {
    // ADR-0240：扣款失败不改变「你订的是 Pro」
    const r = islandRail({ billing: snap({ me: me({ status: "past_due" }) }), billed: [], now: NOW });
    expect(r).toMatchObject({ kind: "quota", plan: "pro", pastDue: true });
  });

  it("没订阅但日志里有过计费调用：同一条页脚换个主语，报 token 不报钱", () => {
    // BilledRow 只有 {ts, model, prompt, completion}——没有 route、没有 credit。
    // 一个 $ 数字要现查 modelPricing 拼出来，而那张表里 UNPRICED 是常态（ADR-0241）
    const r = islandRail({
      billing: snap({ me: me({ plan: null, status: "none", windows: null }) }),
      billed: billed(38, 1000),
      now: NOW,
    });
    expect(r).toMatchObject({ kind: "spend", plan: "free", tokens: 38_000, tokensLabel: "38K", calls: 38 });
  });

  it("没订阅且一次都没跑过：整条不画，回到改动前的样子", () => {
    const r = islandRail({
      billing: snap({ me: me({ plan: null, status: "none", windows: null }) }),
      billed: [],
      now: NOW,
    });
    expect(r).toBeNull();
  });

  it("有订阅时不看 billed —— 订阅用户不许自带 key，那本账对他没有意义（ADR-0248）", () => {
    const r = islandRail({ billing: snap(), billed: billed(99), now: NOW });
    expect(r?.kind).toBe("quota");
  });

  it("me 为 null（登录了但账查不到）：与「还没查到」同处理，不画", () => {
    expect(islandRail({ billing: snap({ me: null }), billed: billed(3), now: NOW })).toBeNull();
  });
});
