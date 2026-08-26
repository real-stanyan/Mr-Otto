// 权限设置页的可读化（issue #370）：把 permissions.json 的授权 key 和
// execPolicy.json 的 pattern 翻成人能读的形态。纯函数，规则全部可单测。
//
// key 的形状（shared/grantKey.ts）：
// - 旧条目 = 裸工具名（"bash"）——整个工具放行的宽语义
// - 新条目 = `tool␟cwd=<dir>[␟cmd=<JSON argv> | raw=<原文> | path=<路径>]`
//   （␟ = U+001F，不会出现在命令/路径正文里）

import { GRANT_KEY_SEP } from "../../../shared/grantKey.js";
import type { ExecRule } from "../../../shared/execPolicy.js";

export interface GrantDisplay {
  tool: string;
  /** 授权时的 workspace。缺席 = key 没掺 cwd（含旧条目） */
  cwd?: string;
  /** 命令/路径的可读形态。缺席 = 工具粒度的 key（MCP 等） */
  detail?: string;
  /** true = 旧条目（裸工具名）：整个工具放行，比新 key 宽一档——UI 该标出来 */
  legacy: boolean;
}

export function describeGrantKey(key: string): GrantDisplay {
  if (!key.includes(GRANT_KEY_SEP)) return { tool: key, legacy: true };
  const [tool = "", cwdSeg = "", rest] = key.split(GRANT_KEY_SEP);
  const cwd = cwdSeg.startsWith("cwd=") ? cwdSeg.slice(4) : cwdSeg;
  const base: GrantDisplay = { tool, legacy: false, ...(cwd !== "" ? { cwd } : {}) };
  if (rest === undefined) return base;
  if (rest.startsWith("cmd=")) {
    // canon 是 JSON 编码的 argv（grantKey.ts 用它做无歧义等值比较）。
    // 解析失败按原样展示——展示层不因一条坏 key 崩掉整页
    try {
      const argv = JSON.parse(rest.slice(4)) as unknown;
      if (Array.isArray(argv)) return { ...base, detail: argv.map(String).join(" ") };
    } catch { /* 落到下面按原样展示 */ }
    return { ...base, detail: rest.slice(4) };
  }
  if (rest.startsWith("raw=")) return { ...base, detail: rest.slice(4) };
  if (rest.startsWith("path=")) return { ...base, detail: rest.slice(5) };
  return { ...base, detail: rest };
}

/** execpolicy 的 pattern 可读化：token 逐个拼，一段是数组 = 这一位的候选集
    （shared/execPolicy.ts 的匹配语义），用 | 连出来 */
export function describeExecPattern(pattern: ExecRule["pattern"]): string {
  return pattern.map((seg) => (Array.isArray(seg) ? seg.join("|") : seg)).join(" ");
}
