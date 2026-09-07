import { describe, expect, it } from "vitest";
import {
  buildWorkReadScript,
  buildWorkSearchScript,
  parseWorkReadOutput,
  parseWorkSearchOutput,
  WORK_LIST_MAX_ENTRIES,
} from "../../services/runtime/src/workFiles.js";
import { CS_WORK_FILE_MAX_BYTES } from "../../src/shared/remote/cloudSession.js";

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);

/** 一条 find 记录：`%y\t%s\t%T@\t%f\0` */
const rec = (type: string, size: number, mtime: string, name: string): string =>
  `${type}${TAB}${size}${TAB}${mtime}${TAB}${name}${NUL}`;

describe("buildWorkReadScript（#1056）", () => {
  it("路径进单引号，注入不了", () => {
    const script = buildWorkReadScript("a'; rm -rf /; echo '");
    // 整段被单引号包住 + `'\''` 转义，所以那个分号永远只是文件名的一部分
    expect(script).toContain(`p='a'\\''; rm -rf /; echo '\\'''`);
    expect(script).not.toMatch(/^p=a; rm/m);
  });

  it("根路径（空串）不拼出 `/work/`", () => {
    // "$p" 为空时 target 保持 /work——拼成 "/work/" 也能跑，但 realpath 之后
    // 两条路径不同，日志里对不上号
    const script = buildWorkReadScript("");
    expect(script).toContain(`p=''`);
    expect(script).toContain(`if [ -n "$p" ]; then target="/work/$p"; fi`);
  });

  it("越界读的第二道闸在脚本里：realpath 之后必须还在 /work 下", () => {
    // 第一道（normalizeWorkPath）拦不住软链——一条指向 /etc 的软链是合法路径
    const script = buildWorkReadScript("x");
    expect(script).toContain("realpath -m");
    expect(script).toContain("/work|/work/*)");
    expect(script).toContain("printf 'denied");
  });

  it("文件那一路按同一个上限截断（协议里那份常量，不另写一个数）", () => {
    expect(buildWorkReadScript("a")).toContain(`head -c ${CS_WORK_FILE_MAX_BYTES}`);
  });
});

describe("parseWorkReadOutput（#1056）", () => {
  it("denied / missing 各是各的结局", () => {
    expect(parseWorkReadOutput("denied\n")).toEqual({ ok: false, message: "这条路径不在工作文件夹里。" });
    expect(parseWorkReadOutput("missing\n")).toEqual({ ok: true, node: { kind: "missing" } });
  });

  it("目录：解出条目，目录排在文件前面", () => {
    const out = `dir\n${rec("f", 12, "1700000000.0", "b.md")}${rec("d", 4096, "1700000001.0", "src")}`;
    const r = parseWorkReadOutput(out);
    expect(r).toEqual({
      ok: true,
      node: {
        kind: "dir",
        truncated: false,
        entries: [
          { name: "src", kind: "dir", size: 0, mtimeMs: 1700000001000 },
          { name: "b.md", kind: "file", size: 12, mtimeMs: 1700000000000 },
        ],
      },
    });
  });

  it("空目录 = 有 dir 表头、载荷为空（不是失败）", () => {
    expect(parseWorkReadOutput("dir\n")).toEqual({ ok: true, node: { kind: "dir", entries: [], truncated: false } });
  });

  it("名字里有换行和制表符照样解得出来（分隔符选择的全部意义）", () => {
    // 记录之间用 NUL 分（文件名里换行合法，NUL 不合法）；字段之间用 TAB 分而
    // **名字放最后**，所以名字里的 TAB 也不会把字段挤歪
    const weird = `两行\n名字${TAB}带制表符`;
    const out = `dir\n${rec("f", 3, "1700000000.0", weird)}`;
    const r = parseWorkReadOutput(out);
    expect(r.ok && r.node.kind === "dir" && r.node.entries[0]?.name).toBe(weird);
  });

  it("被 head -c 砍掉半截的尾记录整条丢掉并说出口，不猜它的内容", () => {
    const out = `dir\n${rec("f", 1, "1700000000.0", "ok.md")}f${TAB}9${TAB}17000`;
    const r = parseWorkReadOutput(out);
    expect(r.ok && r.node.kind === "dir" && r.node.truncated).toBe(true);
    expect(r.ok && r.node.kind === "dir" && r.node.entries.map((e) => e.name)).toEqual(["ok.md"]);
  });

  it("条目数超上限：截到上限并置 truncated（不静默截断）", () => {
    const many = Array.from({ length: WORK_LIST_MAX_ENTRIES + 3 }, (_, i) =>
      rec("f", 1, "1700000000.0", `f${String(i).padStart(4, "0")}.md`)
    ).join("");
    const r = parseWorkReadOutput(`dir\n${many}`);
    expect(r.ok && r.node.kind === "dir" && r.node.entries.length).toBe(WORK_LIST_MAX_ENTRIES);
    expect(r.ok && r.node.kind === "dir" && r.node.truncated).toBe(true);
  });

  it("软链之类归成 other，不细分", () => {
    const r = parseWorkReadOutput(`dir\n${rec("l", 7, "1700000000.0", "link")}`);
    expect(r.ok && r.node.kind === "dir" && r.node.entries[0]?.kind).toBe("other");
  });

  it("文件：表头之后整段都是正文（正文里有换行也不会被当表头）", () => {
    const r = parseWorkReadOutput(`file${TAB}5${TAB}0\nhi\nyo`);
    expect(r).toEqual({ ok: true, node: { kind: "file", text: "hi\nyo", truncated: false, size: 5 } });
  });

  it("文件截断了要说出口", () => {
    const r = parseWorkReadOutput(`file${TAB}999999${TAB}1\nhead`);
    expect(r.ok && r.node.kind === "file" && r.node.truncated).toBe(true);
  });

  it("二进制单列一档——「读不出人话」不是失败", () => {
    expect(parseWorkReadOutput(`binary${TAB}4096\n`)).toEqual({ ok: true, node: { kind: "binary", size: 4096 } });
  });

  it("看不懂的输出回 ok:false，**不猜**", () => {
    // 猜出来的目录清单和真的长得一模一样，而它是假的
    expect(parseWorkReadOutput("").ok).toBe(false);
    expect(parseWorkReadOutput("什么鬼\n").ok).toBe(false);
    expect(parseWorkReadOutput(`file${TAB}abc${TAB}0\nx`).ok).toBe(false);
  });
});

