import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #815 M4 的接线（index.ts 一 import 就要连 electron，进不了 vitest，所以读源码钉住）。
// 这三条各挡一个**静默**的失败：接漏了的话界面不报错，只是那枚点永远写着「状态未知」，
// 而那正是这一格改动前的样子——症状与没改一模一样。

const SRC = readFileSync(join(__dirname, "..", "..", "src", "main", "index.ts"), "utf8");

describe("proxySnapshot 的托管箱那一格（#815 M4）", () => {
  it("快照真的带上了 escrowSync 的清单", () => {
    expect(SRC).toMatch(/hostedServerIds:\s*escrowSync\?\.hostedServerIds\(\)\s*\?\?\s*null/);
  });

  it("拿不到时落 null 而不是空数组", () => {
    // `?? []` 会把「不知道」写成「箱子里一台都没有」——workspaceView 的 cloudStateOf
    // 据此把每一行画成「云端不可用」，一句平白的假阴性
    expect(SRC).not.toMatch(/hostedServerIds:\s*escrowSync\?\.hostedServerIds\(\)\s*\?\?\s*\[\]/);
  });

  it("箱内清单变了走 proxyChanged 那条既有推送，不另开一条通道", () => {
    // 另开一条 = 两条推送各带半份快照，渲染层得自己拼，而拼错那一次长得和「清单没变」一样
    expect(SRC).toMatch(/onHostedChanged:\s*\(\)\s*=>\s*send\(CHANNELS\.proxyChanged,\s*proxySnapshot\(\)\)/);
  });
});

describe("连接器页读的是真清单（#815 M4）", () => {
  const TAB = readFileSync(
    join(__dirname, "..", "..", "src", "renderer", "src", "components", "WorkspaceConnectorsTab.tsx"),
    "utf8"
  );

  it("硬编码的 null 与那条 TODO 都没了", () => {
    expect(TAB).not.toMatch(/TODO\(#811\)/);
    expect(TAB).not.toMatch(/const hostedServerIds:\s*readonly string\[\]\s*\|\s*null\s*=\s*null/);
  });

  it("拉 + 推两条都在：只推不拉的话，这一页在第一次推送之前打开就是空的", () => {
    expect(TAB).toMatch(/s\.proxyHostedServerIds/);
    expect(TAB).toMatch(/loadProxyHosted\(\)/);
  });
});
