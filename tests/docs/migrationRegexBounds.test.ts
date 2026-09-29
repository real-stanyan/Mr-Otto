// supabase/migrations/ 里的 Postgres 正则计数不许超过 255（#1418）。
//
// Postgres 正则的重复次数上限是 255（DUPMAX）。`{16,256}` 不是「最多 256 个」，是一条**编译不过**的
// 正则：每次执行都抛 2201B「invalid repetition count(s)」。而它写在 plpgsql 函数体里时，create function
// 不编译它、migration 照样跑成功；冒烟时如果排在它前面的检查先抛了（比如无登录态的 `not signed in`），
// 那一行一次都不会被执行。0045 就是这么上线的：推送登记从第一天起每一次都失败，回电一通都打不出去。
//
// 判据是源码里的计数字面量，不是「这个函数跑不跑得通」——门禁连不上数据库，而这类错误只在执行那一刻出现。
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("../../supabase/migrations/", import.meta.url);
const DUPMAX = 255;

// 已在生产执行过、改不回去的历史文件：违规那一处由后面的 migration 覆盖掉了。
// 值是「谁覆盖了它」——下面有一条断言核对那个文件确实存在并重建了同一个对象。
const SUPERSEDED: Record<string, { by: string; redefines: RegExp }> = {
  "0045_push_devices.sql": {
    by: "0046_push_device_token_check.sql",
    redefines: /create or replace function public\.register_push_device\(p_token text, p_bundle text\)/,
  },
};

const codeOf = (file: string): string =>
  readFileSync(new URL(file, DIR), "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

function overLimit(code: string): string[] {
  const hits: string[] = [];
  for (const m of code.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
    const nums = [m[1], m[2]].filter((n): n is string => n !== undefined && n !== "").map(Number);
    if (nums.some((n) => n > DUPMAX)) hits.push(m[0]);
  }
  return hits;
}

describe("migration 里的正则计数 ≤ 255", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql"));

  it("判据本身认得出那种写法", () => {
    expect(overLimit("p_token !~ '^[0-9a-fA-F]{16,256}$'")).toEqual(["{16,256}"]);
    expect(overLimit("x ~ '^a{300}$'")).toEqual(["{300}"]);
    expect(overLimit("x ~ '^[a-z]{1,16}$' and y ~ '^a{255}$'")).toEqual([]);
  });

  for (const f of files) {
    if (f in SUPERSEDED) continue;
    it(f, () => {
      expect(overLimit(codeOf(f)), `${f} 里有超过 ${DUPMAX} 的正则计数：Postgres 会在执行时抛 2201B`).toEqual([]);
    });
  }

  for (const [f, { by, redefines }] of Object.entries(SUPERSEDED)) {
    it(`${f} 的违规由 ${by} 覆盖`, () => {
      expect(files).toContain(by);
      expect(codeOf(by)).toMatch(redefines);
      expect(overLimit(codeOf(by))).toEqual([]);
    });
  }
});