describe("buildWorkSearchScript（#1066）", () => {
  it("内容模式：查询进单引号，且排在 `--` 之后", () => {
    // 单引号挡命令注入，`--` 挡「-foo 被 rg 当成选项」——两件不同的事，都要
    const script = buildWorkSearchScript("-i'; rm -rf /", true);
    expect(script).toContain("rg --json -n --max-count 5 --no-ignore --hidden --");
    expect(script).toContain(String.raw`'-i'\''; rm -rf /'`);
  });

  it("文件名模式压根不把查询递给 rg（过滤在 runtime 进程里做）", () => {
    const script = buildWorkSearchScript("菜单", false);
    expect(script).toContain("rg --files --no-ignore --hidden");
    expect(script).not.toContain("菜单");
  });

  it("恒含被忽略与隐藏文件——树是全显的，搜索另设一套规矩会变成怪现象", () => {
    for (const content of [true, false]) {
      expect(buildWorkSearchScript("x", content)).toContain("--no-ignore --hidden");
    }
  });

  it("退出码单独带回来，不靠管道之后的 $?", () => {
    // 管道到 head 之后 `$?` 是 head 的，「rg 没装」(127) 与「没有匹配」(1) 会
    // 长得一模一样，于是「rg 挂了」被说成「仓里没有」
    const script = buildWorkSearchScript("x", true);
    expect(script).toContain("tmp=$(mktemp)");
    expect(script).toContain("rc=$?");
    expect(script).toContain(String.raw`printf 'hits\t%s\n' "$rc"`);
  });
});

describe("parseWorkSearchOutput（#1066）", () => {
  it("退出码 1 = 没匹配，**不是失败**（rg 的正常出口）", () => {
    expect(parseWorkSearchOutput(`hits${TAB}1\n`, "x")).toEqual({ ok: true, hits: [] });
    expect(parseWorkSearchOutput(`files${TAB}1\n`, "x")).toEqual({ ok: true, hits: [] });
  });

  it("退出码 127 = 容器里没有 rg，单说一句——它跟「没有匹配」该做的动作相反", () => {
    const r = parseWorkSearchOutput(`hits${TAB}127\n`, "x");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(/ripgrep/);
  });

  it("别的非零退出码 = 搜索出错", () => {
    expect(parseWorkSearchOutput(`hits${TAB}2\n`, "x").ok).toBe(false);
  });

  it("内容模式：走 rg 的 NDJSON，与本机面板同一个解析器", () => {
    const line = JSON.stringify({
      type: "match",
      data: { path: { text: "sub/b.md" }, lines: { text: "hello\n" }, line_number: 3 },
    });
    const r = parseWorkSearchOutput(`hits${TAB}0\n${line}\n`, "hello");
    expect(r).toEqual({ ok: true, hits: [{ rel: "sub/b.md", line: 3, text: "hello" }] });
  });

  it("文件名模式：子序列匹配（与本机面板同一个 matchesFilter）", () => {
    const payload = ["src/lib/a.ts", "docs/readme.md", "菜单.md"].join("\n");
    const r = parseWorkSearchOutput(`files${TAB}0\n${payload}`, "sla");
    // s-l-a 依次出现在 src/lib/a.ts 里；另两条没有
    expect(r).toEqual({ ok: true, hits: [{ rel: "src/lib/a.ts", line: null, text: null }] });
  });

  it("看不懂的输出回 ok:false，不猜成空结果", () => {
    expect(parseWorkSearchOutput("", "x").ok).toBe(false);
    expect(parseWorkSearchOutput("什么鬼\n", "x").ok).toBe(false);
    expect(parseWorkSearchOutput(`hits${TAB}abc\n`, "x").ok).toBe(false);
  });
});
