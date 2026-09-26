// 残留那两处「接线」的可执行版（#780 M4 / M6 / I3-I5）。
//
// 为什么读源码而不是跑逻辑：这两处都在**装配根闭包**里——`createResidueQueries` 的
// 那一句接线住在 `src/main/index.ts`（一 import 就要拉起 Electron），`enterChat` 的
// 三个调用点住在 zustand 的 store 工厂里。
//
// 而这两处**坏掉的样子都是无声的**：递错一格依赖 = 清单里少几条或多几条，和「本来
// 就是这样」长得一样；M6 少传一个参数 = 用户没处理的那张清单在下一次切会话时被抹掉。
// 所以宁可要一条读源码的断言，也不要零覆盖（同 tests/main/accountScope.test.ts 与
// tests/runtime/sandbox.test.ts 的处置）。
//
// **查询本体不在这里判**（#780 I3-I5 已经把它搬出装配根）：遍历口、归并顺序、
// 「没有 baseline 就不做」那几条都在 tests/main/residueQueries.test.ts 里真跑。
// 留在这一份的只剩「那个模块被接上了没有、接的是哪一格」。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string): string => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("createResidueQueries 的接线（#780 I3-I5）", () => {
  const src = read("src/main/index.ts");
  // 只截那一句调用本身（到它自己的 `});` 为止）：多截一截就会读到紧挨着的
  // `residueCapFor` 定义，下面那条「不许出现 residueCapFor」会恒红
  const callStart = src.indexOf("createResidueQueries({");
  const call = src.slice(callStart, src.indexOf("\n  });", callStart));

  it("四个查询的本体不在装配根里——index.ts 自己不再重放残留日志", () => {
    expect(src).toContain('from "./residueQueries.js"');
    // 判据是「这个文件不再自己数日志」：这几个符号一旦回到 index.ts，
    // 就意味着有人把本体抄了一份回来，而那一份没有任何执行覆盖
    expect(src).not.toContain("pendingResidue(");
    expect(src).not.toContain("mergeResidue(");
    expect(src).not.toContain('store.sessionIdsWithEvent("residue_detected")');
  });

  it("residueCapOf 递的是**这个会话自己**那份能力，不是 app 级退路 residueCapFor", () => {
    // 两者差一个字，而递错的后果是静默的：现查那一半会拿 A 的基线去减 B 的现场，
    // 算出来的既不是 A 的残留也不是 B 的（基线是会话级的，ADR 见 residueQueries.ts 头注）
    expect(call).toContain("residueCapOf: (sessionId) => agents.get(sessionId)?.world.residue");
    expect(call).not.toContain("residueCapFor");
  });

  it("escapedGroups 接的是真的那张出走登记表", () => {
    // 递一个空数组照样编译得过，而症状是「进程组那一档永远查不出残留」
    expect(call).toContain("liveGroups.escaped()");
  });

  it("groupStillIs 接上了——没有它，回收给别人的 pgid 会被当成自己的残留", () => {
    expect(call).toMatch(/\bgroupStillIs\b/);
  });
});

describe("enterChat 的三个调用点都带上手上那份 bootResidue（#780 M6）", () => {
  const src = read("src/renderer/src/store.ts");

  it("三处一个不漏", () => {
    const calls = src.match(/enterChat\(info,[^;\n]*/g) ?? [];
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c).toMatch(/bootResidue/);
  });

  it("落位是「没带就留着手上那份」，不是 `?? []`", () => {
    expect(src).toContain("bootResidue: info.pendingResidue ?? [...prevBootResidue]");
  });
});
