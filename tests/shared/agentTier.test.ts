// 智能体分级的判据（#1571，ADR-0365，spec §2）。钉的是：等级与域怎么派生、派活的四种放行与其余一律拒、
// 工具面按等级与域圈、列表只画 L0 L1、自定义域的形状、三级提示词各说什么。
import { describe, expect, it } from "vitest";
import {
  ADMIN_DOMAIN, DOMAIN_CATALOG, customDomain, customDomainConflict, customDomainError, domainFace, domainLabel, isAgentDomain,
  READ_TOOLS, WRITE_TOOLS, EXEC_TOOLS,
} from "../../src/shared/agentDomain.js";
import {
  canDispatch, connectorsAllowed, dispatchDenied, domainOf, missingAdmin, scopedTools, specialistsFor, subworkersOf, tierOf,
  tierRowError, visibleAgents, type TieredAgent,
} from "../../src/shared/agentTier.js";
import { tierPrompt } from "../../src/shared/tierPrompt.js";

const admin: TieredAgent & { name: string } = { agentId: "admin", name: "管理员", tier: 0, domain: "admin" };
const travel = { agentId: "a_travel", name: "出行", tier: 1 as const, domain: "travel" };
const dev = { agentId: "a_dev", name: "码农", tier: 1 as const, domain: "dev" };
const booker = { agentId: "a_book", name: "订票员", tier: 2 as const, domain: "travel", parentAgentId: "a_travel" };
const script = { agentId: "a_sh", name: "跑脚本", tier: 2 as const, domain: "dev", parentAgentId: "a_dev" };
const ROSTER = [admin, travel, dev, booker, script];
const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS, ...EXEC_TOOLS];

describe("等级与域的派生", () => {
  it("缺席按 agentId 推：admin 是 0 / admin 域，其余 1 / 未分配", () => {
    expect(tierOf({ agentId: "admin" })).toBe(0);
    expect(tierOf({ agentId: "x" })).toBe(1);
    expect(domainOf({ agentId: "admin" })).toBe(ADMIN_DOMAIN);
    expect(domainOf({ agentId: "x" })).toBe("custom:未分配");
    expect(domainOf({ agentId: "x", domain: "" })).toBe("custom:未分配");
  });
  it("一行合不合等级：admin ⇔ L0；L2 ⇔ 有上级；上级得是同主场的 L1", () => {
    expect(tierRowError(admin, ROSTER)).toBeNull();
    expect(tierRowError(booker, ROSTER)).toBeNull();
    expect(tierRowError({ agentId: "admin", tier: 1 }, ROSTER)).toMatch(/管理员必须是 L0/);
    expect(tierRowError({ agentId: "y", tier: 0 }, ROSTER)).toMatch(/L0 只能是管理员/);
    expect(tierRowError({ agentId: "y", tier: 2 }, ROSTER)).toMatch(/子工必须有上级/);
    expect(tierRowError({ agentId: "y", tier: 1, parentAgentId: "a_travel" }, ROSTER)).toMatch(/只有子工才有上级/);
    expect(tierRowError({ agentId: "y", tier: 2, parentAgentId: "nobody" }, ROSTER)).toMatch(/不在这个主场/);
    expect(tierRowError({ agentId: "y", tier: 2, parentAgentId: "a_book" }, ROSTER)).toMatch(/必须是专员/);
    expect(tierRowError({ agentId: "y", tier: 2, parentAgentId: "admin" }, ROSTER)).toMatch(/必须是专员/);
  });
  it("缺管理员", () => {
    expect(missingAdmin(ROSTER)).toBe(false);
    expect(missingAdmin([travel])).toBe(true);
  });
});

