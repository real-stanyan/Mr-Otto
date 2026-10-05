// 定时任务的三把刀（#1283，spec §7）：schedule_task / list_schedules / update_schedule。
// 只依赖注入的 RoutineStore（硬规则「工具只依赖接口」）：不知道 supabase、不知道表名。
// 都不过审批门（同 wikiTool 的「记忆写入」口径）；亮不亮由 sessionService 注入的 available 决定
// （主人亲口的轮 && 不受监督 && 私聊里）——群里一句「每天提醒大家」不该建到某只名下。
// 时间怎么算：模型只给墙上时间（"09:00" / "2026-10-05T15:00"），绝对时刻由这里按 tz 算并回显；
// 相对时间（「今天下午三点」）由模型按开场白 / 系统提示里的「现在是 / 今天是」换算成墙上时间。
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import {
  formatInTz, isIanaTimeZone, LIST_SCHEDULES_TOOL_NAME, nextRunAt, parseRoutineSchedule, routineErrors, ROUTINES_ENABLED_MAX,
  ROUTINE_INSTRUCTION_MAX, ROUTINE_TITLE_MAX, SCHEDULE_TASK_TOOL_NAME, scheduleText, UPDATE_SCHEDULE_TOOL_NAME, type RoutineRow, type RoutineSchedule,
} from "../../../src/shared/routines.js";
import type { RoutineStore } from "./routineStore.js";

export interface RoutineToolDeps {
  workspaceId: string;
  agentId: string;
  ownerUid: string;
  store: RoutineStore;
  now: () => number;
  /** 此刻亮不亮（sessionService 给：主人亲口的轮 && 不受监督） */
  available: () => boolean;
  /** 群座位里定的（#1682）：到点回这条会话跑，不回私聊。缺席 = 私聊 */
  sessionId?: string;
}

const SCHEDULE_SCHEMA = {
  type: "object",
  description:
    "四种形状之一：{kind:'once', at:'YYYY-MM-DDTHH:mm'}（一次性，墙上时间）/ {kind:'daily', time:'HH:mm'} / {kind:'weekly', days:[1..7], time:'HH:mm'}（1 = 周一 … 7 = 周日）" +
    " / {kind:'every', minutes:N, from:'HH:mm', to:'HH:mm', days?:[1..7]}（时段内每隔 N 分钟，N 在 5..720，不跨夜，days 不传 = 每天）" +
    " / {kind:'monthly', days:[1..31], time:'HH:mm'}（每月几号；那个月没有这一天就落在月底，31 = 每月月底）。" +
    "「每月 1 号交房租」「每月 15 号还信用卡」用 monthly，别用一次性的凑。" +
    "「营业时间里每 10 分钟看一次」这种用一条 every，别拆成很多条 daily。",
  properties: {
    kind: { type: "string", enum: ["once", "daily", "weekly", "every", "monthly"] },
    at: { type: "string" }, time: { type: "string" }, days: { type: "array", items: { type: "integer" } },
    minutes: { type: "integer" }, from: { type: "string" }, to: { type: "string" },
  },
  required: ["kind"],
};

const nextText = (r: RoutineRow): string => (r.nextRunAt === null ? "没有下一次" : `下次执行：${formatInTz(r.nextRunAt, r.tz)}`);
const lineOf = (r: RoutineRow): string =>
  `- [${r.id}]「${r.title}」${scheduleText(r.schedule, r.tz)}；${r.enabled ? "启用中" : "已停用"}；${nextText(r)}` +
  (r.lastStatus !== null ? `；上次：${r.lastStatus}` : "") + `\n  任务：${r.instruction}`;

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null) throw new Error("参数要是一个对象");
  return args as Record<string, unknown>;
}

