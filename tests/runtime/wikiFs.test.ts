// tests/runtime/wikiFs.test.ts
import { describe, expect, it } from "vitest";
import { createContainerWikiFs, createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import type { ExecResult, ExecOptions } from "../../src/world/executionWorld.js";

const PAGE = (title: string, pinned = false, body = "正文") => `---\ntitle: ${title}\nsummary: s\npinned: ${pinned}\nupdated_by: x\nupdated_at: 2026-09-09T00:00:00Z\nsources: []\n---\n${body}\n`;

describe("createMemoryWikiFs", () => {
  it("absent → init → present；写读删；heads/pages 不含 index/log/log-*；extraneous 列杂物", async () => {
    const fs = createMemoryWikiFs();
    expect(await fs.state()).toBe("absent");
    await fs.init();
    expect(await fs.state()).toBe("present");
    await fs.writePage("customers/acme.md", PAGE("Acme"));
    await fs.writePage("index.md", "# 索引");
    await fs.writePage("log-20260901-000000.md", "old");
    fs.files.set("notes.txt", "杂物");
    expect(await fs.readPage("customers/acme.md")).toEqual({ text: PAGE("Acme"), bytes: Buffer.byteLength(PAGE("Acme"), "utf8") });
    expect(await fs.readPage("nope.md")).toBeNull();
    expect((await fs.listHeads()).map((h) => h.path)).toEqual(["customers/acme.md"]);
    expect((await fs.listHeads())[0]!.head).toBe("title: Acme\nsummary: s\npinned: false\nupdated_by: x\nupdated_at: 2026-09-09T00:00:00Z\nsources: []");
    expect(await fs.listPages()).toEqual([{ path: "customers/acme.md", text: PAGE("Acme"), truncated: false }]);
    expect(await fs.listExtraneous()).toEqual(["notes.txt"]);
    await fs.removePage("customers/acme.md");
    expect(await fs.readPage("customers/acme.md")).toBeNull();
  });
  it("appendLog 追加、超 100 KB 滚动到 log-<stamp>.md", async () => {
    const fs = createMemoryWikiFs();
    await fs.init();
    await fs.appendLog("## [2026-09-09 14:02] write | a.md | x | ");
    await fs.appendLog("## [2026-09-09 14:03] write | b.md | x | ");
    expect(fs.files.get("log.md")).toBe("## [2026-09-09 14:02] write | a.md | x | \n## [2026-09-09 14:03] write | b.md | x | \n");
    fs.files.set("log.md", "x".repeat(100 * 1024 + 1));
    await fs.appendLog("新的一行");
    expect([...fs.files.keys()].some((k) => /^log-\d{8}-\d{6}\.md$/.test(k))).toBe(true);
    expect(fs.files.get("log.md")).toBe("新的一行\n");
  });
  it("search 大小写不敏感、每页最多 3 条；snapshot 给 index / pinned / own（缺 → null）/ log 尾", async () => {
    const fs = createMemoryWikiFs({ "index.md": "# 索引", "team.md": PAGE("团队", true, "口径 A\n口径 b"), "agents/ops.md": PAGE("运营", false, "按月查"), "log.md": "l1\nl2" });
    expect(await fs.search("口径")).toEqual([{ path: "team.md", line: 9, text: "口径 A" }, { path: "team.md", line: 10, text: "口径 b" }]); // 页头 7 行 + 两条 --- = 正文从第 9 行起
    const snap = await fs.snapshot("ops");
    expect(snap.index).toBe("# 索引");
    expect(snap.pinned.map((p) => p.path)).toEqual(["team.md"]);
    expect(snap.own).toBe(PAGE("运营", false, "按月查"));
    expect(snap.logTail).toBe("l1\nl2");
    expect((await fs.snapshot("ads")).own).toBeNull();
  });
});

describe("createContainerWikiFs：脚本接线", () => {
  function fakeWorld(reply: (cmd: string, opts?: ExecOptions) => ExecResult) {
    const calls: { cmd: string; opts: ExecOptions | undefined }[] = [];
    const writes: [string, string][] = [];
    const world = {
      fs: { read: async () => "", write: async (p: string, c: string) => { writes.push([p, c]); } },
      exec: async (cmd: string, opts?: ExecOptions) => { calls.push({ cmd, opts }); return reply(cmd, opts); },
    };
    return { world, calls, writes };
  }
  const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });

  it("readPage：ok 行带真实字节数（head -c 之前量，#1210）；missing → null；其余退出码 → 抛", async () => {
    const body = "---\ntitle: A\n---\n正文";
    const bytes = Buffer.byteLength(body, "utf8");
    const { world } = fakeWorld((cmd) => (cmd.includes("nope") ? ok("missing\n") : ok(`ok\t${bytes}\n${body}`)));
    const fs = createContainerWikiFs(world);
    expect(await fs.readPage("a.md")).toEqual({ text: body, bytes });
    expect(await fs.readPage("nope.md")).toBeNull();
    // 老格式（ok 不带字节数）与看不懂的头一律抛——解析错了比报错更糟
    await expect(createContainerWikiFs(fakeWorld(() => ok(`ok\n${body}`)).world).readPage("a.md")).rejects.toThrow("看不懂");
    const bad = createContainerWikiFs(fakeWorld(() => ({ stdout: "", stderr: "boom", exitCode: 2 })).world);
    await expect(bad.readPage("a.md")).rejects.toThrow("boom");
  });
  it("writePage：先 fs.write 到 wiki/.tmp/，再 mv 到目标", async () => {
    const { world, calls, writes } = fakeWorld(() => ok(""));
    await createContainerWikiFs(world, { now: () => 1234 }).writePage("customers/acme.md", "内容");
    expect(writes[0]![0]).toMatch(/^wiki\/\.tmp\/w-1234-\d+\.md$/);
    expect(calls[0]!.cmd).toContain("mv -f --");
    expect(calls[0]!.cmd).toContain("'/work/wiki/customers/acme.md'");
  });
  it("appendLog：一行 + 换行走 stdin", async () => {
    const { world, calls } = fakeWorld(() => ok(""));
    await createContainerWikiFs(world).appendLog("## [x] write | a | b | c");
    expect(calls[0]!.opts?.stdin).toBe("## [x] write | a | b | c\n");
  });
  it("search：rc 0 解析 rg json 并去掉 ./；rc 1 空；rc 127 说没有 rg", async () => {
    const line = JSON.stringify({ type: "match", data: { path: { text: "./customers/acme.md" }, lines: { text: "月结 60 天\n" }, line_number: 9 } });
    expect(await createContainerWikiFs(fakeWorld(() => ok(`${line}\nrc\t0\n`)).world).search("月结")).toEqual([{ path: "customers/acme.md", line: 9, text: "月结 60 天" }]);
    expect(await createContainerWikiFs(fakeWorld(() => ok("rc\t1\n")).world).search("x")).toEqual([]);
    await expect(createContainerWikiFs(fakeWorld(() => ok("rc\t127\n")).world).search("x")).rejects.toThrow("ripgrep");
  });
  it("snapshot / listHeads / listPages / listExtraneous 各自过对应的解析", async () => {
    const { world } = fakeWorld((cmd) => {
      if (cmd.includes("own-missing")) return ok("index\t# 索引\0own-missing\0log\t\0");
      if (cmd.includes("-printf '%P\\t%y\\0'")) return ok("notes.txt\tf\0customers\td\0deep/er\td\0customers/acme.md\tf\0link.md\tl\0");
      if (cmd.includes("head -c 65536")) return ok("a.md\tf\t---\ntitle: A\n---\n正文\0big.md\tt\t前 64 KiB\0");
      return ok("a.md\ttitle: A\n\0");
    });
    const fs = createContainerWikiFs(world);
    expect((await fs.snapshot("ops")).own).toBeNull();
    expect(await fs.listHeads()).toEqual([{ path: "a.md", head: "title: A" }]);
    expect(await fs.listPages()).toEqual([
      { path: "a.md", text: "---\ntitle: A\n---\n正文", truncated: false },
      { path: "big.md", text: "前 64 KiB", truncated: true },
    ]);
    expect(await fs.listExtraneous()).toEqual(["notes.txt", "deep/er", "link.md"]);
  });
  it("listExtraneous 连顶层目录一起判（#1211）：名字不合法或没有合法页才报；有页的分组目录与 agents/.tmp 不报", async () => {
    const { world } = fakeWorld((cmd) =>
      cmd.includes("-printf '%P\\t%y\\0'")
        ? ok("customers\td\0customers/acme.md\tf\0agents\td\0node_modules\td\0Foo\td\0emptydir\td\0deep/er\td\0")
        : ok("")
    );
    // customers 有合法页 → 不是杂物；agents 是工具自己的目录；node_modules/Foo 名字不合法；
    // emptydir 名字合法但一个合法页都没有；deep/er 是第二层目录照旧报
    expect(await createContainerWikiFs(world).listExtraneous()).toEqual(["node_modules", "Foo", "emptydir", "deep/er"]);
  });
});
