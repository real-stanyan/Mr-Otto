import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** index.ts 没法 import 进 vitest（一进来就要 electron），装配线上的判据只能读源码钉住——
    同 tests/main/accountScope.test.ts 对 partition 接线的做法（#1223 终审复审 New issue #1） */
describe("taskSync 装配的 isRunning 接线", () => {
  it("要把 admitting 算进去——准入拿笔那一次网络往返里，并发的 push 收尾不许把刚拿到的笔放掉", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "main", "index.ts"), "utf8");
    const m = src.match(/isRunning:\s*\(id\)\s*=>\s*([^,\n]+)/);
    expect(m, "index.ts 里找不到 taskSync 的 isRunning 接线").not.toBeNull();
    // 两个准入入口（handleSendMessage / answerLogged）都把 admitting 握到 driveTurn 的 finally，
    // 所以 runningSessions ∪ admitting 才盖得住「准入 + turn」全程；只看前者就有一个真网络往返的缝
    expect(m![1]).toContain("runningSessions.has(id)");
    expect(m![1]).toContain("admitting.has(id)");
  });
});