export function createRoutineTools(deps: RoutineToolDeps): Tool[] {
  const resolveTz = async (given: unknown): Promise<string> => {
    if (given !== undefined) {
      if (!isIanaTimeZone(given)) throw new Error("tz 要是 IANA 时区名（比如 Asia/Shanghai、Australia/Sydney）");
      return given;
    }
    const own = await deps.store.ownerTimezone(deps.ownerUid);
    if (own === null) throw new Error("还不知道他在哪个时区：先问他在哪个城市，换成 IANA 时区名用 tz 传进来");
    return own;
  };
  const mine = async (id: unknown): Promise<RoutineRow> => {
    if (typeof id !== "string" || id === "") throw new Error("要带 id（先用 list_schedules 看）");
    const r = await deps.store.get(id);
    if (!r || r.ownerUid !== deps.ownerUid || r.workspaceId !== deps.workspaceId || r.agentId !== deps.agentId) throw new Error("没有这条定时任务（先用 list_schedules 看）");
    return r;
  };

  const schedule: Tool = {
    def: {
      name: SCHEDULE_TASK_TOOL_NAME,
      // 「你能定时」放最前（#1561）：team wiki 里早先记过「没有定时能力」的工作区，模型信那条不信工具表
      description:
        "你能定时：用户要你到点提醒 / 到点做某事时用它，不要叫用户到点再来喊你。" +
        "给自己记一条定时任务：到点我会在这条私聊里收到一句「定时任务到点」，然后按任务去做。" +
        "一次性的（kind once）跑完就自动停用；每天 / 每周几 / 每月几号的（daily / weekly / monthly）长期有效。" +
        "时间写**墙上时间**，不带时区；tz 不传 = 主人设备的时区。人说的是相对时间（「今天下午三点」「明早」）就按对话里的「现在是 / 今天是」换算。" +
        "**任务里要打给好友的，先问清好友在哪个城市，换成 IANA 时区名用 tz 传进来；没问到别建。**" +
        "建好之后用人话复述一遍「下次执行」的时间给用户确认。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: `一句话标题，≤ ${ROUTINE_TITLE_MAX} 字` },
          instruction: { type: "string", description: `到点要做什么，用户的原话，≤ ${ROUTINE_INSTRUCTION_MAX} 字` },
          schedule: SCHEDULE_SCHEMA,
          tz: { type: "string", description: "IANA 时区名；不传 = 主人的设备时区" },
        },
        required: ["title", "instruction", "schedule"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    available: deps.available,
    async run(args: unknown, _world: ExecutionWorld) {
      const a = asRecord(args);
      const tz = await resolveTz(a.tz);
      const title = String(a.title ?? "").trim();
      const instruction = String(a.instruction ?? "").trim();
      const err = routineErrors({ title, instruction, schedule: a.schedule, tz });
      if (err !== null) throw new Error(err);
      const sched: RoutineSchedule = parseRoutineSchedule(a.schedule);
      const next = nextRunAt(sched, tz, deps.now());
      if (next === null) throw new Error("这个时刻已经过了，换一个将来的时间");
      const enabled = (await deps.store.list(deps.workspaceId, deps.agentId)).filter((r) => r.enabled).length;
      if (enabled >= ROUTINES_ENABLED_MAX) throw new Error(`启用中的定时任务已经有 ${ROUTINES_ENABLED_MAX} 条了，先停掉或删掉几条`);
      const row = await deps.store.insert({ workspaceId: deps.workspaceId, agentId: deps.agentId, ownerUid: deps.ownerUid, title, instruction, schedule: sched, tz, createdBy: "agent", nextRunAt: next, ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}) });
      return `已记下「${row.title}」（id ${row.id}）：${scheduleText(row.schedule, row.tz)}。${nextText(row)}。请用人话、用用户说话的语言复述给用户确认。`;
    },
  };

  const list: Tool = {
    def: { name: LIST_SCHEDULES_TOOL_NAME, description: "看我名下的全部定时任务（id、标题、形状、下次执行、启用否）。要改 / 停 / 删之前先用它拿 id。", parameters: { type: "object", properties: {} } },
    exposure: "direct",
    requiresApproval: false,
    parallelSafe: true,
    available: deps.available,
    async run() {
      const rows = await deps.store.list(deps.workspaceId, deps.agentId);
      return rows.length === 0 ? "我名下还没有定时任务。" : `我名下的定时任务：\n${rows.map(lineOf).join("\n")}`;
    },
  };

  const update: Tool = {
    def: {
      name: UPDATE_SCHEDULE_TOOL_NAME,
      description: "改一条定时任务：patch 里给要改的字段（title / instruction / schedule / tz），enabled 停用或启用，delete:true 删掉。改完复述新的「下次执行」。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          patch: { type: "object", properties: { title: { type: "string" }, instruction: { type: "string" }, schedule: SCHEDULE_SCHEMA, tz: { type: "string" } } },
          enabled: { type: "boolean" },
          delete: { type: "boolean" },
        },
        required: ["id"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    available: deps.available,
    async run(args: unknown, _world: ExecutionWorld) {
      const a = asRecord(args);
      const r = await mine(a.id);
      if (a.delete === true) {
        await deps.store.remove(r.id, deps.ownerUid);
        return `已删除「${r.title}」。`;
      }
      const p = typeof a.patch === "object" && a.patch !== null ? (a.patch as Record<string, unknown>) : {};
      const title = p.title !== undefined ? String(p.title).trim() : r.title;
      const instruction = p.instruction !== undefined ? String(p.instruction).trim() : r.instruction;
      const tz = p.tz !== undefined ? await resolveTz(p.tz) : r.tz;
      const scheduleRaw = p.schedule !== undefined ? p.schedule : r.schedule;
      const err = routineErrors({ title, instruction, schedule: scheduleRaw, tz });
      if (err !== null) throw new Error(err);
      const sched = parseRoutineSchedule(scheduleRaw);
      const enabled = typeof a.enabled === "boolean" ? a.enabled : r.enabled;
      const next = enabled ? nextRunAt(sched, tz, deps.now()) : null;
      if (enabled && next === null) throw new Error("这个时刻已经过了，换一个将来的时间");
      if (enabled && !r.enabled) {
        const n = (await deps.store.list(deps.workspaceId, deps.agentId)).filter((x) => x.enabled && x.id !== r.id).length;
        if (n >= ROUTINES_ENABLED_MAX) throw new Error(`启用中的定时任务已经有 ${ROUTINES_ENABLED_MAX} 条了，先停掉或删掉几条`);
      }
      const row = await deps.store.update(r.id, deps.ownerUid, { title, instruction, schedule: sched, tz, enabled, nextRunAt: next });
      if (!row) throw new Error("没有这条定时任务（先用 list_schedules 看）");
      return `已更新「${row.title}」：${scheduleText(row.schedule, row.tz)}；${row.enabled ? "启用中" : "已停用"}。${nextText(row)}。`;
    },
  };

  return [schedule, list, update];
}
