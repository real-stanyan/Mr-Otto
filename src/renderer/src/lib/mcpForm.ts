// MCP 设置页表单的纯逻辑——组件只管渲染，判断题放这里方便单测。
//
// 三件事:
// ① 状态灯该显示什么(mcpDisplayStatus)——后端把"没试过"和"关掉的"都记成
//    connecting(main/mcpHub.ts syncFromDisk 的注释),UI 得靠 config.enabled
//    把"关掉的"分出来,不然一台被用户主动关掉的 server 会显示成"连接中",
//    像是卡住了,其实它压根没打算连。
// ② env/headers 在 Record<string,string> 和"可编辑的行数组"之间来回——
//    表单要能让用户加一行、删一行、改键名,Record 做不到"这一行还没打完键名"
//    这种中间态,数组才行。
// ③ 新建一台 server 时 id 该长什么样。

import type { McpServerConfig, McpStatus } from "../../../shared/mcp.js";

/** 状态灯的五种活法——比后端的 McpStatus 多一种 disabled。
    "config.enabled === false" 与"没试过就 connecting"合在一起，UI 才分得清
    "已经开着但还没跑"和"用户就是把它关了" */
export type McpDisplayStatus = "connected" | "connecting" | "needs-auth" | "failed" | "disabled";

export function mcpDisplayStatus(config: McpServerConfig, status: McpStatus): McpDisplayStatus {
  // 关掉的 server 后端永远记成 connecting(connectOne 直接跳过它,见 mcpHub.ts)——
  // 那个 connecting 对用户来说是假的,是"关着"，不是"连接中"
  if (!config.enabled) return "disabled";
  return status;
}

export interface KeyValueRow {
  /** 组件里用来当 React key 的稳定 id,与内容无关(改键名不该让这一行连带
      失焦——React 靠 key 决定要不要卸载重建 DOM,内容当 key 会导致输入到
      一半的行在改键名那一刻被当成"新的一行"，光标飞走) */
  rowId: string;
  key: string;
  value: string;
}

let rowSeq = 0;
function nextRowId(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

/** Record → 可编辑行数组。给每行发一个跟内容无关的 rowId */
export function rowsFromRecord(record: Record<string, string>): KeyValueRow[] {
  return Object.entries(record).map(([key, value]) => ({ rowId: nextRowId(), key, value }));
}

/** 空白行(占位符),供"添加一行"按钮用 */
export function blankRow(): KeyValueRow {
  return { rowId: nextRowId(), key: "", value: "" };
}

/** 行数组 → Record，提交前调用。
    键名两端空白裁掉(粘贴常带尾随空格);键名为空的行整行丢弃(还没打完的占位行
    不该提交);同名键后写的赢——用户改键名撞了已有的另一行,与其报错拦住输入，
    不如让他看见的最终结果符合"最后一次编辑生效"这条最直觉的规则 */
export function recordFromRows(rows: readonly KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    out[key] = row.value;
  }
  return out;
}

/** 新建 server 时校验 id。id 就是 mcp.json 里 mcpServers 下的对象键,没有字符集
    限制(不像 subagent 名字要落盘成文件名),这里只挡"没起名"和"跟已有的撞了"——
    真正决定"能不能存"的是磁盘上现在有什么,而不是某种命名规范 */
export function mcpServerIdError(id: string, existingIds: readonly string[]): string | null {
  const trimmed = id.trim();
  if (trimmed === "") return "先给这台 server 起个名字";
  if (existingIds.includes(trimmed)) return `已经有一台叫「${trimmed}」的 server 了`;
  return null;
}

/** 两份配置内容是否相同,与 Record 的键序无关(表单里加一行再删一行、或者
    env/headers 本来的落盘顺序，都不该被当成"改过了"）。dirty 判断靠它，
    不是靠 JSON.stringify 直接比——对象键序不保证稳定，会产生假阳性的"未保存" */
export function mcpConfigsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "stdio" && b.kind === "stdio") {
    return a.command === b.command && arraysEqual(a.args, b.args) && a.enabled === b.enabled && recordsEqual(a.env, b.env);
  }
  if (a.kind === "http" && b.kind === "http") {
    return a.url === b.url && a.enabled === b.enabled && recordsEqual(a.headers, b.headers);
  }
  return false;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function recordsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/** command 按空白切分成 args 数组的简化版——不支持引号里带空格这种 shell 语法,
    这是有意的取舍:真要跑复杂命令行,用户本来就该手改 ~/.otter/mcp.json,
    这个输入框服务的是"贴一个 npx 命令"这种最常见的路径 */
export function splitArgs(text: string): string[] {
  return text.split(/\s+/).map((s) => s.trim()).filter((s) => s !== "");
}
