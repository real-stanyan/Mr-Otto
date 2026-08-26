// DevicesApi 的手机端实现。和桌面的 supabaseDevicesApi.ts 是同一件事,
// 只是客户端不同(这边的 session 落 AsyncStorage)。查询链薄到无逻辑。

import type { DeviceRow, DevicesApi } from "../../src/shared/remote/devices.js";
import { supabase } from "./supabase.js";

const COLUMNS = "device_id,kind,identity_pub,kx_pub,label,last_seen";

export const devicesApi: DevicesApi = {
  async userId() {
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  },

  async upsert(row) {
    const { error } = await supabase
      .from("devices")
      .upsert({ ...row, last_seen: new Date().toISOString() }, { onConflict: "user_id,device_id" });
    if (error) throw new Error(error.message);
  },

  async list(userId) {
    // .eq 不是多余的:RLS 已经挡住别人的行,但没有它这条 select 语义上是全表
    const { data, error } = await supabase.from("devices").select(COLUMNS).eq("user_id", userId);
    if (error) throw new Error(error.message);
    return (data ?? []) as DeviceRow[];
  },

  async remove(userId, deviceId) {
    const { error } = await supabase
      .from("devices").delete().eq("user_id", userId).eq("device_id", deviceId);
    if (error) throw new Error(error.message);
  },
};
