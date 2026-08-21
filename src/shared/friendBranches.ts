// friendBranches — 把"好友在哪"投影到 Git Graph 的分支徽章上(issue #167)。纯函数,渲染层调。
// 好友报的是他本地的短名 `feat/x`;我这边同一根分支多半只有 remote 徽章 `origin/feat/x`,
// 所以 `x` 和 `*/x` 都算命中。图里根本没有那根分支(还没 fetch)的好友单独列出来。

import type { FriendProfile, FriendsSnapshot, WorkspacesSnapshot } from "./friends.js";
import type { GitRef } from "./gitGraph.js";

export interface FriendOnBranch {
  profile: FriendProfile;
  /** 好友的本地短名;null = detached HEAD */
  branch: string | null;
}

export interface FriendBranchProjection {
  /** 图里存在的分支 → 站在上面的好友。key 是徽章上的 ref 名(含 remote 前缀那种) */
  byRef: Map<string, FriendProfile[]>;
  /** 同仓库、但图里找不到那根分支(或 detached)的好友 */
  elsewhere: FriendOnBranch[];
}

/** ref 徽章名 → 它代表的本地短名。remote 去掉第一段(`origin/feat/x` → `feat/x`);tag 不算分支 */
export function refToBranch(ref: GitRef): string | null {
  if (ref.type === "tag") return null;
  if (ref.type === "remote") {
    const i = ref.name.indexOf("/");
    return i < 0 ? null : ref.name.slice(i + 1);
  }
  if (ref.name === "HEAD") return null; // detached 时 parseRefs 给的占位
  return ref.name;
}

export function projectFriendBranches(
  workspaces: WorkspacesSnapshot,
  friendsSnapshot: FriendsSnapshot,
  refs: GitRef[]
): FriendBranchProjection {
  const byRef = new Map<string, FriendProfile[]>();
  const elsewhere: FriendOnBranch[] = [];
  const mine = workspaces.mine;
  if (!mine) return { byRef, elsewhere };

  const profiles = new Map(friendsSnapshot.friends.map((e) => [e.profile.id, e.profile]));
  // 分支短名 → 图里叫这个名的所有徽章(本地 + 各 remote 都贴,用户看哪个都找得到人)
  const refsByBranch = new Map<string, string[]>();
  for (const r of refs) {
    const b = refToBranch(r);
    if (!b) continue;
    const list = refsByBranch.get(b);
    if (list) { if (!list.includes(r.name)) list.push(r.name); } else refsByBranch.set(b, [r.name]);
  }

  for (const fw of workspaces.friends) {
    if (fw.repoKey !== mine.repoKey) continue;
    const profile = profiles.get(fw.userId);
    if (!profile) continue; // 不是好友(主进程已过滤,这里再挡一道)
    const targets = fw.branch ? refsByBranch.get(fw.branch) : undefined;
    if (!targets) { elsewhere.push({ profile, branch: fw.branch }); continue; }
    for (const name of targets) {
      const list = byRef.get(name);
      if (list) list.push(profile); else byRef.set(name, [profile]);
    }
  }
  return { byRef, elsewhere };
}
