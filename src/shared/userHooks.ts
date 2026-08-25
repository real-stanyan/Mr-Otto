// 用户钩子（issue #395，Claude Code hooks 对照）——纯类型 + 校验 + 裁决解析。
//
// engine 的 Pre/PostToolUse 钩子接口（issue #350）一直只留着口没人用；这里把
// 「用户自己写的 shell 命令」接上去：userData/hooks.json 声明钩子，工具调用
// 前后跑用户命令，stdin 收 JSON 上下文，stdout 回 JSON 裁决。
//
// 协议（照着 CC 的 stdin/stdout 形态，映射到本仓 PreHookResult/PostHookResult）：
// - stdin：{"phase","tool","toolCallId","args","workspace"}；post 多 {"status","output"}
// - stdout（exit 0 时解析）：pre 认 {"block": "..."} / {"reviseArgs": {...}}；
//   post 认 {"reject": "..."} / {"feedback": "..."}。非 JSON / 认不出的键 = 弃权
//   ——钩子顺手 echo 的日志不该被误读成裁决，宁可漏判不误判
// - exit 2 = 拦截/拒绝（stderr 优先作理由）——CC 同款的「快捷否决」
// - 其余非零 exit = 钩子自身失败，按弃权处理（fail-open：钩子是观察/干预者，
//   不是安全边界——安全边界是守卫和审批门，见 middleware.ts 的超时立场）
//
// 校验风格与 shared/execPolicy.ts 同款：加载期爆，不在运行期误伤。

export interface UserHookDef {
  /** 钩子名：落进 tool_hook 事件（谁干预的） */
  name: string;
  phase: "pre" | "post";
  /** 匹配哪些工具："*" 全部；数组按名（可写 CC 名，HOOK_TOOL_ALIASES 兜底） */
  tools: "*" | string[];
  /** 用户的 shell 命令。cwd = 工作区，10s 超时，凭据环境变量已剥 */
  command: string;
}

/** 加载/校验结果。error 非空 = 整份文件按空钩子处理（fail-safe，
    与 execPolicyStore 同款：没有钩子 = 一切照旧，不存在"半份钩子"） */
export interface ValidatedUserHooks {
  hooks: UserHookDef[];
  error?: string;
}

export function validateUserHooks(parsed: unknown): ValidatedUserHooks {
  const hooks = (parsed as { hooks?: unknown } | null)?.hooks;
  if (!Array.isArray(hooks)) {
    return { hooks: [], error: "hooks.json 缺少 hooks 数组" };
  }
  const out: UserHookDef[] = [];
  for (let i = 0; i < hooks.length; i++) {
    const h = hooks[i] as Partial<UserHookDef> | null;
    const at = `hooks[${i}]`;
    if (typeof h !== "object" || h === null) return { hooks: [], error: `${at} 不是对象` };
    if (typeof h.name !== "string" || !h.name.trim())
      return { hooks: [], error: `${at}.name 必须是非空字符串` };
    if (h.phase !== "pre" && h.phase !== "post")
      return { hooks: [], error: `${at}.phase 必须是 "pre" 或 "post"` };
    const toolsOk =
      h.tools === "*" ||
      (Array.isArray(h.tools) && h.tools.length > 0 && h.tools.every((t) => typeof t === "string" && t.trim()));
    if (!toolsOk) return { hooks: [], error: `${at}.tools 必须是 "*" 或非空字符串数组` };
    if (typeof h.command !== "string" || !h.command.trim())
      return { hooks: [], error: `${at}.command 必须是非空字符串` };
    out.push({ name: h.name, phase: h.phase, tools: h.tools as "*" | string[], command: h.command });
  }
  return { hooks: out };
}

/** 钩子进程收到的 stdin 上下文（JSON 序列化后写入） */
export interface UserHookInput {
  phase: "pre" | "post";
  tool: string;
  toolCallId: string;
  args: unknown;
  workspace?: string;
  /** 仅 post：工具的执行结果 */
  status?: "ok" | "error" | "denied";
  output?: string;
}

/** pre 裁决（解析结果，engine 的 PreHookResult 子集语义） */
export interface ParsedPreVerdict {
  block?: string;
  reviseArgs?: unknown;
}
export interface ParsedPostVerdict {
  reject?: string;
  feedback?: string;
}

/** exit 2 的理由：stderr 优先（错误话语的惯用通道），空了退 stdout，再空给默认文案 */
export function exit2Reason(stdout: string, stderr: string): string {
  return stderr.trim() || stdout.trim() || "钩子拦截（exit 2，未给理由）";
}

/** stdout（exit 0）里的 JSON 裁决。非 JSON / 形状不对 = null（弃权）。
    只认对象字面量开头的输出——钩子顺手打的日志不误读 */
function parseVerdictObject(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (!text.startsWith("{")) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parsePreVerdict(stdout: string): ParsedPreVerdict | null {
  const v = parseVerdictObject(stdout);
  if (!v) return null;
  const out: ParsedPreVerdict = {};
  if (typeof v["block"] === "string") out.block = v["block"];
  if ("reviseArgs" in v) out.reviseArgs = v["reviseArgs"];
  return out.block !== undefined || "reviseArgs" in v ? out : null;
}

export function parsePostVerdict(stdout: string): ParsedPostVerdict | null {
  const v = parseVerdictObject(stdout);
  if (!v) return null;
  const out: ParsedPostVerdict = {};
  if (typeof v["reject"] === "string") out.reject = v["reject"];
  if (typeof v["feedback"] === "string") out.feedback = v["feedback"];
  return out.reject !== undefined || out.feedback !== undefined ? out : null;
}
