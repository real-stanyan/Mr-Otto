// 残留那两处「接线」的可执行版（#780 M4 / M6）。
//
// 为什么读源码而不是跑逻辑：这两处都在**装配根闭包**里——`pendingResidueNow` 住在
// `src/main/index.ts`（一 import 就要拉起 Electron），`enterChat` 的三个调用点住在
// zustand 的 store 工厂里。#780 的 I3/I5 已经点过名：这一族要真跑得起来得先把
// `createResidueQueries(deps)` 提出来，那是另一件事。
//
// 而这两处**坏掉的样子都是无声的**：M4 少扫几个会话 = 清单里少几条，和「本来就没有」
// 长得一样；M6 少传一个参数 = 用户没处理的那张清单在下一次切会话时被抹掉。
// 所以宁可要一条读源码的断言，也不要零覆盖（同 tests/main/accountScope.test.ts 的处置）。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string): string => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("pendingResidueNow 的遍历口（#780 M4）", () => {
  const src = read("src/main/index.ts");
  // 注释行剥掉再判：那一段的注释里**正好**写着「不走 store.sessions()」，
  // 连注释一起扫的话这条断言永远红
  const body = src
    .slice(src.indexOf("const pendingResidueNow"), src.indexOf("const pendingResidueNow") + 1600)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("按「落过 residue_detected 的会话」遍历，不按 store.sessions()", () => {
    expect(body).toContain('store.sessionIdsWithEvent("residue_detected")');
    // sessions() 把系统归档的会话整个藏起来（store.ts 那边有断言钉着这条既定行为），
    // 用它遍历就是让那批会话上的残留永远重放不出来
    expect(body).not.toContain("store.sessions()");
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