describe("派活方向（spec §2.3 第一道闸）", () => {
  const ok = (f: string, t: string) => canDispatch(f, t, ROSTER);
  it("四种放行：L0→L1、L1→自己的 L2、L1→L0、L2→自己的 L1", () => {
    expect(ok("admin", "a_travel")).toBe(true);
    expect(ok("a_travel", "a_book")).toBe(true);
    expect(ok("a_travel", "admin")).toBe(true);
    expect(ok("a_book", "a_travel")).toBe(true);
  });
  it("其余一律拒：横向、越级、别人的子工、自己、不认识的", () => {
    expect(ok("a_travel", "a_dev")).toBe(false); // 兄弟
    expect(ok("a_book", "a_sh")).toBe(false); // 兄弟 L2
    expect(ok("admin", "a_book")).toBe(false); // 越级往下
    expect(ok("a_book", "admin")).toBe(false); // 越级往上
    expect(ok("a_dev", "a_book")).toBe(false); // 别人的子工
    expect(ok("a_book", "a_dev")).toBe(false); // 报给别人的上级
    expect(ok("a_travel", "a_travel")).toBe(false);
    expect(ok("admin", "ghost")).toBe(false);
    expect(ok("ghost", "admin")).toBe(false);
  });
  it("0060 没跑（没有 tier 列）：admin 派谁都行、专员之间互不接力——与今天扁平的差别只在横向", () => {
    const flat = [{ agentId: "admin" }, { agentId: "a" }, { agentId: "b" }];
    expect(canDispatch("admin", "a", flat)).toBe(true);
    expect(canDispatch("a", "admin", flat)).toBe(true);
    expect(canDispatch("a", "b", flat)).toBe(false);
  });
  it("dispatchDenied 保序挑出不许的那几个", () => {
    expect(dispatchDenied("a_travel", ["a_book", "a_dev", "admin", "a_sh"], ROSTER)).toEqual(["a_dev", "a_sh"]);
  });
});

describe("工具面（spec §2.3 第二道闸）", () => {
  it("L0 全部；L1 按域；L2 = 自己域 ∩ 上级域；自定义域只读", () => {
    expect(scopedTools(admin, ROSTER, ALL_TOOLS)).toEqual(ALL_TOOLS);
    expect(scopedTools(travel, ROSTER, ALL_TOOLS)).toEqual([...READ_TOOLS, ...WRITE_TOOLS]);
    expect(scopedTools(dev, ROSTER, ALL_TOOLS)).toEqual(ALL_TOOLS);
    const devSub = { ...script, domain: "custom:日志" };
    expect(scopedTools(devSub, ROSTER, ALL_TOOLS)).toEqual([...READ_TOOLS]);
    const travelSubClaimsDev = { ...booker, domain: "dev" };
    expect(scopedTools(travelSubClaimsDev, ROSTER, ALL_TOOLS)).toEqual([...READ_TOOLS, ...WRITE_TOOLS]); // 不能比上级宽
    expect(scopedTools({ agentId: "x", tier: 1, domain: "custom:未分配" }, ROSTER, ALL_TOOLS)).toEqual([...READ_TOOLS]);
  });
  it("只在 offered 里挑，不凭空加", () => {
    expect(scopedTools(travel, ROSTER, ["bash", "read_file", "nope"])).toEqual(["read_file"]);
  });
  it("连接器：L0 能；L1 看域；L2 看自己 ∧ 上级；自定义域默认不能", () => {
    expect(connectorsAllowed(admin, ROSTER)).toBe(true);
    expect(connectorsAllowed(travel, ROSTER)).toBe(true);
    expect(connectorsAllowed({ agentId: "x", tier: 1, domain: "custom:杂事" }, ROSTER)).toBe(false);
    expect(connectorsAllowed(booker, ROSTER)).toBe(true);
    expect(connectorsAllowed({ ...booker, parentAgentId: "a_custom" }, [...ROSTER, { agentId: "a_custom", tier: 1, domain: "custom:杂事" }])).toBe(false);
  });
});

describe("列表与匹配", () => {
  it("列表只画 L0 L1；L2 在上级页里；按域找专员不含 L2", () => {
    expect(visibleAgents(ROSTER).map((a) => a.agentId)).toEqual(["admin", "a_travel", "a_dev"]);
    expect(subworkersOf("a_travel", ROSTER).map((a) => a.agentId)).toEqual(["a_book"]);
    expect(specialistsFor("travel", ROSTER).map((a) => a.agentId)).toEqual(["a_travel"]);
    expect(specialistsFor("life", ROSTER)).toEqual([]);
  });
});

