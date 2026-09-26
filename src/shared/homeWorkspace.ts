// 个人主场（#1280，ADR-0297）：有就用、没有就建。桌面的 workspaceManager 与手机端的名册
// 共用这一段（#1356）——各写一份的话，「两台设备同时建」那条竞态只会被其中一端接住。
//
// 两台设备同时建时后到的那台撞 `workspaces_one_home_per_owner`。**不看错误码**——PostgREST
// 的 code 在不同版本里挂的位置不一样（#1213 的 23505 那次就踩过），而这里有一个比错误码
// 更硬的判据：回头重查。查得到就是抢输了（对用户来说什么都没发生），查不到才是真失败，
// 原错误优先。

import type { SupabaseClient } from "@supabase/supabase-js";
import { HOME_WORKSPACE_NAME } from "./workspaces.js";

export interface HomeWorkspaceDeps {
  findHomeWorkspace(client: SupabaseClient, selfUid: string): Promise<string | null>;
  createWorkspace(client: SupabaseClient, name: string, selfUid: string, kind: "home"): Promise<{ id: string }>;
}

export async function ensureHomeWorkspace(
  deps: HomeWorkspaceDeps,
  client: SupabaseClient,
  uid: string
): Promise<{ id: string }> {
  const found = await deps.findHomeWorkspace(client, uid);
  if (found !== null) return { id: found };
  try {
    return { id: (await deps.createWorkspace(client, HOME_WORKSPACE_NAME, uid, "home")).id };
  } catch (err) {
    const raced = await deps.findHomeWorkspace(client, uid).catch(() => null);
    if (raced !== null) return { id: raced };
    throw err;
  }
}
