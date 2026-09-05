// workspaceMemoryTool —— 云侧的 memory 工具（#949，spec §6.1）。形状对齐 src/tools/memory.ts
// （add/replace/remove + operations 批量、超限报错不淘汰、连续失败 3 次回终态、成功不回显条目），
// 差别只有三处：档位是 shared/own（云侧自己的枚举，不动 MemoryTarget）；落点是注入的
// WorkspaceMemoryStore 而不是 world.config；shared 档的写入路径拼写入者前缀（spec §6.2）。
// 不 import fs / supabase：硬规则「工具只依赖接口」在这把刀上体现为「只依赖 WorkspaceMemoryStore」。

import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { toOpList, inferAction } from "../../../src/tools/memory.js";
import {
  applyEntryOps, charCount, formatEntries, parseEntries, withMemoryFileLock, type EntryOp,
} from "../../../src/shared/memoryStore.js";
import {
  SHARED_MEMORY_AGENT_ID, WORKSPACE_MEMORY_LABEL, WORKSPACE_MEMORY_LIMITS, collapseSharedEntry, isWorkspaceMemoryTier,
  withWriterPrefix, workspaceMemoryLockKey, workspaceTierRuleText, type WorkspaceMemoryTier,
} from "../../../src/shared/workspaceMemory.js";
import { scanThreat } from "../../../src/shared/threatPatterns.js";
import { MemoryConflictError, type WorkspaceMemoryStore } from "./workspaceMemory.js";

export const WORKSPACE_MEMORY_TOOL_NAME = "memory";
const MAX_CONSECUTIVE_FAILURES = 3;
const SHAPE_EXAMPLE =
  '单条：{"target":"shared","action":"add","content":"..."}；' +
  '批量：{"target":"own","operations":[{"action":"add","content":"..."}]}';

function parseOps(args: unknown): { tier: WorkspaceMemoryTier; ops: EntryOp[] } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (!isWorkspaceMemoryTier(a["target"])) throw new Error("target 必填，且只能是 shared / own");
  const tier = a["target"];
  const listed = a["operations"] !== undefined ? toOpList(a["operations"]) : null;
  if (a["operations"] !== undefined && listed !== null && listed.length === 0) {
    throw new Error("operations 是空数组：没有要写的就不用调用 memory，直接继续回答");
  }
  const raw: Record<string, unknown>[] = listed ?? [a];
  const ops = raw.map((o): EntryOp => {
    const content = typeof o["content"] === "string" ? o["content"] : typeof o["new_text"] === "string" ? o["new_text"] : "";
    const oldText = typeof o["old_text"] === "string" ? o["old_text"] : "";
    switch (inferAction(o, content, oldText)) {
      case "add": return { action: "add", content };
      case "replace":
        if (!oldText) throw new Error("replace 需要 old_text");
        return { action: "replace", old_text: oldText, content };
      case "remove":
        if (!oldText) throw new Error("remove 需要 old_text");
        return { action: "remove", old_text: oldText };
      case undefined:
        throw new Error(`要么给 action（单条），要么给 operations（批量）。${SHAPE_EXAMPLE}`);
      default: throw new Error(`action 只能是 add / replace / remove，收到 ${String(o["action"])}。${SHAPE_EXAMPLE}`);
    }
  });
  return { tier, ops };
}

