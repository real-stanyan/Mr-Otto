// supabase/migrations/ 的编号唯一性——从「没人管」变成「跑在门禁里」（issue #1213 复审）。
//
// 起因：#1213 这条 lane 新增了 `0034_cloud_session_participants.sql`；一次从
// origin/main 的合并又带进来另一条 lane（#1140）的 `0034_workspace_wiki_journal.sql`。
// 两份 migration 占了同一个号，没有任何东西挡住它——docs/adr/ 有
// tests/docs/adrNumbers.test.ts 钉着唯一性，supabase/migrations/ 一直没有对应的版本，
// 直到这次撞号靠人工审出来才发现。
//
// 这次撞号比典型的 ADR 撞号更烫手：wiki journal 那份 0034 **已经在生产 Supabase 上
// 执行过**（见 docs/adr/0282-团队记忆换成LLM-wiki.md 与 supabase/README.md 的执行状态
// 记录，2026-09-09，controller 手动跑的）——这个号不只是「有争议」，是「已经花掉」。真正
// 被数据库认的是表名/列名，文件编号只是人读顺序的向导（旧文件永远不改，见
// supabase/README.md 开头那条纪律），但两份文件占同一个号会让「哪个文件对应哪次改动」
// 这条线索失效。后落地、且从没在生产库跑过的那份（`cloud_session_participants`）因此
// 改号到 0035，跑过的那份不动。
//
// 与 tests/docs/adrNumbers.test.ts 唯一的差别：**只断言唯一，不断言连号**。ADR 是
// 只增不删的记录，跳号意味着有人删掉了历史，所以那条测试连带断言「不跳号」；
// migration 文件不是这种记录——一份在合并前就被放弃的草稿分支完全可能留下一个从没
// 被认领过的号，那不是历史被删除的证据。断言「不跳号」只会把一次正常放弃的草稿变成
// 一次没有任何好处的红门禁，所以这里刻意只做唯一性这一条。
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

describe("supabase/migrations/ 的四位编号唯一", () => {
  it("没有两份 migration 占同一个号", () => {
    const byNum = new Map<string, string[]>();
    for (const name of readdirSync(MIGRATIONS_DIR)) {
      const num = /^(\d{4})_/.exec(name)?.[1];
      if (!num) continue; // 不按 NNNN_ 开头的文件不归这条断言管（比如 README）
      byNum.set(num, [...(byNum.get(num) ?? []), name]);
    }
    const collided = [...byNum.entries()].filter(([, files]) => files.length > 1);
    expect(
      collided,
      collided.length === 0
        ? ""
        : "撞号了。改号规矩同 docs/adr/（项目 ADR-0074）：先查哪一份已经在生产 Supabase " +
          "上执行过（supabase/README.md 的执行状态记录，或 docs/adr/ 里「已在 Cloud 上" +
          "执行」那类字样）——跑过的那份不能动，库认的是表名/列名不是文件号，改跑过的" +
          "那份只会制造文件与生产状态对不上的假象。把另一份（还没跑过的那份）改成" +
          "当时最大号 +1，文件头注加一行「原为 XXXX」并说明为什么改，再更新仓内所有" +
          "指向旧编号的引用（AGENTS.md / docs/adr / docs/superpowers 等）。" +
          `撞的是：${collided.map(([n, f]) => `${n} → ${f.join(" / ")}`).join("；")}`
    ).toEqual([]);
  });
});
