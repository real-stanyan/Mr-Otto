// 代办的任务卡 + 抽屉（#1565，ADR-0364）在手机端的接线。判据在 shared 真跑（laneTasks.test），这里读源码钉住：
// ① 主页不再把车道逐条 merge 进时间线——每条任务一张卡（TaskCard），按开始时间与私聊合成；
// ② 两条车道各折一次，流式碎片挂在最后一条；③ 点卡开抽屉（TaskDrawer），抽屉按 key 现找、跟着车道长；
// ④ 抽屉里接着说：朋友那条只对 TA 的管理员说，我的那条对这条任务里的那几只；⑤ LaneBubble 搬成独立文件给两处共用。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("FriendChatScreen：任务卡", () => {
  const src = read("mobile/src/friends/FriendChatScreen.tsx");
  it("主页上没有车道逐条（laneItemsOf / mergePairView 不再用），只有任务卡", () => {
    expect(src).not.toMatch(/laneItemsOf\(/);
    expect(src).not.toMatch(/mergePairView\(/);
    expect(src).toMatch(/\| \{ kind: "task"; key: string; t: TaskRow \};/);
    expect(src).toMatch(/function TaskCard\(/);
    expect(src).toMatch(/item\.kind === "task" \? \(\s*<TaskCard/);
  });
  it("两条车道各折一次：laneTasksOf + lanePending 挂最后一条 + laneBusy 只标最后一条", () => {
    expect(src).toMatch(/const tasks = laneTasksOf\(events, selfUid, nameOfAgent\);\s*const pending = lanePending\(events, streaming\);\s*const last = tasks\.at\(-1\);\s*if \(pending\.length > 0 && last !== undefined\) last\.items\.push\(\.\.\.pending\);\s*const busy = laneBusy\(events\);/);
    expect(src).toMatch(/\.\.\.build\(laneEvents, laneSession !== null \? chat\.streaming : \{\}, false\),\s*\.\.\.\(peer === null \|\| peer\.session === null \? \[\] : build\(peerEvents, peer\.streaming, true\)\),/);
  });
  it("与私聊按时间合成，同一毫秒私聊在前", () => {
    expect(src).toMatch(/\.\.\.taskRows\.map\(\(t\) => \(\{ kind: "task" as const, ts: t\.task\.ts, t \}\)\),\s*\]\.sort\(\(a, b\) => a\.ts - b\.ts \|\| \(a\.kind === b\.kind \? 0 : a\.kind === "dm" \? -1 : 1\)\);/);
  });
  it("点卡开抽屉；抽屉按 key 现找；接着说走对的那条车道（朋友的只对管理员）", () => {
    expect(src).toMatch(/setOpenTaskKey\(\{ key: item\.t\.task\.key, peer: item\.t\.peer \}\);\s*setTaskDrawerOpen\(true\);/);
    expect(src).toMatch(/const openTask = openTaskKey === null \? null : taskRows\.find\(\(r\) => r\.peer === openTaskKey\.peer && r\.task\.key === openTaskKey\.key\) \?\? null;/);
    expect(src).toMatch(/\? await sayToPeerLane\(text, \[ADMIN_AGENT_ID\]\)\s*: await sendText\(text, openTask\.task\.agentIds\.length > 0 \? openTask\.task\.agentIds : brought\);/);
    expect(src).toMatch(/<TaskDrawer\s+visible=\{taskDrawerOpen\}/);
  });
  it("LaneBubble 搬成独立文件，抽屉与主页共用（主页不再自带一份）", () => {
    expect(src).not.toMatch(/^function LaneBubble\(/m);
    expect(read("mobile/src/friends/LaneBubble.tsx")).toMatch(/export function LaneBubble\(/);
    expect(read("mobile/src/friends/TaskDrawer.tsx")).toMatch(/import \{ LaneBubble \} from "\.\/LaneBubble\.js";/);
  });
});

describe("TaskDrawer", () => {
  const src = read("mobile/src/friends/TaskDrawer.tsx");
  it("底部抽屉；下发那一行底下写「下发给 X」；发不出去字留着（ok 才清）", () => {
    expect(src).toMatch(/<BottomSheet visible=\{visible\} title=\{title\}/);
    expect(src).toMatch(/footer=\{item\.handoff !== undefined \? `下发给 \$\{item\.handoff\.toAgentIds\.map\(nameOf\)\.join\("、"\)\}` : footer\}/);
    expect(src).toMatch(/const ok = await onSend\(text\);\s*setSending\(false\);\s*if \(ok\) setDraft\(""\);/);
  });
});

describe("抽屉里的键盘让位（真机 2026-10-05）", () => {
  it("TaskDrawer 自己听键盘高度、给根 View 垫底（Modal 里 KAV 量不准）；扣掉抽屉已垫的 insets.bottom", () => {
    const src = readFileSync(new URL("../../mobile/src/friends/TaskDrawer.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/Keyboard\.addListener\(Platform\.OS === "ios" \? "keyboardWillShow" : "keyboardDidShow", \(e\) => setKb\(Math\.max\(0, e\.endCoordinates\.height - insets\.bottom\)\)\)/);
    expect(src).toMatch(/<View style=\{\{ flex: 1, paddingBottom: kb \}\}>/);
  });
});
