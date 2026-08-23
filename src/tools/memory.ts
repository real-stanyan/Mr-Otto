// memory — 长期记忆工具。对标 hermes-agent tools/memory_tool.py：
// add/replace/remove + operations 批量；字符上限超了报错不淘汰（逼模型自己合并）；
// 连续失败 3 次后返回终态（记忆副作用永不阻塞回复）；成功不回显条目（回显会诱导
// 模型"再找点东西改"，hermes 观测到 1 次正确批量后跟 5 次重复）。
// 没有 read action：记忆只注入不读（memory_loaded 事件，见 deriveMessages）。
// 只碰 world.config——硬规则：工具不 import fs。

import type { Tool } from "./tool.js";
import type { ExecutionWorld } from "../world/executionWorld.js";
import {
  applyOps, charCount, formatEntries, parseEntries, withMemoryFileLock,
  MEMORY_FILES, MEMORY_LIMITS, MEMORY_RESULT_MARK,
  type MemoryOp, type MemoryTarget, type MemoryToolResult,
} from "../shared/memoryStore.js";
import { scanThreat } from "../shared/threatPatterns.js";

export { parseMemoryResult } from "../shared/memoryStore.js";

export const MEMORY_TOOL_NAME = "memory";
const MAX_CONSECUTIVE_FAILURES = 3;

function isTarget(v: unknown): v is MemoryTarget {
  return v === "memory" || v === "user";
}

/** 把模型给的 args 归一成 MemoryOp[]。new_text 是 content 的别名（hermes 同款） */
function parseOps(args: unknown): { target: MemoryTarget; ops: MemoryOp[] } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (!isTarget(a["target"])) throw new Error("target 必填，且只能是 memory 或 user");
  const target = a["target"];
  const raw: Record<string, unknown>[] = Array.isArray(a["operations"])
    ? (a["operations"] as Record<string, unknown>[])
    : a["action"] !== undefined
      ? [a]
      : [];
  if (raw.length === 0) throw new Error("要么给 action（单条），要么给 operations（批量）");
  const ops = raw.map((o): MemoryOp => {
    const content = typeof o["content"] === "string" ? o["content"] : typeof o["new_text"] === "string" ? o["new_text"] : "";
    const oldText = typeof o["old_text"] === "string" ? o["old_text"] : "";
    switch (o["action"]) {
      case "add": return { action: "add", target, content };
      case "replace":
        if (!oldText) throw new Error("replace 需要 old_text");
        return { action: "replace", target, old_text: oldText, content };
      case "remove":
        if (!oldText) throw new Error("remove 需要 old_text");
        return { action: "remove", target, old_text: oldText };
      default: throw new Error(`action 只能是 add / replace / remove，收到 ${String(o["action"])}`);
    }
  });
  return { target, ops };
}

export function createMemoryTool(): Tool {
  let consecutiveFailures = 0;

  async function execute(args: unknown, world: ExecutionWorld): Promise<string> {
    if (!world.config) throw new Error("这个世界没有长期记忆能力（配置目录不可用）");
    const { target, ops } = parseOps(args);

    for (const op of ops) {
      if (op.action === "remove") continue;
      const hit = scanThreat(op.content);
      if (hit) throw new Error(`内容含可疑指令（${hit}），拒绝写入记忆`);
    }

    const rel = MEMORY_FILES[target];
    // read→apply→write 整段持 per-target 锁（issue #185）：并发的另一次写在这段
    // 结束前进不来，读到的永远是上一次写完之后的最新视图
    const result = await withMemoryFileLock(target, async (): Promise<MemoryToolResult> => {
      let raw: string | null;
      try {
        raw = await world.config!.read(rel);
      } catch (err) {
        throw new Error(`${rel} 存在但读不了（${err instanceof Error ? err.message : String(err)}），拒绝改写以免清空`);
      }
      const entries = parseEntries(raw);

      // 漂移守卫（hermes #26045）：replace/remove 依赖"我看到的条目"去定位，
      // 磁盘上的文本若不能 round-trip（重复、多余空白），我的视图就不是真的那份——
      // 拿它去改写会把人手编的内容悄悄归一化掉。add 不定位，不受此限
      const needsLocate = ops.some((o) => o.action !== "add");
      if (needsLocate && raw !== null && formatEntries(entries) !== raw) {
        throw new Error(`${rel} 的内容与解析结果不一致（可能被手编过、有重复或多余空白），拒绝按旧视图改写。先在设置页整理一次`);
      }

      const r = applyOps(target, entries, ops);
      if (!r.ok) throw new Error(r.error);
      await world.config!.write(rel, formatEntries(r.entries));

      return {
        ok: true, target,
        added: r.changed.added, updated: r.changed.updated, removed: r.changed.removed,
        used: charCount(formatEntries(r.entries)), limit: MEMORY_LIMITS[target],
      };
    });
    const n = result.added.length + result.updated.length + result.removed.length;
    // 终态一句话，不回显条目
    return `已更新 ${target === "memory" ? "MEMORY" : "USER"}（${n} 处，${result.used}/${result.limit} 字符）。\n${MEMORY_RESULT_MARK}${JSON.stringify(result)}-->`;
  }

  return {
    def: {
      name: MEMORY_TOOL_NAME,
      description:
        "维护跨会话的长期记忆（MEMORY = 你的笔记，USER = 关于用户）。" +
        "记：用户偏好、环境细节、工具怪癖、稳定约定——优先记能减少用户再次纠正你的事。" +
        "不记：任务进度、PR/issue 号、commit、一周内会过期的东西（用 session_search 查）；流程归 skill。" +
        "写陈述句不写祈使句。上限按字符，超了不会自动淘汰——先 remove/replace 腾地。",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["memory", "user"], description: "写哪个文件" },
          action: { type: "string", enum: ["add", "replace", "remove"], description: "单条操作" },
          content: { type: "string", description: "add/replace 的新内容（别名 new_text）" },
          old_text: { type: "string", description: "replace/remove 用：目标条目里一段短且唯一的子串" },
          operations: {
            type: "array",
            description: "批量原子操作；每项 {action, content?, old_text?}。上限只在整批结果上校验",
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["add", "replace", "remove"] },
                content: { type: "string" },
                old_text: { type: "string" },
              },
              required: ["action"],
            },
          },
        },
        required: ["target"],
      },
    },
    requiresApproval: false,
    async run(args, world) {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // 终态：不抛，且当场清零。这一条是"本轮放弃"的一次性通知，不是永久锁死——
        // 锁死的话下一次哪怕参数改对了也永远只会收到这句话，模型再也没机会恢复
        const n = consecutiveFailures;
        consecutiveFailures = 0;
        return `memory 连续失败 ${n} 次，本轮放弃，不再重试。继续回答用户；下次会话再整理记忆。`;
      }
      try {
        const out = await execute(args, world);
        consecutiveFailures = 0;
        return out;
      } catch (err) {
        consecutiveFailures++;
        throw err;
      }
    },
  };
}
