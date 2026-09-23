// 名册左上角那颗：进账号。demo 里它是一颗毛玻璃圆钮、里面是名字的首字（前景色，不是彩色头像）。
// 名字先取 OAuth 带来的 user_metadata，没有就用邮箱（原 nav/AvatarButton.tsx 的取法）。
// 右上角那枚「有应用等你登录」的点在 A5（spec §5.8）——数据源查清之前不画。
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { supabase } from "../supabase.js";
import { usePalette } from "../theme.js";
import { RoundButton } from "../chrome/RoundButton.js";

export function AccountButton({ onPress }: { onPress: () => void }) {
  const { c } = usePalette();
  const [name, setName] = useState("");
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user;
      const meta = (u?.user_metadata ?? {}) as { name?: string; full_name?: string };
      setName(meta.name ?? meta.full_name ?? u?.email ?? "");
    });
  }, []);
  return (
    <RoundButton label="账号" onPress={onPress}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: c.foreground }}>
        {(name.trim() || "·").slice(0, 1).toUpperCase()}
      </Text>
    </RoundButton>
  );
}
