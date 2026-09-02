// memory — 长期记忆工具。对标 hermes-agent tools/memory_tool.py：
// add/replace/remove + operations 批量；字符上限超了报错不淘汰（逼模型自己合并）；
// 连续失败 3 次后返回终态（记忆副作用永不阻塞回复）；成功不回显条目（回显会诱导
// 模型"再找点东西改"，hermes 观测到 1 次正确批量后跟 5 次重复）。
// 没有 read action：记忆只注入不读（memory_loaded 事件，见 deriveMessages）。
// 只碰 world.config——硬规则：工具不 import fs。

import type { Tool } from "./tool.js";
import type { ExecutionWorld } from "../world/executionWorld.js";
import {
  applyOps, charCount, formatEntries, formatMemoryResultLine, isMemoryTarget, parseEntries, withMemoryFileLock,
  memoryRelPath, projectMentionInGlobal, tierRuleText, topicRuleText, MEMORY_LIMITS, PROJECT_ROOT_FILE,
  type MemoryOp, type MemoryTarget, type MemoryToolResult,
} from "../shared/memoryStore.js";
import {
  MAX_TOPICS, TOPICS_DIR, isTopicSlug, renderTopicIndex, slugsFromFileNames, withSeedTopics,
} from "../shared/memoryTopics.js";
import { scanThreat } from "../shared/threatPatterns.js";

export { parseMemoryResult } from "../shared/memoryStore.js";

export const MEMORY_TOOL_NAME = "memory";
const MAX_CONSECUTIVE_FAILURES = 3;

const SHAPE_EXAMPLE =
  '单条：{"target":"memory","action":"add","content":"..."}；' +
  '批量：{"target":"memory","operations":[{"action":"add","content":"..."}]}';

/** 模型给的 operations 归一成数组。issue #591：只认数组的话，「意图明确但形状差一点」
    的调用会撞同一句错误，模型看不出该改哪儿就原样重发，三次后触发终态，整轮记忆丢光。
    宽容只在这个解析边界发生，schema 照旧只声明严格形状（继续引导模型给标准的那种）。
    认不出的形状返回 null（≠ 空数组：空数组是「给了但一条没有」，那是另一句话） */
function toOpList(v: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  // 单个对象当一条
  if (v !== null && typeof v === "object") return [v as Record<string, unknown>];
  // 多字符串化了一层（某些 OpenAI 方言的模型会把数组再 JSON.stringify 一次）
  if (typeof v === "string") {
    try {
      return toOpList(JSON.parse(v));
    } catch {
      return null;
    }
  }
  return null;
}

/** action 缺席时从字段反推：这三条不是猜，是三个 action 各自的定义——
    old_text 是「定位既有条目」，content 是「新内容」，谁在谁不在就唯一确定了动作 */
function inferAction(o: Record<string, unknown>, content: string, oldText: string): unknown {
  if (o["action"] !== undefined) return o["action"];
  if (oldText && content) return "replace";
  if (oldText) return "remove";
  if (content) return "add";
  return undefined;
}

/** 把模型给的 args 归一成 MemoryOp[]。new_text 是 content 的别名（hermes 同款） */
function parseOps(args: unknown, hasProject: boolean): {
  target: MemoryTarget; ops: MemoryOp[]; topic: string | null; createTopic: boolean;
} {
  const a = (args ?? {}) as Record<string, unknown>;
  if (!isMemoryTarget(a["target"])) throw new Error("target 必填，且只能是 memory / user / project / topic");
  const target = a["target"];
  if (target === "project" && !hasProject) {
    throw new Error("当前工作区不在任何 git 仓库里，没有项目档；写 memory、user 或 topic");
  }
  let topic: string | null = null;
  if (target === "topic") {
    if (typeof a["topic"] !== "string" || !a["topic"]) throw new Error("target 为 topic 时 topic（桶 slug）必填，见系统提示里的主题索引");
    if (!isTopicSlug(a["topic"])) throw new Error(`主题 slug 非法：「${a["topic"]}」——小写字母开头、只含 a-z 0-9 -、≤ 24 字符`);
    topic = a["topic"];
  }
  const createTopic = a["create_topic"] === true;
  const listed = a["operations"] !== undefined ? toOpList(a["operations"]) : null;
  if (a["operations"] !== undefined && listed !== null && listed.length === 0) {
    throw new Error("operations 是空数组：没有要写的就不用调用 memory，直接继续回答");
  }
  const raw: Record<string, unknown>[] = listed ?? [a];
  const ops = raw.map((o): MemoryOp => {
    const content = typeof o["content"] === "string" ? o["content"] : typeof o["new_text"] === "string" ? o["new_text"] : "";
    const oldText = typeof o["old_text"] === "string" ? o["old_text"] : "";
    switch (inferAction(o, content, oldText)) {
      case "add": return { action: "add", target, content };
      case "replace":
        if (!oldText) throw new Error("replace 需要 old_text");
        return { action: "replace", target, old_text: oldText, content };
      case "remove":
        if (!oldText) throw new Error("remove 需要 old_text");
        return { action: "remove", target, old_text: oldText };
      case undefined:
        // 既没 action 也没 content/old_text：这条什么都没说，报错带上合法示例
        throw new Error(`要么给 action（单条），要么给 operations（批量）。${SHAPE_EXAMPLE}`);
      default: throw new Error(`action 只能是 add / replace / remove，收到 ${String(o["action"])}。${SHAPE_EXAMPLE}`);
    }
  });
  return { target, ops, topic, createTopic };
}

