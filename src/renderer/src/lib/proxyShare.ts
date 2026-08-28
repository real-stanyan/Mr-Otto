// proxyShare —— 「圈白名单」那张勾选表的纯逻辑（issue #657，ADR-0151 / ADR-0162）。
//
// A 把「操作我已接通的服务」授给好友时，要圈两层：哪些服务、每个服务里的哪些工具。
// 线上那份白名单（ProxyGrant.allow）有一条容易踩的约定：
//
//   **`tools: []` 表示「这个服务全部工具都放行」**，不是「一个都不放行」。
//
// 所以「用户把某个服务下的工具全部取消勾选」绝不能编码成 `tools: []`——那会把
// 「什么都别给」变成「全都给」。这一层的存在就是为了让那件事在一个纯函数里被钉死，
// 而不是散在勾选框的 onChange 里靠人记得。
//
// 选择态用「服务 id → 'all' | 明确的工具名数组」表示：
//   - 缺席      = 这个服务没授权
//   - "all"     = 整服务放行（含 A 以后新装的工具——这是 A 主动选的宽口径）
//   - string[]  = 只放行这几个；空数组视同没授权（见上）

/** 勾选表的状态：服务 id → 全放行 or 明确的工具名清单 */
export type ProxySelection = Record<string, "all" | readonly string[]>;

/** 线上白名单的形状（= ProxyGrant["allow"] 的一项） */
export interface ProxyAllowEntry {
  serverId: string;
  tools: readonly string[];
}

/** 这个服务授权了没（"all" 或非空清单才算） */
export function isServerOn(sel: ProxySelection, serverId: string): boolean {
  const v = sel[serverId];
  return v === "all" || (Array.isArray(v) && v.length > 0);
}

/** 这个工具放行没 */
export function isToolOn(sel: ProxySelection, serverId: string, tool: string): boolean {
  const v = sel[serverId];
  if (v === "all") return true;
  return Array.isArray(v) && v.includes(tool);
}

/** 勾/取消整个服务。勾 = "all"（含以后新增的工具），取消 = 整条移除 */
export function toggleServer(sel: ProxySelection, serverId: string, on: boolean): ProxySelection {
  const next = { ...sel };
  if (on) next[serverId] = "all";
  else delete next[serverId];
  return next;
}

/**
 * 勾/取消单个工具。
 * 从 "all" 里取消一个 = 先摊成明确清单再减——否则没法表达「除了这一个」。
 * 减到空就整条移除：空清单在线上等于「全放行」，留着它等于把用户的「都不要」
 * 翻译成「都要」。
 */
export function toggleTool(
  sel: ProxySelection,
  serverId: string,
  tool: string,
  allTools: readonly string[]
): ProxySelection {
  const cur = sel[serverId];
  const explicit: string[] = cur === "all" ? [...allTools] : Array.isArray(cur) ? [...cur] : [];
  const at = explicit.indexOf(tool);
  if (at >= 0) explicit.splice(at, 1);
  else explicit.push(tool);

  const next = { ...sel };
  if (explicit.length === 0) delete next[serverId];
  // 又勾满了就收回成 "all"：以后 A 新装的工具跟着放行，语义与用户勾的那一下一致
  else if (allTools.length > 0 && explicit.length === allTools.length) next[serverId] = "all";
  else next[serverId] = explicit;
  return next;
}

/** 勾选表 → 线上白名单。空清单的服务一律不进（见文件头那条约定） */
export function buildAllow(sel: ProxySelection): ProxyAllowEntry[] {
  const out: ProxyAllowEntry[] = [];
  for (const [serverId, v] of Object.entries(sel)) {
    if (v === "all") out.push({ serverId, tools: [] });
    else if (Array.isArray(v) && v.length > 0) out.push({ serverId, tools: [...v] });
  }
  return out;
}

/** 线上白名单 → 勾选表（打开对话框时把已有授权回填进去） */
export function selectionFromAllow(allow: readonly ProxyAllowEntry[]): ProxySelection {
  const sel: ProxySelection = {};
  for (const a of allow) sel[a.serverId] = a.tools.length === 0 ? "all" : [...a.tools];
  return sel;
}

/** 一句话说清这份授权给了什么。`nameOf` 把 server id 换成展示名（认不出就用 id） */
export function describeAllow(
  allow: readonly ProxyAllowEntry[],
  nameOf: (serverId: string) => string = (id) => id
): string {
  if (allow.length === 0) return "没有授权";
  return allow
    .map((a) => (a.tools.length === 0 ? `${nameOf(a.serverId)}（全部工具）` : `${nameOf(a.serverId)}（${a.tools.length} 个工具）`))
    .join("、");
}

/** 审计账一行要显示的三段。decision/outcome 说人话——「denied」不是给用户看的 */
export interface AuditLine {
  time: string;
  target: string;
  verdict: string;
}

export function auditLine(rec: {
  ts: number; serverId: string; tool: string; decision: string; outcome: string; detail?: string;
}): AuditLine {
  const at = new Date(rec.ts);
  const time = `${String(at.getMonth() + 1)}月${String(at.getDate())}日 ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const verdict =
    rec.decision === "denied" ? `已拒绝${rec.detail ? `（${rec.detail}）` : ""}`
    : rec.outcome === "error" ? `出错了${rec.detail ? `（${rec.detail}）` : ""}`
    : "已执行";
  return { time, target: `${rec.serverId} / ${rec.tool}`, verdict };
}
