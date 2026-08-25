// 会话归档的真机验收（ADR-0087）：
// ⋮ 菜单归档 → 主列表消失、回欢迎页 → 「已归档」区可见 → 恢复 → 回主列表。
// 库里两条状态事件（archived reason=user / unarchived）都在，日志一字没删。

import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession, type Otto } from "./harness.js";
import { fakeModelEnv, startFakeModel } from "./fakeModel.js";

function sqlite(otto: Otto, sql: string): string {
  return execFileSync("sqlite3", [join(otto.userData, "sessions.db"), sql], {
    encoding: "utf8",
  }).trim();
}

test("归档 → 已归档区 → 恢复：列表投影来回走，日志只增不减", async () => {
  const fake = await startFakeModel(() => ({ content: "收到。" }));
  const otto = await launchOtto({ env: fakeModelEnv(fake) });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "这个会话要被归档");
    await expect(win.getByText("收到。")).toBeVisible({ timeout: 20_000 });

    // 会话行的 ⋮ 菜单 → 归档（可逆操作，不弹 confirm）
    const row = win.getByRole("listitem").filter({ has: win.getByRole("button", { name: "会话操作" }) });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "会话操作" }).click();
    await win.getByRole("menuitem", { name: "归档" }).click();

    // 归档的是正看着的会话 → 回欢迎页；主列表的行没了，「已归档」区长出来
    await expect(win.getByRole("button", { name: "选择工作区" })).toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveCount(0);
    const eventsBefore = sqlite(otto, "select count(*) from events");
    expect(
      sqlite(otto, "select type, json_extract(payload,'$.reason') from events order by seq desc limit 1")
    ).toBe("session_archived|user");

    // 展开「已归档」→ 恢复归档
    await win.getByRole("button", { name: /已归档/ }).click();
    await win.getByRole("button", { name: "会话操作" }).click();
    await win.getByRole("menuitem", { name: "恢复归档" }).click();

    // 行回主列表（普通会话行 = 有 ⋮ 菜单的 listitem），已归档区清空消失
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    await expect(win.getByRole("button", { name: /已归档/ })).toHaveCount(0);
    // 日志只增不减：归档/恢复各一条状态事件，原有事件一条没少
    expect(Number(sqlite(otto, "select count(*) from events"))).toBe(Number(eventsBefore) + 1);
    expect(sqlite(otto, "select type from events order by seq desc limit 1")).toBe("session_unarchived");

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
