// 审批记忆的 key 规范化（issue #342，借鉴 codex command_canonicalization.rs）。
//
// 「本会话记住该命令」的 key 粒度原则：**宁窄勿宽**。
// 太宽 = 静默放行危险变体（记 `git` 放过 `git push --force`）；
// 太窄 = 语义相同的调用被重复问（`/bin/bash -lc "git status"` vs `bash -lc "git status"`）。
// key 设计错了比没有记忆更危险——所以规则收在这一个纯函数模块里，全部可单测。
//
// 四条规则：
// ① 规范化后做 key：参数 token 化（识别引号）、解释器路径归一（/bin/bash → bash），
//    语义相同归同 key
// ② 无法安全 token 化的复杂脚本（管道/命令替换/重定向/多语句/glob）退化成
//    **原文精确匹配**——宁可多问一次，不做模糊归一
// ③ key 掺入 cwd：同一命令在不同 workspace 下是不同 key（"永久"授权跨会话，
//    不该跨目录漂移）。权限级别今天只有一档（ask 弹卡），沙箱分级（v2 Docker）
//    落地时在 key 里追加一段即可——SEP 编码天然可扩展
// ④ 一次操作触多个对象 → 逐对象建 key 分别存，后续调用的对象集是子集也能命中
//    （grantKeysFor 返回数组、匹配用 every）
//
// 兼容策略：不含分隔符的裸工具名（旧 permissions.json 的存量条目）仍按
// 「整个工具放行」的旧语义匹配——已经授出去的宽许可不静默收窄；新授权一律写窄 key。

import type { ToolCallRequest } from "../session/events.js";
import type { GrantScope } from "./permissionGrants.js";

/** key 段分隔符。U+001F（unit separator）：不会出现在命令/路径正文里，JSON 序列化安全 */
export const GRANT_KEY_SEP = "\u001f";

/** shell 命令规范化结果：cmd = 安全 token 化成功（canon 是 JSON 编码的 argv，
    无歧义等值比较）；raw = 复杂脚本，退化为去首尾空白后的原文精确匹配 */
export type CanonicalCommand = { kind: "cmd"; canon: string } | { kind: "raw"; raw: string };

/** 解释器/二进制的标准目录：argv0 带这些前缀时剥成 basename。
    只认这份白名单——`./x` 和 `/opt/custom/x` 不归一（不认识的路径不赌语义） */
const STD_BIN_DIRS = ["/bin/", "/usr/bin/", "/usr/local/bin/", "/opt/homebrew/bin/"];

/** 出现在引号外即判「复杂脚本」的 shell 元字符：管道/逻辑/多语句/子 shell/
    命令替换/重定向/转义/注释/glob/家目录展开。判定从严——漏放一个元字符的
    代价是静默放行，误判的代价只是多问一次 */
const META = new Set([..."|&;<>()`$\\#*?[]{}~!\n\r"]);

/**
 * 把一条 shell 命令规范化：识别单/双引号做 token 化，引号外遇到任何元字符、
 * 引号内遇到扩展（$、反引号）、或引号不闭合，一律退化 raw。
 */
export function canonicalizeCommand(cmd: string): CanonicalCommand {
  const raw = cmd.trim();
  const bail: CanonicalCommand = { kind: "raw", raw };
  const tokens: string[] = [];
  let cur = "";
  let inToken = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === "'") {
      const end = raw.indexOf("'", i + 1);
      if (end === -1) return bail; // 引号不闭合
      cur += raw.slice(i + 1, end);
      inToken = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < raw.length && raw[j] !== '"') {
        const d = raw[j]!;
        if (d === "\\") {
          buf += raw[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (d === "$" || d === "`") return bail; // 双引号内仍会扩展
        buf += d;
        j++;
      }
      if (j >= raw.length) return bail;
      cur += buf;
      inToken = true;
      i = j + 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (inToken) {
        tokens.push(cur);
        cur = "";
        inToken = false;
      }
      i++;
      continue;
    }
    if (META.has(c)) return bail;
    cur += c;
    inToken = true;
    i++;
  }
  if (inToken) tokens.push(cur);
  if (tokens.length === 0) return bail;

  // argv0 归一：/bin/bash → bash（仅白名单目录；同名不同物的风险被白名单圈死）
  const argv0 = tokens[0]!;
  for (const dir of STD_BIN_DIRS) {
    if (argv0.startsWith(dir) && !argv0.slice(dir.length).includes("/")) {
      tokens[0] = argv0.slice(dir.length);
      break;
    }
  }
  // JSON 编码 argv 而不是空格拼接：带空格的 token（引号来的）不会与相邻 token 混淆
  return { kind: "cmd", canon: JSON.stringify(tokens) };
}

/**
 * 一次工具调用对应的授权 key 集合。
 * 空数组 = 参数形状不对，**不可授权**（匹配永远失败，授权时无 key 可存）——
 * 宁可再问一次，不给畸形调用开门。
 */
export function grantKeysFor(
  call: Pick<ToolCallRequest, "name" | "args">,
  cwd: string | undefined
): string[] {
  const base = `${call.name}${GRANT_KEY_SEP}cwd=${cwd ?? ""}`;
  if (call.name === "bash") {
    const cmd = (call.args as { cmd?: unknown } | null)?.cmd;
    if (typeof cmd !== "string" || cmd.trim() === "") return [];
    const c = canonicalizeCommand(cmd);
    return [
      c.kind === "cmd"
        ? `${base}${GRANT_KEY_SEP}cmd=${c.canon}`
        : `${base}${GRANT_KEY_SEP}raw=${c.raw}`,
    ];
  }
  if (call.name === "write_file") {
    const path = (call.args as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || path === "") return [];
    return [`${base}${GRANT_KEY_SEP}path=${path}`];
  }
  // 其余要审批的工具（MCP 等）：参数语义未知，token 化说不清 → 维持工具粒度，
  // 但 key 仍掺 cwd（"永久"不跨目录漂移）。比旧的裸工具名窄一档
  return [base];
}

/** 这次调用是否已被授权：新式窄 key 全部命中（多对象子集语义），
    或命中旧式裸工具名（存量宽许可的兼容通道） */
export function callGranted(
  call: Pick<ToolCallRequest, "name" | "args">,
  cwd: string | undefined,
  granted: ReadonlySet<string>
): boolean {
  if (granted.has(call.name)) return true; // 旧语义：整个工具放行
  const keys = grantKeysFor(call, cwd);
  return keys.length > 0 && keys.every((k) => granted.has(k));
}

/** 两个许可集合（会话/永久）里谁放行了这次调用。都没有 = undefined（该弹卡） */
export function grantedScope(
  call: Pick<ToolCallRequest, "name" | "args">,
  cwd: string | undefined,
  session: ReadonlySet<string>,
  always: ReadonlySet<string>
): GrantScope | undefined {
  if (callGranted(call, cwd, session)) return "session";
  if (callGranted(call, cwd, always)) return "always";
  return undefined;
}
