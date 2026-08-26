// supabaseDevicesApi —— DevicesApi 的真 supabase 实现(对应 supabaseUserProfileApi.ts
// 之于 userProfile.ts)。查询链薄到无逻辑,错误原样上抛。
//
// 这张表只当"目录"用,不是信任来源:读回来的公钥由 remoteDevices.ts 逐个校验,
// 最终由人核对 6 位安全码才 pin(spec 第二节)。

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeviceRow, DevicesApi } from "../shared/remote/devices.js";

const COLUMNS = "device_id,kind,identity_pub,kx_pub,label,last_seen";

function unwrap<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export function createSupabaseDevicesApi(client: SupabaseClient): DevicesApi {
  return {
    async userId() {
      const { data } = await client.auth.getUser();
      return data.user?.id ?? null;
    },

    async upsert(row) {
      // last_seen 交给默认值/这次写入:登记这个动作本身就是"我刚才还在"
      const res = await client
        .from("devices")
        .upsert({ ...row, last_seen: new Date().toISOString() }, { onConflict: "user_id,device_id" })
        .select(COLUMNS);
      unwrap(res);
    },

    async list(userId) {
      // .eq 不是多余的:RLS 已经挡住别人的行,但没有它这条 select 语义上是全表,
      // 被 RLS 收成空集之后错误信息会和"权限"无关(同 supabaseUserProfileApi 的注释)
      const res = await client.from("devices").select(COLUMNS).eq("user_id", userId);
      return (unwrap(res) ?? []) as DeviceRow[];
    },

    async remove(userId, deviceId) {
      // 主键是 (user_id, device_id),两个都给:少一个就成了"删这个 id 的所有行",
      // 靠 RLS 兜住不是理由 —— 查询本身该是精确的
      const res = await client
        .from("devices")
        .delete()
        .eq("user_id", userId)
        .eq("device_id", deviceId)
        .select(COLUMNS);
      unwrap(res);
    },
  };
}
