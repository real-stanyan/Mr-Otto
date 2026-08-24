// 命令安全静态判定（issue #347，codex execpolicy crate 对照）。
//
// 「哪些命令安全可自动放行」从审批记忆的逐条积累（#342 精确 key）升一层：
// 声明式**前缀规则**做静态判定，规则可由审批 UI 直接产出（main/execPolicyStore.ts）。
//
// 三道防线，全部纯函数可单测：
// ① 规则模型：有序前缀 token（元素可为「或」列表）→ allow|prompt|forbidden，
//    多规则命中取最严（forbidden > prompt > allow）
// ② 加载期校验：规则形状 + 自带 match/not_match 用例 + 禁止前缀清单
//    ——规则写错在加载时爆，不在运行期误放行
// ③ 兜底启发式（从窄做起）：包装命令（sudo/env/bash -lc…）递归解析、
//    rm 带 force 降级——启发式永不产生 allow，只会收紧
//
// token 化复用 #342 的 canonicalizeCommand：无法安全 token 化的复杂脚本
// （管道/命令替换/重定向…）不做静态判定——宁可弹卡，不做模糊归一。

import { canonicalizeCommand } from "./grantKey.js";

export type PolicyDecision = "allow" | "prompt" | "forbidden";

/** 一条前缀规则。pattern 与命令 argv 做**前缀匹配**：pattern 的每个元素
    依次对上 argv 的对应 token（元素是数组 = 「或」，命中其一即可）；
    argv 比 pattern 长照样命中（前缀语义——这正是它比精确 key 宽的地方，
    也是禁止前缀清单存在的原因）。
    cwd 有值 = 规则只在该工作区生效（审批产出的规则带上它，沿用 #342 的
    「永久不跨目录漂移」）；缺席 = 全局（手写规则的默认）。
    match/not_match：规则自带的用例，加载期逐条跑——写错的 pattern 当场爆 */
export interface ExecRule {
  pattern: (string | string[])[];
  decision: PolicyDecision;
  cwd?: string;
  match?: string[];
  notMatch?: string[];
}

/** 取最严：forbidden > prompt > allow */
const SEVERITY: Record<PolicyDecision, number> = { allow: 0, prompt: 1, forbidden: 2 };

