// docs/adr/ 的编号唯一性——从"约定"变成"跑在门禁里"（issue #230）。
//
// 起因：0014 / 0031 / 0068 三对同号。最后一对是同一天两条并行 lane 各自开号、
// 相隔三分钟合进来的。撞号的代价不是文件重名（文件名后半截不一样，共存得好好的），
// 是**引用失去指向**：代码注释里写「ADR-0068」，读的人得靠上下文猜是哪一篇。
//
// AGENTS.md 的 Parallel shifts 原本只给协议 ADR 写了 claim-at-merge，
// docs/adr/ 这一侧没写；那条规则补上之后，这条断言是它的可执行版——
// 合并前 re-fetch 忘了改号，CI 当场红，而不是等下一个人来考古。
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ADR_DIR = join(__dirname, "..", "..", "docs", "adr");

describe("docs/adr/ 的四位编号唯一", () => {
  it("没有两篇 ADR 占同一个号", () => {
    const byNum = new Map<string, string[]>();
    for (const name of readdirSync(ADR_DIR)) {
      const num = /^(\d{4})-/.exec(name)?.[1];
      if (!num) continue; // 不按 NNNN- 开头的文件不归这条断言管（比如 README）
      byNum.set(num, [...(byNum.get(num) ?? []), name]);
    }
    const collided = [...byNum.entries()].filter(([, files]) => files.length > 1);
    expect(
      collided,
      collided.length === 0
        ? ""
        : "撞号了。改号规矩见 AGENTS.md「Roles of issues & PRs」：项目 ADR 的号在" +
          "**合并时**claim——合并前 re-fetch，撞了就在自己这个 PR 里把较晚的那篇改成" +
          "当时最大号 +1，文件顶部写一行「原为 ADR-00XX」，并更新仓内所有指向它的引用。" +
          `撞的是：${collided.map(([n, f]) => `${n} → ${f.join(" / ")}`).join("；")}`
    ).toEqual([]);
  });

  it("编号从 0001 起、不跳号（跳号说明有人删了 ADR，而 ADR 是只增不删的记录）", () => {
    const nums = readdirSync(ADR_DIR)
      .map((n) => /^(\d{4})-/.exec(n)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
    const missing = [];
    for (let i = 1; i <= (nums.at(-1) ?? 0); i++) if (!nums.includes(i)) missing.push(i);
    expect(missing, `缺号：${missing.join(", ")}`).toEqual([]);
  });
});
