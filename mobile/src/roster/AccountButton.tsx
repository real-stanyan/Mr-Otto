// 名册左上角那颗：进账号。demo 里它是一颗毛玻璃圆钮、里面是名字的首字（前景色，不是彩色头像）。
// 名字与首字走 shared 的 accountName / accountInitial（账号页同一份）。
// 右上角那枚「有应用等你登录」的点**不画**：A5 查过数据源——应用要不要重新登录只活在桌面进程里（McpHub 的
// needs-auth），托管箱还把不 live 的整台滤掉，手机从哪条路都问不出来（spec §10 第 80 条；补数据源见 #1376）。
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { accountInitial, accountName } from "../../../src/shared/mobileAccount.js";
import { supabase } from "../supabase.js";
import { usePalette } from "../theme.js";
import { RoundButton } from "../chrome/RoundButton.js";

export function AccountButton({ onPress }: { onPress: () => void }) {
  const { c } = usePalette();
  const [name, setName] = useState("");
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setName(accountName(data.session?.user));
    });
  }, []);
  return (
    <RoundButton label="账号" onPress={onPress}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: c.foreground }}>
        {accountInitial(name)}
      </Text>
    </RoundButton>
  );
}