export function strictest(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** 禁止前缀清单（issue #347 ④，照搬 codex 思路）——这些前缀后面能接任意东西，
    不允许成为可复用的 allow 前缀。分两类语义：
    - 包装/解释器（WRAPPER）：allow 规则的 pattern 与该条目**任一方向互为前缀**
      都拒绝——`["bash"]`（比 `bash -lc` 更宽）和 `["bash","-lc","x"]`（脚本体
      任意）都不行
    - 裸命令（BARE）：只拒 pattern **恰好等于**该单 token 的 allow 规则——
      `["git"]` 放行一切 git 子命令所以不行，`["git","status"]` 可以 */
export const WRAPPER_FORBIDDEN: string[][] = [
  ["bash", "-c"], ["bash", "-lc"], ["bash", "-ic"], ["bash", "-ilc"],
  ["sh", "-c"], ["sh", "-lc"],
  ["zsh", "-c"], ["zsh", "-lc"], ["zsh", "-ic"],
  ["dash", "-c"], ["ksh", "-c"], ["fish", "-c"],
  ["python", "-c"], ["python3", "-c"], ["python2", "-c"],
  ["node", "-e"], ["node", "-p"], ["node", "--eval"],
  ["deno", "eval"], ["bun", "-e"],
  ["ruby", "-e"], ["perl", "-e"], ["perl", "-E"], ["php", "-r"],
  ["osascript", "-e"],
  ["sudo"], ["doas"], ["su"],
  ["env"], ["xargs"], ["eval"], ["exec"], ["command"], ["builtin"],
  ["nohup"], ["time"], ["nice"], ["ionice"], ["stdbuf"], ["timeout"],
  ["watch"], ["script"], ["expect"],
  ["ssh"], ["mosh"],
];

/** 裸命令：单独放行整个命令 = 放行它全部子命令/参数空间，太宽 */
export const BARE_FORBIDDEN: string[] = [
  "git", "rm", "mv", "cp", "dd", "chmod", "chown", "chgrp", "ln",
  "kill", "killall", "pkill",
  "curl", "wget", "nc", "ncat", "socat",
  "docker", "podman", "kubectl",
  "npm", "npx", "pnpm", "yarn", "pip", "pip3", "gem", "cargo", "brew", "apt", "apt-get", "yum",
  "make", "launchctl", "systemctl", "crontab",
  "find", // find -exec 能跑任意命令，且 -exec 位置不定，前缀规则圈不住——整个裸放行禁止
  "osascript", "open", "defaults",
  "mount", "umount", "diskutil", "mkfs",
  "shutdown", "reboot", "halt",
];

/** pattern 一个元素对一个 token：字符串精确等；数组 = 「或」 */
function elementMatches(el: string | string[], token: string): boolean {
  return Array.isArray(el) ? el.includes(token) : el === token;
}

/** 前缀匹配：pattern 全部元素依次命中 argv 开头。argv 更长照样命中 */
export function patternMatches(pattern: ExecRule["pattern"], argv: string[]): boolean {
  if (pattern.length === 0 || pattern.length > argv.length) return false;
  return pattern.every((el, i) => elementMatches(el, argv[i]!));
}

/** pattern 是否「必然落在」某个禁止前缀里（用于 allow 规则校验）。
    元素是「或」列表时按**存在任一展开命中**算——或列表里混进一个危险 token
    就整条拒绝，宁严勿松 */
function anyExpansionPrefixOverlap(pattern: ExecRule["pattern"], entry: string[]): boolean {
  const n = Math.min(pattern.length, entry.length);
  for (let i = 0; i < n; i++) {
    if (!elementMatches(pattern[i]!, entry[i]!)) return false;
  }
  return true; // 走到这 = 短的一方是长的一方的前缀（任一方向）
}

export interface RuleError {
  index: number;
  message: string;
}

/** 加载期校验（issue #347 ②）：形状 + 禁止前缀 + 自带用例。
    返回全部错误（不是第一个就停）——修规则文件的人一次看全。
    空数组 = 通过 */
export function validateRules(rules: ExecRule[]): RuleError[] {
  const errors: RuleError[] = [];
  rules.forEach((rule, index) => {
    const bad = (message: string) => errors.push({ index, message });

    if (!Array.isArray(rule.pattern) || rule.pattern.length === 0) {
      bad("pattern 必须是非空数组");
      return;
    }
    for (const el of rule.pattern) {
      const ok =
        (typeof el === "string" && el !== "") ||
        (Array.isArray(el) && el.length > 0 && el.every((t) => typeof t === "string" && t !== ""));
      if (!ok) {
        bad("pattern 元素必须是非空字符串或非空字符串数组（「或」列表）");
        return;
      }
    }
    if (rule.decision !== "allow" && rule.decision !== "prompt" && rule.decision !== "forbidden") {
      bad(`decision 非法：${String((rule as { decision?: unknown }).decision)}`);
      return;
    }

    // 禁止前缀清单只约束 allow 规则——用这些 pattern 写 forbidden 正是清单的本意
    if (rule.decision === "allow") {
      for (const entry of WRAPPER_FORBIDDEN) {
        if (anyExpansionPrefixOverlap(rule.pattern, entry)) {
          bad(`allow 规则撞上禁止前缀「${entry.join(" ")}」——该前缀后面能接任意东西`);
          break;
        }
      }
      if (rule.pattern.length === 1) {
        const el = rule.pattern[0]!;
        const hits = Array.isArray(el)
          ? el.filter((t) => BARE_FORBIDDEN.includes(t))
          : BARE_FORBIDDEN.includes(el)
            ? [el]
            : [];
        if (hits.length > 0) {
          bad(`allow 规则不允许裸放行「${hits.join("、")}」——等于放行它全部子命令`);
        }
      }
    }

    // 自带用例：match 必须命中、notMatch 必须不命中。用例本身 token 化失败也算错
    for (const [field, want] of [
      ["match", true],
      ["notMatch", false],
    ] as const) {
      for (const cmd of rule[field] ?? []) {
        const c = canonicalizeCommand(cmd);
        if (c.kind === "raw") {
          bad(`${field} 用例「${cmd}」无法 token 化（复杂脚本做不了前缀匹配）`);
          continue;
        }
        const argv = JSON.parse(c.canon) as string[];
        if (patternMatches(rule.pattern, argv) !== want) {
          bad(
            want
              ? `match 用例「${cmd}」没有命中 pattern——规则写错了`
              : `notMatch 用例「${cmd}」命中了 pattern——规则比想象的宽`
          );
        }
      }
    }
  });
  return errors;
}

// ─── 求值 ──────────────────────────────────────────────────

/** 包装命令拆壳（issue #347 ⑤，从窄做起）：返回内层 argv，拆不动返回 null。
    - sudo/doas/nohup/time/nice/timeout/stdbuf…：剥掉包装头（连它的短选项），内层就是余下 argv
    - env：再剥掉 VAR=value 赋值段
    - bash -lc "script" / sh -c …：script 是字符串，重新 token 化；复杂脚本
      token 化失败 = 拆不动（null）——静态判定到此为止，交回弹卡 */
function unwrap(argv: string[]): string[] | null {
  const head = argv[0];
  if (head === undefined) return null;

  const PASSTHROUGH = new Set(["sudo", "doas", "nohup", "time", "nice", "stdbuf", "timeout", "command"]);
  if (PASSTHROUGH.has(head)) {
    // 剥掉包装命令自己的选项（-n / -u user / 数值超时…统统跳过到第一个不带 - 的 token）。
    // timeout/stdbuf 的第一个位置参数（时长/模式）也一并跳过——从窄做起：
    // 拆不清楚就返回 null，不硬猜
    let i = 1;
    while (i < argv.length && argv[i]!.startsWith("-")) i++;
    if (head === "timeout" || head === "stdbuf") i++; // 时长 / -o 模式参数
    const inner = argv.slice(i);
    return inner.length > 0 ? inner : null;
  }
  if (head === "env") {
    let i = 1;
    while (i < argv.length && (argv[i]!.includes("=") || argv[i]!.startsWith("-"))) i++;
    const inner = argv.slice(i);
    return inner.length > 0 ? inner : null;
  }
  const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
  if (SHELLS.has(head)) {
    const flagIdx = argv.findIndex((t, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(t));
    const script = flagIdx > 0 ? argv[flagIdx + 1] : undefined;
    if (script === undefined) return null;
    const c = canonicalizeCommand(script);
    if (c.kind === "raw") return null;
    return JSON.parse(c.canon) as string[];
  }
  return null;
}

/** rm 带 force/递归（issue #347 ⑤）：启发式认定「有杀伤力」。
    只看 rm——从窄做起，别的命令不猜 */
function rmForce(argv: string[]): boolean {
  if (argv[0] !== "rm") return false;
  return argv.slice(1).some((t) => /^-[a-zA-Z]*[frR]/.test(t));
}

const MAX_UNWRAP_DEPTH = 3;

export interface EvaluateResult {
  decision: PolicyDecision;
  /** 给日志/弹窗看的判定依据（"规则 #2 forbidden" / "rm 带 force 降级"这种） */
  reason: string;
}

/**
 * 对一条 shell 命令做静态判定。undefined = 规则没说、启发式也没意见——
 * 交给下游（审批记忆 → 弹卡）。
 *
 * 求值顺序：
 * 1. token 化失败（复杂脚本）→ undefined（静态判定不掺和，#342 同款保守）
 * 2. 逐层拆壳（深度上限 3），每一层都跑一遍规则——`sudo git push` 的内层
 *    `git push` 也要对规则负责；所有层取最严
 * 3. 启发式收紧：rm 带 force / 命中包装前缀 → allow 降级 prompt
 *    （除非命中的 allow 规则是**整条精确**的——pattern 长度等于 argv，
 *    用户逐字批过的命令不再降级）
 */
export function evaluateCommand(
  cmd: string,
  rules: ExecRule[],
  cwd?: string
): EvaluateResult | undefined {
  const c = canonicalizeCommand(cmd);
  if (c.kind === "raw") return undefined;

  const layers: string[][] = [];
  let argv: string[] | null = JSON.parse(c.canon) as string[];
  for (let d = 0; argv !== null && d < MAX_UNWRAP_DEPTH; d++) {
    layers.push(argv);
    argv = unwrap(argv);
  }

  let decision: PolicyDecision | undefined;
  let reason = "";
  let exactAllow = false;
  for (const layer of layers) {
    for (const [i, rule] of rules.entries()) {
      if (rule.cwd !== undefined && rule.cwd !== cwd) continue;
      if (!patternMatches(rule.pattern, layer)) continue;
      const next = decision === undefined ? rule.decision : strictest(decision, rule.decision);
      if (next !== decision) {
        decision = next;
        reason = `execpolicy 规则 #${i}（${rule.decision}）命中：${layer.join(" ")}`;
      }
      if (rule.decision === "allow" && rule.pattern.length === layer.length) exactAllow = true;
    }
  }
  if (decision === undefined) return undefined;

  // 启发式只收紧不放宽（issue #347 ⑤）
  if (decision === "allow" && !exactAllow) {
    const outer = layers[0]!;
    if (layers.some(rmForce)) {
      return { decision: "prompt", reason: "rm 带 force/递归——allow 降级为弹卡确认" };
    }
    if (layers.length > 1) {
      return {
        decision: "prompt",
        reason: `包装命令（${outer[0]}）里的放行降级为弹卡确认——只有整条精确规则能穿透包装`,
      };
    }
  }
  return { decision, reason };
}
