// 会话归档的真机验收（ADR-0087；入口改独立视图见 ADR-0089）：
// ⋮ 菜单归档 → 主列表消失、回欢迎页 → 「已归档会话」视图里能找到它 → 恢复 → 回主列表。
// 库里两条状态事件（archived reason=user / unarchived）都在，日志一字没删。

import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession, type Otto } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

function sqlite(otto: Otto, sql: string): string {
  return execFileSync("sqlite3", [join(otto.accountData, "sessions.db"), sql], {
    encoding: "utf8",
  }).trim();
}

test("归档 → 已归档视图 → 恢复：列表投影来回走，日志只增不减", async () => {
  const fake = await startFakeModel(() => ({ content: "收到。" }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "这个会话要被归档");
    await expect(win.getByText("收到。")).toBeVisible({ timeout: 20_000 });

    // 归档前的整本日志（seq|type 一行一条）。收尾处断的是"这些行一条不少
    // 地还在"——比原来那句 `count(*) === before + 1` **更强**，而且不依赖
    // 事件的全局先后（issue #827）：新会话的残留基线是异步落盘的（要跑
    // simctl/lsof，src/main/index.ts），它完全可能排在归档动作之后，于是
    // 按 count 做算术、按 `order by seq desc limit 1` 认"最后一条"两处都会
    // 稳定翻车。append-only 日志里多个异步源交错本来就是允许的，测试不该
    // 把"最后一条一定是我刚做的那件事"当成协议的一部分
    const rowsBeforeArchive = sqlite(otto, "select seq || '|' || type from events order by seq").split("\n");

    // 会话行的 ⋮ 菜单 → 归档（可逆操作，不弹 confirm）
    const row = win.getByRole("listitem").filter({ has: win.getByRole("button", { name: "会话操作" }) });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "会话操作" }).click();
    await win.getByRole("menuitem", { name: "归档" }).click();

    // 归档的是正看着的会话 → 回欢迎页；主列表的行没了，入口上的计数长出来
    await expect(win.getByRole("button", { name: "选择工作区" })).toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveCount(0);
    await expect(win.getByRole("button", { name: /已归档会话/ })).toContainText("1");
    // 按 type 找，不按"最后一条"找（见上面 rowsBeforeArchive 的注释）
    expect(
      sqlite(
        otto,
        "select json_extract(payload,'$.reason') from events where type='session_archived' order by seq"
      )
    ).toBe("user");

    // 切到「已归档会话」视图 → 归档区也按工程分组（组标题 = 工作区文件夹名）
    await win.getByRole("button", { name: /已归档会话/ }).click();
    const group = win.getByRole("button", { name: new RegExp(basename(ws)) });
    await expect(group).toBeVisible({ timeout: 10_000 });
    // 组可收放：收起来行不见了（条数顶上），再点回来行回来
    const archivedRow = win.getByRole("button", { name: "这个会话要被归档" });
    await expect(archivedRow).toBeVisible();
    await group.click();
    await expect(archivedRow).toHaveCount(0);
    await expect(group).toContainText("1");
    await group.click();
    await expect(archivedRow).toBeVisible();

    // → 恢复归档
    await win.getByRole("button", { name: "会话操作" }).click();
    await win.getByRole("menuitem", { name: "恢复归档" }).click();

    // 归档视图清空（入口常驻，所以断的是空态文案，不是入口消失）
    await expect(win.getByText("还没有归档的会话。会话行的 ⋮ 菜单里有「归档」。")).toBeVisible({
      timeout: 10_000,
    });
    // 返回后行回主列表（普通会话行 = 有 ⋮ 菜单的 listitem）
    await win.getByRole("button", { name: "返回会话列表" }).click();
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    // 日志只增不减：归档前的每一行原样还在（seq 和 type 都没变），归档/
    // 恢复各恰好一条状态事件
    const rowsAfter = new Set(sqlite(otto, "select seq || '|' || type from events order by seq").split("\n"));
    const missing = rowsBeforeArchive.filter((r) => !rowsAfter.has(r));
    expect(missing, `归档/恢复之后这些事件不见了或被改写了：${missing.join(", ")}`).toEqual([]);
    expect(sqlite(otto, "select count(*) from events where type='session_archived'")).toBe("1");
    expect(sqlite(otto, "select count(*) from events where type='session_unarchived'")).toBe("1");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
