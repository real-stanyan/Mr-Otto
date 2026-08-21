// MCP 设置页表单的纯逻辑——组件只管渲染，判断题放这里方便单测。
//
// 四件事:
// ① 状态灯该显示什么(mcpDisplayStatus)——后端把"没试过"和"关掉的"都记成
//    connecting(main/mcpHub.ts syncFromDisk 的注释),UI 得靠 config.enabled
//    把"关掉的"分出来,不然一台被用户主动关掉的 server 会显示成"连接中",
//    像是卡住了,其实它压根没打算连。
// ② env/headers 在 Record<string,string> 和"可编辑的行数组"之间来回——
//    表单要能让用户加一行、删一行、改键名,Record 做不到"这一行还没打完键名"
//    这种中间态,数组才行。
// ③ 新建一台 server 时 id 该长什么样。
// ④ 凭据安全的判据——"这一行是不是正要把一个遮罩字符串当真凭据存下去"。
//    review 揪出来的洞（改键名 / 磁盘上键名带首尾空白）都塌缩到这一条判据上：
//    mergeMaskedCreds(main/mcpHub.ts)按键名逐个比对,老键名一旦对不上,遮罩
//    字符串就会被当"新值"直接写盘,而 maskKey 是幂等的——存错了以后,这一格
//    显示的还是同一串星号,界面上完全看不出凭据已经被吃掉。这条判据不是可选的
//    体验加分项,是防止真凭据被覆盖成星号且无法察觉的最后一道闸。

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
  /** 这一行从 baseline 加载时的键名，原样不裁剪、此后永不更新——
      用来判断"用户到底碰没碰过键名"，也用来在提交时替"完全没碰过"的行
      保留原始键名（哪怕它带首尾空白，见 recordFromRows 的注释）。
      blankRow() 新建的空行没有"原始"可言，记 null */
  originalKey: string | null;
  key: string;
  value: string;
}

let rowSeq = 0;
function nextRowId(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

/** Record → 可编辑行数组。给每行发一个跟内容无关的 rowId,
    originalKey 记下这一行最初的键名（原样，不裁剪） */
export function rowsFromRecord(record: Record<string, string>): KeyValueRow[] {
  return Object.entries(record).map(([key, value]) => ({
    rowId: nextRowId(),
    originalKey: key,
    key,
    value,
  }));
}

/** 空白行(占位符),供"添加一行"按钮用——originalKey: null,它没有"原始状态" */
export function blankRow(): KeyValueRow {
  return { rowId: nextRowId(), originalKey: null, key: "", value: "" };
}

/** 行数组 → Record，提交前调用。
    键名为空的行整行丢弃(还没打完的占位行不该提交);同名键后写的赢——用户改
    键名撞了已有的另一行,与其报错拦住输入,不如让他看见的最终结果符合
    "最后一次编辑生效"这条最直觉的规则。
    键名是否裁剪两端空白，分两种情况：
    - 这一行的键名跟 originalKey 一字不差（用户压根没碰过键名输入框，
      哪怕只是碰过 value）——原样保留，**不裁剪**。磁盘上的键名可能带
      首尾空白（手写 mcp.json 常见），这种行不裁剪是刻意的：裁剪会让
      "用户什么都没做、只是点了保存"这个动作，在 mergeMaskedCreds 眼里
      变成一次改名——老键名（带空白）在 stored 里找不到对应的新键名
      （裁剪后的），于是把遮罩字符串当真凭据写盘（review finding，
      见 mcpForm.test.ts "键名带首尾空白且从未编辑，不该被裁剪成新键"）。
    - 键名被用户实际改过（或是新建的行）——裁剪两端空白，粘贴常带尾随空格,
      这时候裁剪是纯粹的输入清理,不涉及"跟旧键名对不上"的风险 */
export function recordFromRows(rows: readonly KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const untouched = row.originalKey !== null && row.key === row.originalKey;
    const key = untouched ? (row.originalKey as string) : row.key.trim();
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

/** 改键名那一刻，这一行的 value 该不该跟着清空。
    判据：oldKey 是这一行**改名前**的键名，value 是这一行此刻的值——如果
    value 恰好等于 baseline 里 oldKey 对应的原始遮罩值，说明用户压根没碰过
    这一格的值，它现在装的是遮罩字符串，不是真凭据。改名之后继续留着这个
    字符串提交，mergeMaskedCreds 会在磁盘上按**新**键名去找旧值比对——找不到
    （旧值记在老键名下面），于是把这串星号原样当真凭据写盘，老键名连同它
    唯一的真凭据一起被丢弃。maskKey 是幂等的：写错之后这一格显示的还是
    同一串星号，界面上看不出任何变化，只有下次连接失败才会暴露——这正是
    review 里说的"不能只退让掉未改标记，必须真的挡住这条路"。
    命中就该清空，逼用户重新填一遍真值 */
export function shouldClearValueOnKeyRename(
  oldKey: string,
  value: string,
  baseline: Record<string, string>
): boolean {
  return oldKey !== "" && baseline[oldKey] === value;
}

/** 存之前的最后一道闸（shouldClearValueOnKeyRename 的兜底，不是替代）：
    草稿里有没有哪一行，键名不在 baseline 里（新建的/改过名的），但 value
    却等于 baseline 里**某一把**已有凭据的原始遮罩值——不管是哪条路径导致的
    （改名清空的那一下被绕过、粘贴带来的巧合字符串、未来别的代码路径），
    命中就该挡住保存，而不是抱着侥幸心态把一串遮罩当真凭据存出去。
    空字符串必须整体排除在"遮罩值"之外：maskKey("") === ""（"没配"就该显示
    成空串，不是一串星，见 keyMask.ts），空值从来不是任何凭据的遮罩形态。
    不排除的话，只要 baseline 里随便哪把 env/header 恰好配的是空字符串，
    这个判据就会把表单里**每一个**空着没填的新行/改名清空后的行都当成"漏网的
    遮罩"，挡住一切合法的新增和改名——空值没有秘密可言，不该参与这项检查 */
export function hasStrayMaskedValue(
  rows: readonly KeyValueRow[],
  baseline: Record<string, string>
): boolean {
  const baselineValues = new Set(Object.values(baseline).filter((v) => v !== ""));
  return rows.some(
    (r) => r.key !== "" && r.value !== "" && baseline[r.key] === undefined && baselineValues.has(r.value)
  );
}

/** command 按空白切分成 args 数组的简化版——不支持引号里带空格这种 shell 语法,
    这是有意的取舍:真要跑复杂命令行,用户本来就该手改 ~/.otter/mcp.json,
    这个输入框服务的是"贴一个 npx 命令"这种最常见的路径 */
export function splitArgs(text: string): string[] {
  return text.split(/\s+/).map((s) => s.trim()).filter((s) => s !== "");
}
