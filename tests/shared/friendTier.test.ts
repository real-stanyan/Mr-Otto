// 好友三档权限的纯判据（#1494，ADR-0350）：每人一边、生效取最小值；两道闸的那句话；0054 的策略文本。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIER, REQUEST_DEFAULT_TIER, allowsOutreach, allowsPair, effectiveTier, myTierColumn, normalizeTier,
  outreachTierProblem, pairTierProblem, tiersOf,
} from "../../src/shared/friendTier.js";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("friendTier", () => {
  it("生效取两边的最小值", () => {
    expect(effectiveTier("full", "chat")).toBe("chat");
    expect(effectiveTier("agents", "full")).toBe("agents");
    expect(effectiveTier("full", "full")).toBe("full");
  });
  it("带智能体 ≥ agents；来电 = full", () => {
    expect(allowsPair("chat")).toBe(false);
    expect(allowsPair("agents")).toBe(true);
    expect(allowsPair("full")).toBe(true);
    expect(allowsOutreach("agents")).toBe(false);
    expect(allowsOutreach("full")).toBe(true);
  });
  it("老行 / 脏值按默认档 agents；新请求的默认选项是 chat", () => {
    expect(normalizeTier(undefined)).toBe("agents");
    expect(normalizeTier("vip")).toBe("agents");
    expect(normalizeTier("full")).toBe("full");
    expect(DEFAULT_TIER).toBe("agents");
    expect(REQUEST_DEFAULT_TIER).toBe("chat");
  });
  it("tiersOf：我是请求方时我的是 requester_tier，否则是 addressee_tier", () => {
    const row = { requester: "me", addressee: "you", requester_tier: "full", addressee_tier: "chat" };
    expect(tiersOf(row, "me")).toEqual({ mine: "full", theirs: "chat", effective: "chat" });
    expect(tiersOf(row, "you")).toEqual({ mine: "chat", theirs: "full", effective: "chat" });
    expect(tiersOf({ requester: "me", addressee: "you" }, "me")).toEqual({ mine: "agents", theirs: "agents", effective: "agents" });
    expect(myTierColumn(row, "me")).toBe("requester_tier");
    expect(myTierColumn(row, "you")).toBe("addressee_tier");
  });
  it("两道闸的那句话：不拦回 null，拦下时说清要双方都开", () => {
    expect(pairTierProblem("agents")).toBeNull();
    expect(pairTierProblem("chat")).toMatch(/仅聊天.*可带智能体/);
    expect(outreachTierProblem("full", "小红")).toBeNull();
    expect(outreachTierProblem("agents", "小红")).toMatch(/小红 没有把好友权限开到「全部开放」/);
  });
});

describe("0054 迁移文本", () => {
  const sql = read("supabase/migrations/0054_friend_tiers.sql");
  it("两列默认 agents、check 三档、insert 只能定自己那一边、已接受双方可改、触发器钉住只改自己那一边、pair_presence 按档位走", () => {
    expect(sql).toMatch(/add column if not exists requester_tier text not null default 'agents'/);
    expect(sql).toMatch(/add column if not exists addressee_tier text not null default 'agents'/);
    expect(sql).toMatch(/check \(requester_tier in \('chat', 'agents', 'full'\)\)/);
    expect(sql).toMatch(/with check \(auth\.uid\(\) = requester and status = 'pending' and addressee_tier = 'agents'\)/);
    expect(sql).toMatch(/create policy "friendships_tier_parties"/);
    expect(sql).toMatch(/grant update \(requester_tier, addressee_tier\) on public\.friendships to authenticated/);
    expect(sql).toMatch(/create trigger friendships_guard_tiers before update on public\.friendships/);
    expect(sql).toMatch(/f\.requester_tier <> 'chat' and f\.addressee_tier <> 'chat'/);
  });
  it("有对应的 check 脚本", () => {
    expect(read("supabase/checks/0054_friend_tiers.check.sql")).toMatch(/friendships_guard_tiers/);
  });
});