/** project 由组装根传入（root = 项目根绝对路径，dir = 配置目录相对路径）。
    null = 这个会话的 workspace 不在任何 git 仓库里 ⇒ 不给模型看 project 这个选项：
    看不见的档就不会误写，比给它一个必然报错的选项干净 */
export function createMemoryTool(project: { root: string; dir: string } | null): Tool {
  let consecutiveFailures = 0;

  async function execute(args: unknown, world: ExecutionWorld): Promise<string> {
    if (!world.config) throw new Error("这个世界没有长期记忆能力（配置目录不可用）");
    const { target, ops, topic, createTopic } = parseOps(args, project !== null);

    if (target === "topic") {
      // 桶索引 = 种子 ∪ 磁盘。每次调用现列而不是缓存：别的会话此刻可能刚建了一个桶
      const onDisk = slugsFromFileNames(await world.config.list(TOPICS_DIR));
      const known = withSeedTopics(onDisk);
      if (!known.includes(topic!)) {
        if (!createTopic) {
          throw new Error(
            `没有「${topic}」这个桶。现有桶：\n${renderTopicIndex(known.map((s) => ({ slug: s, label: s, entries: 0 })))}\n` +
            `先确认没有相近的桶；确实要新建就带 create_topic: true 重发。`,
          );
        }
        if (known.length >= MAX_TOPICS) {
          throw new Error(`桶数已到上限 ${MAX_TOPICS}，不能再建「${topic}」——先把相近的桶合并（把条目 replace 进已有桶、清空旧桶）。`);
        }
      }
    }

    for (const op of ops) {
      if (op.action === "remove") continue;
      const hit = scanThreat(op.content);
      if (hit) throw new Error(`内容含可疑指令（${hit}），拒绝写入记忆`);
    }

    // 项目归位守卫（issue #589）：全局档条目点名当前项目 = 十有八九是项目事实投错了档。
    // 只拦 add/replace 的新内容——remove 的 old_text 是在定位既有条目，拦它会把
    // 「清理错放存量」这条路也堵死
    if (target === "memory" && project) {
      for (const op of ops) {
        if (op.action === "remove") continue;
        const mention = projectMentionInGlobal(op.content, project.root);
        if (mention) {
          throw new Error(
            `这条内容点名了当前项目（命中「${mention}」），像是只在本项目为真的事——改写 target: "project"。` +
            `确实换个项目也成立的话，把项目名/路径从内容里去掉再写：全局条目不点名具体项目。`,
          );
        }
      }
    }

    const rel = memoryRelPath(target, project?.dir, topic);
    // read→apply→write 整段持 per-file 锁（issue #185）：并发的另一次写在这段
    // 结束前进不来，读到的永远是上一次写完之后的最新视图
    const result = await withMemoryFileLock(rel, async (): Promise<MemoryToolResult> => {
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
      // 目录自描述（设置页要显示「这份记忆属于哪个项目」）。每次写都覆盖同样内容，
      // 幂等；不做存在性检查是为了不引入「先读后写」的第二条竞态路径
      if (target === "project" && project) {
        await world.config!.write(`${project.dir}/${PROJECT_ROOT_FILE}`, project.root);
      }

      return {
        ok: true, target, ...(topic ? { topic } : {}),
        added: r.changed.added, updated: r.changed.updated, removed: r.changed.removed,
        used: charCount(formatEntries(r.entries)), limit: MEMORY_LIMITS[target],
      };
    });
    const n = result.added.length + result.updated.length + result.removed.length;
    // 终态一句话，不回显条目
    const label = { memory: "MEMORY", user: "USER", project: "PROJECT", topic: `TOPIC:${result.topic ?? ""}` }[result.target];
    return `已更新 ${label}（${n} 处，${result.used}/${result.limit} 字符）。\n${formatMemoryResultLine(result)}`;
  }

  // 有无项目根决定判据文案的档数：看不见的档不需要判据，说了也是噪音。
  // 判据正文单源在 shared/memoryStore.ts 的 tierRuleText / topicRuleText（issue #589）
  const tierRule = (project ? `四档：${tierRuleText()}` : "三档：memory = 你的笔记（本机环境），user = 关于用户。") + topicRuleText();

  return {
    def: {
      name: MEMORY_TOOL_NAME,
      description:
        `维护跨会话的长期记忆。${tierRule}` +
        "记：用户偏好、环境细节、工具怪癖、稳定约定——优先记能减少用户再次纠正你的事。" +
        "不记：任务进度、PR/issue 号、commit、一周内会过期的东西（用 session_search 查）；流程归 skill。" +
        "写陈述句不写祈使句。上限按字符，超了不会自动淘汰——先 remove/replace 腾地。",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: project ? ["memory", "user", "project", "topic"] : ["memory", "user", "topic"],
            description: "写哪个文件",
          },
          action: { type: "string", enum: ["add", "replace", "remove"], description: "单条操作" },
          content: { type: "string", description: "add/replace 的新内容（别名 new_text）" },
          old_text: { type: "string", description: "replace/remove 用：目标条目里一段短且唯一的子串" },
          topic: { type: "string", description: "target 为 topic 时必填：桶的 slug（小写 kebab）。优先用系统提示主题索引里已有的桶" },
          create_topic: { type: "boolean", description: "桶不存在时要不要新建。默认 false——先看索引确认没有相近的桶" },
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
