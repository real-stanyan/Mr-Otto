// 用户 execpolicy 规则文件（issue #347）：userData/execPolicy.json。
//
// 与 permissions.json（#342 精确 key）的分工：那边是「这一条命令（含 cwd）
// 我批过」，这边是「这一**类**前缀我有态度」——规则可写 forbidden（永不放行），
// 也可由审批 UI 的「永久」产出 allow（前缀语义，比精确 key 宽一档，
// 所以要过禁止前缀清单的校验，过不了就退回精确 key，见 agent.ts）。
//
// 加载期校验（issue #347 ②）：坏规则拒绝加载——整个文件按空规则处理并把
// 错误留在返回值里（fail-safe：没有规则 = 一切照旧走审批记忆 → 弹卡，
// 不存在"半份规则误放行"）。
// 热更新：读取方每次 decide 现读本函数（与 loadAlwaysAllow 同款手法），
// 审批 UI 追加规则后下一次判定立即生效，跨会话天然生效。

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { validateRules, type ExecRule } from "../shared/execPolicy.js";

export interface ExecPolicyFile {
  rules: ExecRule[];
}

export interface LoadedPolicy {
  rules: ExecRule[];
  /** 非空 = 文件没通过校验，规则未生效（fail-safe）。给日志/设置页展示 */
  error?: string;
}

export function loadExecPolicy(path: string): LoadedPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // 没有文件 = 还没写过规则，正常空态；坏 JSON = 拒绝加载并报错
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { rules: [] };
    return { rules: [], error: `execPolicy.json 不是合法 JSON：${(err as Error).message}` };
  }
  const rules = (parsed as ExecPolicyFile | null)?.rules;
  if (!Array.isArray(rules)) {
    return { rules: [], error: "execPolicy.json 缺少 rules 数组" };
  }
  const errors = validateRules(rules as ExecRule[]);
  if (errors.length > 0) {
    return {
      rules: [],
      error: errors.map((e) => `规则 #${e.index}：${e.message}`).join("；"),
    };
  }
  return { rules: rules as ExecRule[] };
}

/** 审批 UI「永久」产出的 allow 规则（issue #347 ③）：pattern = 规范化 argv
    整条精确 token，cwd 掺入（#342 的「永久不跨目录漂移」原样沿用）。
    追加前跑同一套校验（含禁止前缀清单）：过不了返回 false，调用方退回
    精确 key；文件当前是坏的也拒绝追加——不往一个没生效的文件里堆规则 */
export function appendAllowRule(path: string, pattern: string[], cwd: string | undefined): boolean {
  const current = loadExecPolicy(path);
  if (current.error) return false;
  const rule: ExecRule = { pattern, decision: "allow", ...(cwd !== undefined ? { cwd } : {}) };
  if (validateRules([rule]).length > 0) return false;
  // 幂等：同 pattern + 同 cwd 的 allow 已存在就不重复写
  const dup = current.rules.some(
    (r) =>
      r.decision === "allow" &&
      r.cwd === rule.cwd &&
      JSON.stringify(r.pattern) === JSON.stringify(rule.pattern)
  );
  if (!dup) {
    const body: ExecPolicyFile = { rules: [...current.rules, rule] };
    mkdirSync(dirname(path), { recursive: true });
    // 0600 同 permissions.json：这份文件说的是"哪些命令不再问人"
    writeFileSync(path, JSON.stringify(body, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return true;
}
