// tests/runtime/wikiScripts.test.ts
import { describe, expect, it } from "vitest";
import {
  buildWikiExtraneousScript, buildWikiHeadsScript, buildWikiInitScript, buildWikiLogAppendScript, buildWikiMoveScript,
  buildWikiPagesScript, buildWikiReadScript, buildWikiRemoveScript, buildWikiSearchScript, buildWikiSnapshotScript, buildWikiStateScript,
} from "../../services/runtime/src/wikiFs.js";

function strayControlChars(script: string): string[] {
  const out: string[] = [];
  for (const ch of script) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n") continue;
    if (code < 0x20 || code === 0x7f) out.push(`U+${code.toString(16).padStart(4, "0")}`);
  }
  return [...new Set(out)];
}

// 同 #1066 那条教训：脚本里的 `\0` `\t` 必须是两个字符的转义序列，判据是脚本的**字节**
describe("wiki 脚本里不许有裸控制字符（#1140，同 #1066）", () => {
  it("十一段脚本全部干净，且不含模板插值残留", () => {
    const scripts = [
      buildWikiStateScript(), buildWikiInitScript(), buildWikiReadScript("a'b.md"), buildWikiMoveScript(".tmp/w-1.md", "customers/acme.md"),
      buildWikiRemoveScript("x.md"), buildWikiHeadsScript(), buildWikiPagesScript(), buildWikiExtraneousScript(), buildWikiLogAppendScript(),
      buildWikiSearchScript("查'询"), buildWikiSnapshotScript("admin"),
    ];
    for (const s of scripts) {
      expect(strayControlChars(s)).toEqual([]);
      expect(s).not.toContain("${");
    }
    expect(buildWikiHeadsScript()).toContain(String.raw`-printf '%P\0'`);
    expect(buildWikiSnapshotScript("admin")).toContain(String.raw`printf 'own-missing\0'`);
    expect(buildWikiSearchScript("q")).toContain(String.raw`printf 'rc\t%s\n' "$?"`);
    expect(buildWikiReadScript("a'b.md")).toContain(String.raw`'/work/wiki/a'\''b.md'`);
  });
});
