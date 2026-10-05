// 定时汇报在 sessionService / daemon 里的接线（#1569，ADR-0366）：runReport 落 dnd_report 给管理员；那一轮受监督但 call_user 不掀；
// daemon 的调度 / 摘要 / 免打扰读的是 0062 那几列。读源码验，正则不依赖换行。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const ss = read("services/runtime/src/sessionService.ts");
const daemon = read("services/runtime/src/daemon.ts");
const events = read("src/session/events.ts");

describe("sessionService：dnd_report", () => {
  it("greeting 一族多了 dnd_report（只是记号，不进协议位）", () => {
    // #1605 之后尾巴多了 collab_accept；钉的是 dnd_report 在一族里，不钉它是最后一个；#1655 又加了 friend_relay / owner_reply
    expect(events).toMatch(/\| "routine" \| "dnd_report"(\s+\|[^;]+)*;/);
  });
  it("runReport：管理员在名单里才落；fromUid 是主人、mentions 是管理员、greeting dnd_report；名单读不出来抛错", () => {
    expect(ss).toMatch(/async runReport\(r\) \{\s*if \(archived \|\| isOutreach\) return "archived";[\s\S]{0,400}if \(!roster\.some\(\(a\) => a\.agentId === ADMIN_AGENT_ID\)\) return "no_agent";/);
    expect(ss).toMatch(/content: r\.text, fromUid: opts\.ownerUid, mentions: \[ADMIN_AGENT_ID\], greeting: "dnd_report",/);
    expect(ss).toMatch(/throw new Error\("智能体名单读不出来，这次先不汇报"\)/);
  });
  it("汇报轮受监督（tightenSupervision / applyTraits 都认），但 call_user 不掀；旗与别的旗一起复位", () => {
    expect(ss).toMatch(/e\.greeting === "outreach_report" \|\| e\.greeting === "pair_call_summary" \|\| e\.greeting === "dnd_report"/);
    expect(ss).toMatch(/if \(e\.greeting === "dnd_report"\) ownerReportTurn = true;/);
    expect(ss).toMatch(/ownerReportTurn = ownerReportTurn \|\| t\.ownerReport;/);
    expect(ss).toMatch(/t\.def\.name !== MESSAGE_FRIEND_AGENT_TOOL_NAME && !\(ownerReportTurn && t\.def\.name === CALL_USER_TOOL_NAME\)/);
    expect(ss).toMatch(/reportTurn = false;\s*ownerReportTurn = false;\s*routineTurn = false;/);
  });
});

describe("daemon：免打扰与汇报", () => {
  it("推送经过免打扰：notifier 接了 createSupabaseQuietStore", () => {
    expect(daemon).toMatch(/createNotifier\(\{ store: createSupabaseNotifyStore\(supabase\), quiet: createSupabaseQuietStore\(supabase\)\.quietOf,/);
  });
  it("调度：到点的行按 report_next_at 查、认领用 update … where report_next_at = 读到的那个值、42703 当没人开", () => {
    expect(daemon).toMatch(/\.not\("report", "is", null\)\s*\.or\(`report_next_at\.is\.null,report_next_at\.lte\.\$\{new Date\(nowMs\)\.toISOString\(\)\}`\)/);
    expect(daemon).toMatch(/\.eq\("uid", uid\)\.eq\("report_next_at", new Date\(expected\)\.toISOString\(\)\)\.select\("uid"\)/);
    expect(daemon).toMatch(/if \(String\(res\.error\.code\) === "42703"\) return \[\];/);
    expect(daemon).toMatch(/reportScheduler\.start\(\);/);
  });
  it("摘要：朋友消息按 recipient + created_at > since 查、过 dmPreview；任务只取公开车道里朋友点起的；进管理员的私聊房 runReport", () => {
    expect(daemon).toMatch(/\.from\("messages"\)\.select\("sender,body,created_at"\)\.eq\("recipient", r\.uid\)\.gt\("created_at", new Date\(r\.since\)\.toISOString\(\)\)/);
    expect(daemon).toMatch(/text: dmPreview\(m\.body\)/);
    expect(daemon).toMatch(/\.eq\("chat_kind", "pair"\)\.eq\("facing", "both"\)/);
    expect(daemon).toMatch(/if \(t\.startedBy === "friend" && t\.ts > r\.since\) tasks\.push/);
    expect(daemon).toMatch(/const sid = await findDmSession\(home, \[ADMIN_AGENT_ID\]\);[\s\S]{0,300}const room = await routineRooms\.room\(home, sid\);/);
    expect(daemon).toMatch(/await room\.runReport\(\{ text, firedAt: r\.firedAt \}\)/);
  });
});