export function createWorkspaceMemoryTool(deps: {
  workspaceId: string;
  agentId: string;
  agentName: () => string;
  memory: WorkspaceMemoryStore;
}): Tool {
  let consecutiveFailures = 0;

  async function execute(args: unknown): Promise<string> {
    const { tier, ops } = parseOps(args);
    // 扫描跑在原文（未加写入者前缀）上：agent 名字不是外部输入，它经花名册/briefing
    // 那条路才到得了每个 prompt（spec §4），且只有工作区成员能改自己 agent 的名字——
    // 前缀里混不进模型没见过、扫描器该拦的可疑指令，晚一步（stamped 之后）扫不会多拦
    // 任何东西，纯属多余
    for (const op of ops) {
      if (op.action === "remove") continue;
      const hit = scanThreat(op.content);
      if (hit) throw new Error(`内容含可疑指令（${hit}），拒绝写入记忆`);
    }
    // 共享档每条带写入者前缀（spec §6.2）：由写入路径拼，不靠模型自觉。折行（B-I3，#957）
    // 必须排在打前缀之前——原文一旦带上换行，`\n[某某] ...` 就是一条伪造的第二行签名，
    // collapseSharedEntry 把整段折成单行之后前缀天然只出现一次。
    // 空内容不打前缀——否则 {action:"replace", content:""} 会在这一步先变成非空的 "[写入者] "，
    // applyEntryOps 的空内容闸就再也拦不住它，一次空 replace 就能把真实条目覆盖成裸的写入者名字
    // （#949 review：confirmed by running it）。落一个空字符串，让 applyEntryOps 自己报「content 为空」。
    const stamped: EntryOp[] = tier === "shared"
      ? ops.map((op) =>
          op.action === "remove" || !op.content.trim()
            ? op
            : { ...op, content: withWriterPrefix(deps.agentName(), collapseSharedEntry(op.content.trim())) }
        )
      : ops;
    const rowAgentId = tier === "shared" ? SHARED_MEMORY_AGENT_ID : deps.agentId;
    const lockKey = workspaceMemoryLockKey(deps.workspaceId, rowAgentId);

    // 一次 read→apply→write 尝试：expected 就是这次持锁期间读到的原文（缺行 = null），
    // 与 memory.write 的写入前置条件（B-I4）直接对应
    async function attempt(): Promise<{ used: number; n: number }> {
      const raw = (await deps.memory.read(deps.workspaceId, [rowAgentId])).get(rowAgentId) ?? null;
      const entries = parseEntries(raw);
      const needsLocate = stamped.some((o) => o.action !== "add");
      if (needsLocate && raw !== null && formatEntries(entries) !== raw) {
        throw new Error(`${WORKSPACE_MEMORY_LABEL[tier]} 的内容与解析结果不一致（可能被手编过），拒绝按旧视图改写。先在设置页整理一次`);
      }
      const r = applyEntryOps(entries, stamped, { label: WORKSPACE_MEMORY_LABEL[tier], limit: WORKSPACE_MEMORY_LIMITS[tier] });
      if (!r.ok) throw new Error(r.error);
      const nextRaw = formatEntries(r.entries);
      await deps.memory.write(deps.workspaceId, rowAgentId, nextRaw, raw);
      return { used: charCount(nextRaw), n: r.changed.added.length + r.changed.updated.length + r.changed.removed.length };
    }

    // read→apply→write 整段持锁（issue #185 同款）：同一 daemon 里另一条云会话此刻可能也在写
    // 共享档——锁挡得住这一层，挡不住桌面手改或另一台 daemon（B-I4），所以锁内还要过一遍
    // memory.write 的前置条件；撞了就在锁内重试整段一次，两次都撞才真的报给模型
    const { used, n } = await withMemoryFileLock(lockKey, async () => {
      try {
        return await attempt();
      } catch (err) {
        if (!(err instanceof MemoryConflictError)) throw err;
        try {
          return await attempt();
        } catch (err2) {
          if (err2 instanceof MemoryConflictError) throw new Error("记忆刚被别人改了，重试一次仍冲突");
          throw err2;
        }
      }
    });
    return `已更新 ${WORKSPACE_MEMORY_LABEL[tier]}（${n} 处，${used}/${WORKSPACE_MEMORY_LIMITS[tier]} 字符）。`;
  }

  return {
    def: {
      name: WORKSPACE_MEMORY_TOOL_NAME,
      description:
        `维护这个工作区的长期记忆。两档：${workspaceTierRuleText()}` +
        "记：业务口径、数据定义、客户约定、稳定的分工、工具怪癖——优先记能减少同事再次纠正你的事。" +
        "不记：任务进度、一周内会过期的东西。写陈述句不写祈使句。上限按字符，超了不会自动淘汰——先 remove/replace 腾地。",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["shared", "own"], description: "写哪一档" },
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
    async run(args: unknown, _world: ExecutionWorld) {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const n = consecutiveFailures;
        consecutiveFailures = 0;
        return `memory 连续失败 ${n} 次，本轮放弃，不再重试。继续回答；下一轮再整理记忆。`;
      }
      try {
        const out = await execute(args);
        consecutiveFailures = 0;
        return out;
      } catch (err) {
        consecutiveFailures++;
        throw err;
      }
    },
  };
}
