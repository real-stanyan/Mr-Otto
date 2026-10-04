// agent_shares（0059，#1545）的两条查询。**容错**：0059 没跑时读回空（手机当没有共有）、写只记一笔不抛——
// 共有那一行是锦上添花，不能因为它让接受名片本身失败。
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseAgentShareRow, type AgentShare } from "./agentShares.js";

/** 我参与的全部共有（我分享出去的 + 我接受进来的）。读不到回空 */
export async function fetchAgentShares(client: SupabaseClient, selfUid: string): Promise<AgentShare[]> {
  const res = await client.from("agent_shares").select("owner_uid,agent_id,with_uid,copy_agent_id,name").or(`owner_uid.eq.${selfUid},with_uid.eq.${selfUid}`);
  if (res.error || !Array.isArray(res.data)) return [];
  return res.data.map(parseAgentShareRow).filter((s): s is AgentShare => s !== null);
}

/** 接受名片那一刻记一行。回 true = 写进去了；false = 没写（0059 没跑 / 策略拒了 / 抖了），调用方只记日志 */
export async function recordAgentShare(client: SupabaseClient, s: AgentShare): Promise<boolean> {
  const res = await client.from("agent_shares").upsert(
    { owner_uid: s.ownerUid, agent_id: s.agentId, with_uid: s.withUid, copy_agent_id: s.copyAgentId, name: s.name },
    { onConflict: "owner_uid,agent_id,with_uid" },
  );
  return res.error === null;
}
