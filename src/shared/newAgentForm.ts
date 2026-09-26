// newAgentForm —— 手机「新建智能体」那张抽屉的纯逻辑（#1356 A2，spec §5.5）。
// mobile/src/agent/NewAgentSheet.tsx 只画与接线。

import { DUPLICATE_AGENT_NAME } from "./agentAdmin.js";
import { agentAvatarSlot } from "./agentAvatarSlot.js";
import { pickableFaces, type PickableFace } from "./agentSettingsForm.js";
import type { FriendsResult } from "./friends.js";
import { faceCharacterAt } from "./ottoFace/index.js";
import { agentNameConflict, normalizeAgentName, validateAgentName } from "./workspaceAgents.js";
import { humanizeWorkspaceError } from "./workspaceError.js";
import type { WorkspaceSnapshot } from "./workspaces.js";

/**
 * 名字那一格此刻说什么（null = 能建）。与落库前那道闸同口径（`createAgentChecked`：先归一化
 * 再校验 → 同名 → 前缀冲突），只是现在就说出口、「创建」按不动。名单是手上这份快照——落库前
 * 那道还会现查一次，这里拦不住的并发同名由它与 23505 兜。
 */
export function newAgentNameError(raw: string, existing: readonly string[]): string | null {
  // 落库前那道闸的 noNewline（createAgentDraft.ts）在 trim 之前就检查真换行；
  // normalizeAgentName 的 trim 会把首尾换行悄悄吃掉，这里要抢在归一化之前单独挡一遍，
  // 否则「发票」后面跟一个换行会在这儿判成合法、点得动「创建」，落库那道闸却会抛错。
  if (/[\r\n]/.test(raw)) return "名字不能换行";
  const name = normalizeAgentName(raw);
  const invalid = validateAgentName(name);
  if (invalid !== null) return invalid;
  const others = existing.map(normalizeAgentName);
  if (others.includes(name)) return DUPLICATE_AGENT_NAME;
  return agentNameConflict(name, others);
}

/**
 * 抽屉打开时默认选中哪张脸：这只刚铸出来的 id 按名册派生会分到的那张（派生会避开名册里已经
 * 派生掉的坑，一墙新建出来的不至于长成同一张脸）；派生到的角色不在墙上（cap 只借住在坑 2）就取
 * 墙上第一张。落库时一律写**选中那张自己的坑位**（`PickableFace.slot`）不写 null——这一屏上看见的
 * 就是建出来的，暂借格补齐那天也不会被悄悄换脸（spec §5.4）。
 */
export function defaultPickFor(ws: WorkspaceSnapshot, agentId: string): PickableFace {
  const wall = pickableFaces();
  const derived = faceCharacterAt(agentAvatarSlot(agentId, [...ws.agents.map((a) => a.agentId), agentId])).id;
  return wall.find((f) => f.id === derived) ?? wall[0]!;
}

export interface NewAgentPorts {
  /** 落那一行（`createAgentChecked`，带 onboarding='greet'）。抛错 = 没落成，文案过一遍人话 */
  insert(input: { name: string; avatarSlot: number }): Promise<void>;
  /** 当场建它的私聊（cs 的 `create{chat:{kind:"dm"}}`；runtime 对私聊幂等，重试建不出第二条） */
  openDm(): Promise<FriendsResult<{ sessionId: string }>>;
  /** 不建了（行已落、私聊没建成）：把「先开口」那一格清掉（`clearAgentOnboarding`，只清 'greet'） */
  clearGreeting(): Promise<void>;
}

/** form = 还什么都没落；linking = 行已落、私聊还没建成；done = 两样都成了 */
export type NewAgentStep = "form" | "linking" | "done";

export interface NewAgentFlow {
  step(): NewAgentStep;
  submit(input: { name: string; avatarSlot: number }): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>;
  abandon(): Promise<void>;
}

/**
 * 建一只的两步：落行 → **当场**建私聊（不走草稿：它要先开口，得先有那条线，spec §5.5）。
 * - **行只落一次**：私聊没建成时再点「再试一次」只重试私聊——再落一次就是第二只同名的智能体，
 *   被唯一索引拦下，人看到的是一句莫名其妙的「已有同名」；
 * - 私聊没建成而人不建了（`abandon`）：把那一格清掉。留着的话，他下次从名册点进它的草稿、发出
 *   第一句，runtime 建私聊时会替他先问一句「你想让我干什么」、紧接着再答他那句——正是 spec §7.2
 *   否决「按推断先开口」的那个双答。清不掉（离线）就算了，那是 ADR-0319 记着的已知代价；
 * - 同一时刻只跑一次：连点两下拿到的是同一个结果（抽屉在跑的时候本来也锁着，这是第二道）。
 */
export function createNewAgentFlow(ports: NewAgentPorts): NewAgentFlow {
  let step: NewAgentStep = "form";
  let sessionId: string | null = null;
  let inflight: Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> | null = null;

  const run = async (input: { name: string; avatarSlot: number }): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> => {
    if (step === "done" && sessionId !== null) return { ok: true, sessionId };
    if (step === "form") {
      try {
        await ports.insert(input);
      } catch (e) {
        return { ok: false, message: humanizeWorkspaceError(e) };
      }
      step = "linking";
    }
    // openDm 也可能直接抛（不只是回 {ok:false}）：这里要接住，不然 submit() 会拒绝，
    // 破坏它自己声明的 Promise<{ok:true…}|{ok:false…}> 契约——调用方只 await 不 catch。
    let r: FriendsResult<{ sessionId: string }>;
    try {
      r = await ports.openDm();
    } catch (e) {
      return { ok: false, message: `它建好了，但还没接上线：${humanizeWorkspaceError(e)}` };
    }
    if (!r.ok) return { ok: false, message: `它建好了，但还没接上线：${r.message}` };
    step = "done";
    sessionId = r.value.sessionId;
    return { ok: true, sessionId: r.value.sessionId };
  };

  return {
    step: () => step,
    submit(input) {
      if (inflight !== null) return inflight;
      const p = run(input).finally(() => {
        inflight = null;
      });
      inflight = p;
      return p;
    },
    async abandon() {
      if (step !== "linking") return;
      await ports.clearGreeting().catch(() => undefined);
    },
  };
}
