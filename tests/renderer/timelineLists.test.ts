// 三份名单互相对表 —— 「时间线上哪些事件占一行」这件事写在三个地方：
//
//   1. `aui/toThreadMessages.ts` 的 `isAuditEvent`：哪些事件变成 system 消息
//   2. `components/Timeline.tsx` 的 `EventRow`：那条 system 消息长什么样
//   3. `lib/threadGroups.ts` 的 `isInvisible`：哪些事件不打断工具分组
//
// 1 是 2 的守门人（`isAuditEvent` 不放行，`EventRow` 的分支永远执行不到），
// 而三份名单靠注释里的「照抄上面那份」维系一致。这条约定已经**破过两次**：
// `skill_released` 只加进了 `EventRow`，于是那个 case 是死代码，用户点了「停用」
// 时间线上什么也不出现——一条被 UI 静默吞掉的日志事件。
//
// 纯 grep 级源码对表（同 tests/architecture.test.ts 的路子）：不渲染 React
// （本仓渲染层测试都是纯逻辑，没有 jsdom），只读三份源码里的 `case` 标签。
// 简单到一眼能看懂，挡的正是「新增一种事件类型，只改了三处里的一处」这种漏网。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..", "src", "renderer", "src");

/** 两条 predicate 互补的分支：三份名单都得**同时**把它当条件分支处理
    （audit = 拒绝 / 失败，invisible = 批准 / 正常收工），谁少一条都是 drift。
    多出第四条 = 有人加了新的条件分支，得回来想清楚三处的条件是不是还互补 */
const CONDITIONAL = ["approval_decision", "turn_ended"];

/** 从源码里切出某个函数体（从签名那行到第一个顶格闭合处）。
    `EventRow` 是 `memo(function …)`，闭合是 `});`；两种都收 */
function region(file: string, signature: string): string {
  const src = readFileSync(join(SRC, file), "utf8");
  const start = src.indexOf(signature);
  expect(start, `${file} 里找不到「${signature}」——源码改了形状，这条对表也得跟着改`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start);
  const end = rest.search(/\n\}\)?;?\n/);
  expect(end, `${file} 的「${signature}」没找到闭合`).toBeGreaterThan(0);
  return rest.slice(0, end);
}

interface Branch {
  types: string[];
  body: string;
}

/** switch 的分支切片：连写的 `case` 标签归成一组，跟着它们的语句合成 body。
    注释行整行丢掉——本仓注释里满是 `case`、`return null` 这类字样 */
function branches(text: string): Branch[] {
  const out: Branch[] = [];
  let types: string[] = [];
  let body: string[] = [];
  const flush = (): void => {
    if (types.length > 0) out.push({ types, body: body.join("\n") });
    types = [];
    body = [];
  };
  for (const raw of text.split("\n")) {
    // 行尾注释也剥掉：`return null; // 已被 ToolRow 吸收` 得能认成光秃秃的 return null
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "" || raw.trim().startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    const m = /^case "([A-Za-z_]+)":\s*(.*)$/.exec(line);
    if (m) {
      if (body.length > 0) flush();
      types.push(m[1]!);
      if (m[2] !== undefined && m[2] !== "") body.push(m[2]);
      continue;
    }
    if (/^default:/.test(line)) {
      flush();
      continue;
    }
    if (types.length > 0) body.push(line);
  }
  flush();
  return out;
}

type Verdict = "yes" | "no" | "conditional";

/** 两个 predicate 函数（isAuditEvent / isInvisible）：光秃秃的 `return true/false`
    才算死心眼的一种，其余（比较式、三元）都是看事件字段现算 = 条件分支 */
const binary =
  (yesLit: string, noLit: string) =>
  (body: string): Verdict => {
    const t = body.trim();
    if (t === yesLit) return "yes";
    if (t === noLit) return "no";
    return "conditional";
  };

/** EventRow：`return null;` = 不渲染；正文里压根没有 null = 铁定渲染出东西；
    两者都沾（if 里 return null、三元的 : null）= 条件分支 */
function rowVerdict(body: string): Verdict {
  const t = body.trim();
  if (t === "return null;") return "no";
  return /\bnull\b/.test(t) ? "conditional" : "yes";
}

function classify(text: string, judge: (body: string) => Verdict): Record<Verdict, string[]> {
  const out: Record<Verdict, string[]> = { yes: [], no: [], conditional: [] };
  for (const b of branches(text)) out[judge(b.body)].push(...b.types);
  for (const k of Object.keys(out) as Verdict[]) out[k].sort();
  return out;
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

const predicate = binary("return true;", "return false;");

// isAuditEvent：`return true` = 上时间线
const audit = classify(region("aui/toThreadMessages.ts", "function isAuditEvent"), predicate);
// EventRow：`return null` = 不渲染，其余（JSX / 组件）= 渲染
const row = classify(
  region("components/Timeline.tsx", "export const EventRow = memo(function EventRow"),
  rowVerdict
);
// isInvisible：`return true` = 不占行、不打断工具分组
const invisible = classify(region("lib/threadGroups.ts", "function isInvisible"), predicate);

describe("时间线三份名单一致（isAuditEvent / EventRow / threadGroups.isInvisible）", () => {
  it("每份名单都真的解析出了分支——正则失灵的话下面几条会假绿", () => {
    expect(audit.yes.length).toBeGreaterThan(5);
    expect(row.yes.length).toBeGreaterThan(5);
    expect(invisible.yes.length).toBeGreaterThan(3);
  });

  // 这一条就是 isAuditEvent 那句注释（「照抄 EventRow 不返回 null 的那些分支」）
  // 的可执行版。skill_released 当初漏的正是这里
  it("isAuditEvent 放行的 == EventRow 渲染出东西的", () => {
    expect(
      audit.yes,
      "两份名单对不上：只在 EventRow 里加 case 的话它是死代码（事件先过 isAuditEvent 才成为 system 消息）；" +
        "只在 isAuditEvent 里加的话时间线上是一行空白"
    ).toEqual(row.yes);
  });

  it("EventRow 明确 return null 的，threadGroups 也当它不可见", () => {
    const leaked = row.no.filter((t) => !invisible.yes.includes(t));
    expect(
      leaked,
      "这些事件 EventRow 不渲染，threadGroups 却让它打断工具分组 —— 时间线上会出现凭空的断口"
    ).toEqual([]);
  });

  it("threadGroups 判定不可见的，不会出现在另外两份名单里", () => {
    expect(sorted(invisible.yes.filter((t) => audit.yes.includes(t)))).toEqual([]);
    expect(sorted(invisible.yes.filter((t) => row.yes.includes(t)))).toEqual([]);
  });

  it("条件分支恰好那两条（approval_decision / turn_ended），三处同时是条件分支", () => {
    expect(audit.conditional).toEqual(sorted(CONDITIONAL));
    expect(row.conditional).toEqual(sorted(CONDITIONAL));
    expect(invisible.conditional).toEqual(sorted(CONDITIONAL));
  });

  it("skill 的启用/停用两行都在（ADR-0122：谁把说明书塞进上下文的，用户得看得见）", () => {
    for (const t of ["skill_invoked", "skill_released"]) {
      expect(audit.yes, `isAuditEvent 少了 ${t}`).toContain(t);
      expect(row.yes, `EventRow 少了 ${t}`).toContain(t);
    }
  });
});
