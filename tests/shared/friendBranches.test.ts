import { describe, it, expect } from "vitest";
import { projectFriendBranches, refToBranch } from "../../src/shared/friendBranches.js";
import type { FriendProfile, FriendsSnapshot, WorkspacesSnapshot } from "../../src/shared/friends.js";
import type { GitRef } from "../../src/shared/gitGraph.js";

const prof = (id: string): FriendProfile => ({ id, email: `${id}@x`, name: id, avatarUrl: "" });
const friends = (...ids: string[]): FriendsSnapshot => ({
  friends: ids.map((id) => ({ friendshipId: `f-${id}`, profile: prof(id), status: "accepted", direction: "outgoing" })),
  incoming: [], outgoing: [],
});
const REFS: GitRef[] = [
  { name: "main", type: "head" },
  { name: "origin/main", type: "remote" },
  { name: "feat/x", type: "branch" },
  { name: "origin/feat/y", type: "remote" },
  { name: "v1", type: "tag" },
];

describe("refToBranch", () => {
  it("本地/HEAD 原名,remote 去第一段,tag 和 detached 占位不算", () => {
    expect(refToBranch({ name: "feat/x", type: "branch" })).toBe("feat/x");
    expect(refToBranch({ name: "origin/feat/y", type: "remote" })).toBe("feat/y");
    expect(refToBranch({ name: "v1", type: "tag" })).toBeNull();
    expect(refToBranch({ name: "HEAD", type: "head" })).toBeNull();
  });
});

describe("projectFriendBranches", () => {
  const ws = (friendsOn: WorkspacesSnapshot["friends"], mineKey: string | null = "k"): WorkspacesSnapshot => ({
    mine: mineKey ? { repoKey: mineKey, branch: "main" } : null,
    friends: friendsOn,
  });

  it("本地分支 + 同名 remote 都贴上;只有 remote 徽章的分支也命中", () => {
    const p = projectFriendBranches(ws([
      { userId: "a", repoKey: "k", branch: "main" },
      { userId: "b", repoKey: "k", branch: "feat/y" },
    ]), friends("a", "b"), REFS);
    expect(p.byRef.get("main")?.map((x) => x.id)).toEqual(["a"]);
    expect(p.byRef.get("origin/main")?.map((x) => x.id)).toEqual(["a"]);
    expect(p.byRef.get("origin/feat/y")?.map((x) => x.id)).toEqual(["b"]);
    expect(p.elsewhere).toEqual([]);
  });

  it("别的仓库的好友、非好友、我自己没 repoKey → 不画", () => {
    const other = projectFriendBranches(ws([{ userId: "a", repoKey: "zz", branch: "main" }]), friends("a"), REFS);
    expect(other.byRef.size).toBe(0);
    const stranger = projectFriendBranches(ws([{ userId: "s", repoKey: "k", branch: "main" }]), friends("a"), REFS);
    expect(stranger.byRef.size).toBe(0);
    const noMine = projectFriendBranches(ws([{ userId: "a", repoKey: "k", branch: "main" }], null), friends("a"), REFS);
    expect(noMine.byRef.size).toBe(0);
  });

  it("图里没有那根分支 / detached → 进 elsewhere", () => {
    const p = projectFriendBranches(ws([
      { userId: "a", repoKey: "k", branch: "wip/secret" },
      { userId: "b", repoKey: "k", branch: null },
    ]), friends("a", "b"), REFS);
    expect(p.byRef.size).toBe(0);
    expect(p.elsewhere.map((e) => [e.profile.id, e.branch])).toEqual([["a", "wip/secret"], ["b", null]]);
  });
});
