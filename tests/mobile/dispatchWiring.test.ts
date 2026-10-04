// 长按消息派智能体的手机接线（#1505，ADR-0352）。读源码钉住：
// ① 三种能引用的行（我 / 别人 / 智能体）都挂 onLongPress，缺席时 Pressable 关着；
// ② 两张聊天页长按 → DispatchDialog → push 一张那只的私聊页，开场白经路由参数 dispatch 带过去；
// ③ 聊天页收到 dispatch 参数后只发一次、走 onSend（私聊没建就建）；
// ④ 朋友私聊里按好友权限给（≥ 可带智能体）；云会话里外联会话不给。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("Bubbles", () => {
  const src = read("mobile/src/chat/Bubbles.tsx");
  it("MessageRow 的气泡列是个 Pressable，只在给了 onLongPress 时开", () => {
    expect(src).toMatch(/disabled=\{onLongPress === undefined\}\s*onLongPress=\{onLongPress\}\s*delayLongPress=\{350\}/);
  });
  it("mine / human / agent 三种行都把 row 递给 onLongPress", () => {
    expect(src.match(/\{\.\.\.\(onLongPress !== undefined \? \{ onLongPress: \(\) => onLongPress\(row\) \} : \{\}\)\}/g)?.length).toBe(3);
  });
});

describe("ChatScreen", () => {
  const src = read("mobile/src/chat/ChatScreen.tsx");
  it("长按只在主场有智能体、不是外联时给；派出去 = push 那只的私聊，开场白是 dispatchOpening", () => {
    expect(src).toMatch(/home\.home !== null && home\.home\.agents\.length > 0 && !isOutreach/);
    expect(src).toMatch(/navigation\.push\("Chat", \{ kind: "agent", agentId, dispatch: dispatchOpening\(\{ prompt, source: title, lines \}\) \}\)/);
    expect(src).toMatch(/quoteWindow\(quoteLinesFromRows\(rows, me\.name\), dispatching\.row\.key\)/);
  });
  it("收到 dispatch 参数：能发了就发一次，走 onSend", () => {
    expect(src).toMatch(/const text = route\.params\.dispatch;\s*if \(text === undefined \|\| dispatched\.current \|\| !canSend \|\| ws === null \|\| resolved === null\) return;\s*dispatched\.current = true;\s*void onSend\(text\);/);
  });
});

describe("FriendChatScreen", () => {
  const src = read("mobile/src/friends/FriendChatScreen.tsx");
  it("长按按好友权限给（≥ 可带智能体）", () => {
    expect(src).toMatch(/homeWs !== null && homeWs\.agents\.length > 0 && \(row === null \|\| allowsPair\(row\.tiers\.effective\)\)\s*\? \{ onLongPress/);
  });
  it("引用来自私聊的消息列表：谁说的按 sender 判，纯媒体消息带占位", () => {
    expect(src).toMatch(/who: m\.sender === uid \? name : me\.name/);
    expect(src).toMatch(/mediaBodyHidden\(m\.body, m\.media\) \? mediaPlaceholder\(m\.media\) : m\.body/);
    expect(src).toMatch(/source: `和\$\{name\}的私聊`/);
  });
});

describe("路由", () => {
  it("Chat 路由多一格可选的 dispatch", () => {
    expect(read("mobile/src/nav/types.ts")).toMatch(/answerRing\?: \{ ringId: string; agentId: string \}; dispatch\?: string \}/);
  });
});