describe("域", () => {
  it("清单 + admin + 自定义合法；其余不合法", () => {
    for (const d of DOMAIN_CATALOG) expect(isAgentDomain(d.key)).toBe(true);
    expect(isAgentDomain("admin")).toBe(true);
    expect(isAgentDomain("custom:带娃")).toBe(true);
    expect(isAgentDomain("custom:")).toBe(false);
    expect(isAgentDomain("custom:出行")).toBe(false); // 清单里有，不许当自定义
    expect(isAgentDomain("banana")).toBe(false);
    expect(isAgentDomain(3)).toBe(false);
  });
  it("apps 域（#1591）：在清单里、读写执行全开、不碰连接器", () => {
    expect(DOMAIN_CATALOG.find((d) => d.key === "apps")?.label).toBe("应用");
    const apps = { agentId: "a_apps", name: "应用专员", tier: 1 as const, domain: "apps" };
    expect(scopedTools(apps, [admin, apps], ALL_TOOLS)).toEqual(ALL_TOOLS);
    expect(connectorsAllowed(apps, [admin, apps])).toBe(false);
  });
  it("自定义域的名字：空 / 太长 / 冒号 / 撞清单", () => {
    expect(customDomainError("带娃")).toBeNull();
    expect(customDomainError("  ")).toMatch(/不能为空/);
    expect(customDomainError("一二三四五六七八九十一二三")).toMatch(/最多/);
    expect(customDomainError("a:b")).toMatch(/冒号/);
    expect(customDomainError("出行")).toMatch(/已经在清单里/);
    expect(customDomainError("travel")).toMatch(/已经在清单里/);
    expect(customDomain(" 带娃 ")).toBe("custom:带娃");
  });
  it("显示名与同主场不重名", () => {
    expect(domainLabel("travel")).toBe("出行");
    expect(domainLabel("custom:带娃")).toBe("带娃");
    expect(domainLabel("admin")).toBe("管理");
    expect(customDomainConflict("custom:带娃", ["travel", "custom:带娃"])).toMatch(/已经有一只/);
    expect(customDomainConflict("custom:带娃", ["travel"])).toBeNull();
    expect(customDomainConflict("travel", ["travel"])).toBeNull(); // 清单域允许多只
  });
  it("域的面：ops / dev 全部；research / schedule 只读；自定义只读 + 不碰连接器", () => {
    expect(domainFace("dev").tools).toEqual(ALL_TOOLS);
    expect(domainFace("research")).toEqual({ tools: READ_TOOLS, connectors: true });
    expect(domainFace("custom:杂事")).toEqual({ tools: READ_TOOLS, connectors: false });
    expect(domainFace("garbage")).toEqual({ tools: READ_TOOLS, connectors: false });
  });
});

describe("提示词（spec §5）", () => {
  const roster = ROSTER;
  it("L0：先判简单；按域派；现有专员分组；没人就提议建", () => {
    const p = tierPrompt({ agent: admin, ownerName: "Stan", roster });
    expect(p).toContain("一句话能答完、不用动手、不用查的，直接做");
    expect(p).toContain("出行：出行");
    expect(p).toContain("开发：码农");
    expect(p).not.toContain("订票员"); // L2 不在管理员的派发名单里
    expect(p).toContain("提议建一只");
    expect(p).toContain("不把密码、token、密钥写进它的说明或职责"); // #1585
    expect(tierPrompt({ agent: admin, ownerName: "Stan", roster: [admin] })).toContain("还没有专员");
  });
  it("L1：只做本域；域外转管理员；有子工写子工；不找别的专员", () => {
    const p = tierPrompt({ agent: travel, ownerName: "Stan", roster });
    expect(p).toContain("「出行」专员");
    expect(p).toContain("已转管理员");
    expect(p).toContain("你有子工：订票员");
    expect(p).toContain("别找别的专员");
    expect(tierPrompt({ agent: dev, ownerName: "Stan", roster: [admin, dev] })).not.toContain("你有子工");
    // 管理员改过名（#1596）：专员那段 @ 的是它的名字
    const renamed = tierPrompt({ agent: dev, ownerName: "Stan", roster: [{ ...admin, name: "小李" }, dev] });
    expect(renamed).toContain("@小李 转过去");
    expect(renamed).toContain("有事报小李");
  });
  it("apps 域的 L1 多一段：先定设计系统、文件在 /work/apps/<slug>/、没有外网走 window.otto、写完 build_app；别的域没有", () => {
    const apps = { agentId: "a_apps", name: "应用专员", tier: 1 as const, domain: "apps" };
    const p = tierPrompt({ agent: apps, ownerName: "Stan", roster: [admin, apps] });
    expect(p).toContain("Otto 应用");
    expect(p).toContain("/work/apps/<slug>/");
    expect(p).toContain("window.otto");
    expect(p).toContain("build_app");
    expect(p).toContain("design");
    expect(tierPrompt({ agent: travel, ownerName: "Stan", roster })).not.toContain("build_app");
  });
  it("L2：只做上级派的那一件、报给上级、不派活", () => {
    const p = tierPrompt({ agent: booker, ownerName: "Stan", roster });
    expect(p).toContain("出行 的子工");
    expect(p).toContain("报给 出行");
    expect(p).toContain("不派活");
    expect(tierPrompt({ agent: { ...booker, parentAgentId: "ghost" }, ownerName: "Stan", roster })).toContain("你的上级");
  });
});
