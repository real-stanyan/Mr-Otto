// agentAvatarSlot 纯逻辑：稳定（同 id 同脸）、管理员固定、撞脸顺延、超员回天然坑位、
// 不在名单的也有脸（#971，ADR-0229）。另一条断言钉住图片清单长度与坑位数一致——
// 少放一张 png，坑位 12 会 undefined 而不是报错。

import { describe, expect, it } from "vitest";
import {
  ADMIN_AVATAR_SLOT, AGENT_AVATAR_COUNT, agentAvatarSlot, agentAvatarSlots,
} from "../../src/renderer/src/lib/agentAvatarSlot.js";
import { AGENT_AVATARS } from "../../src/renderer/src/lib/agentAvatar.js";
import { ADMIN_AGENT_ID } from "../../src/shared/workspaceAgents.js";

describe("agentAvatarSlots", () => {
  it("管理员固定一张；其余按 agent_id 哈希、落在 0..COUNT-1", () => {
    const slots = agentAvatarSlots([ADMIN_AGENT_ID, "a_1", "a_2"]);
    expect(slots.get(ADMIN_AGENT_ID)).toBe(ADMIN_AVATAR_SLOT);
    for (const v of slots.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(AGENT_AVATAR_COUNT);
    }
  });

  it("稳定：同一份名单算两次、换台机器算，同一只 agent 同一张脸", () => {
    const a = agentAvatarSlots([ADMIN_AGENT_ID, "a_1", "a_2", "a_3"]);
    const b = agentAvatarSlots([ADMIN_AGENT_ID, "a_1", "a_2", "a_3"]);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("名单里 13 只以内两两不同脸（撞上就往后挪）", () => {
    const roster = [ADMIN_AGENT_ID, ...Array.from({ length: 12 }, (_, i) => `agent_${i}`)];
    const slots = agentAvatarSlots(roster);
    expect(new Set(slots.values()).size).toBe(roster.length);
  });

  it("先来的先占坑：改名单顺序，天然坑位没撞的那只不受影响", () => {
    // 找两只天然坑位不同的 agent，顺序调换后各自坑位不变
    const [x, y] = ["agent_a", "agent_b"];
    const s1 = agentAvatarSlot(x, [x]);
    const s2 = agentAvatarSlot(y, [y]);
    if (s1 === s2) return; // 恰好撞上的话这条没意义（换 id 会更好，但纯函数的哈希值不该硬编进测试）
    expect(agentAvatarSlots([x, y]).get(x)).toBe(s1);
    expect(agentAvatarSlots([y, x]).get(x)).toBe(s1);
    expect(agentAvatarSlots([y, x]).get(y)).toBe(s2);
  });

  it("超过张数：重复不可避免，但每只仍回自己的天然坑位（稳定优先于唯一）", () => {
    const roster = Array.from({ length: AGENT_AVATAR_COUNT + 3 }, (_, i) => `agent_${i}`);
    const slots = agentAvatarSlots(roster);
    for (const id of roster.slice(AGENT_AVATAR_COUNT)) {
      expect(slots.get(id)).toBe(agentAvatarSlot(id, []));
    }
  });

  it("名单里重复的 id 只占一个坑", () => {
    expect(agentAvatarSlots(["a", "a", "a"]).size).toBe(1);
  });
});

describe("agentAvatarSlot", () => {
  it("不在名单里（被删的 agent 在旧消息上）也有脸：回天然坑位", () => {
    const slot = agentAvatarSlot("gone", ["a_1"]);
    expect(slot).toBe(agentAvatarSlot("gone", []));
  });
});

describe("AGENT_AVATARS", () => {
  it("图片张数与坑位数一致", () => {
    expect(AGENT_AVATARS).toHaveLength(AGENT_AVATAR_COUNT);
    for (const src of AGENT_AVATARS) expect(typeof src).toBe("string");
  });
});
