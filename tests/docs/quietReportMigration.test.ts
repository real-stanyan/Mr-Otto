// 0060_quiet_report.sql 的可执行版（#1569）：五列挂在 notify_prefs 上、两条形状约束、到点索引；不建新表、不加函数、不动策略。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0060_quiet_report.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0060 免打扰与汇报", () => {
  it("五列都是 add column if not exists", () => {
    for (const col of ["quiet jsonb", "report jsonb", "tz text", "report_next_at timestamptz", "report_last_at timestamptz"]) {
      expect(code).toContain(`alter table public.notify_prefs add column if not exists ${col};`);
    }
  });
  it("形状约束：quiet 要 start/end；report 的 mode 只能 call/message、schedule 是对象；索引只扫开了汇报的行", () => {
    expect(code).toMatch(/notify_prefs_quiet_shape[\s\S]{0,200}quiet \? 'start' and quiet \? 'end'/);
    expect(code).toMatch(/notify_prefs_report_shape[\s\S]{0,260}report->>'mode' in \('call', 'message'\)/);
    expect(code).toMatch(/create index if not exists notify_prefs_report_due on public\.notify_prefs \(report_next_at\) where report is not null;/);
  });
  it("不建表、不加函数、不动策略（0049 的三条策略原样覆盖新列）", () => {
    expect(code).not.toMatch(/create table/i);
    expect(code).not.toMatch(/create (or replace )?function/i);
    expect(code).not.toMatch(/create policy/i);
  });
});
