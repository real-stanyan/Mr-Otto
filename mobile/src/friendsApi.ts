// 好友:**只读**。两条查询,RLS 已经把可见范围钉在"自己参与的行"
// (和桌面 src/main/supabaseFriendsApi.ts 的 listFriendships 同一条注释)。
//
// 为什么不是把桌面那份搬过来:那边还带私信、实时订阅、乐观发送和降级轮询
// (ADR-0027),整套搬进手机等于把手机做成第二个完整客户端 —— 而它是第三个
// 投影窗口(ADR-0094)。加好友、收发私信、接受请求这些**写**操作留在电脑上。

import type { FriendProfile } from "../../src/shared/friends.js";
import { supabase } from "./supabase.js";

export interface FriendRow {
  profile: FriendProfile;
  /** pending 的还带方向:待我处理的和我发出去的,人要分得开 */
  status: "accepted" | "pending";
  direction: "incoming" | "outgoing";
}

export async function listFriends(): Promise<FriendRow[]> {
  const { data: session } = await supabase.auth.getSession();
  const uid = session.session?.user.id;
  if (!uid) return [];

  const links = await supabase.from("friendships").select("id,requester,addressee,status");
  if (links.error) throw new Error(links.error.message);
  const rows = (links.data ?? []) as {
    id: string; requester: string; addressee: string; status: "pending" | "accepted";
  }[];
  if (rows.length === 0) return [];

  const otherOf = (r: (typeof rows)[number]): string =>
    r.requester === uid ? r.addressee : r.requester;
  const ids = [...new Set(rows.map(otherOf))];
  const people = await supabase.from("profiles").select("id,email,name,avatar_url").in("id", ids);
  if (people.error) throw new Error(people.error.message);
  const byId = new Map<string, FriendProfile>();
  for (const p of (people.data ?? []) as
    { id: string; email: string; name: string | null; avatar_url: string | null }[]) {
    byId.set(p.id, { id: p.id, email: p.email, name: p.name ?? "", avatarUrl: p.avatar_url ?? "" });
  }

  const out: FriendRow[] = [];
  for (const r of rows) {
    const profile = byId.get(otherOf(r));
    // profiles 里没有那一行(被删号 / RLS 挡住):不塞一个没名字的空壳进列表
    if (!profile) continue;
    out.push({ profile, status: r.status, direction: r.requester === uid ? "outgoing" : "incoming" });
  }
  // 待我处理的排最前 —— 它是这一屏唯一需要人动手的东西(动手在电脑上)
  const rank = (f: FriendRow): number =>
    f.status === "pending" && f.direction === "incoming" ? 0 : f.status === "accepted" ? 1 : 2;
  return out.sort((a, b) => rank(a) - rank(b));
}
