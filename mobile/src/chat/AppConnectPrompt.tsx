// 连接卡发来时正看着会话就弹的那一张居中弹窗（#1666，spec §4.2，demo 的 .dlg）：
// 应用图标 56 → 发卡那只的名字（灰小字）→ 标题 → 为什么 → 主按钮 → 安静的「稍后」。
// 主按钮跟卡上的主按钮是同一个动作（调用方递 onPrimary，走 ChatScreen 的 onAppConnect），字也取同一张表。
// 不给 dismissible：出口只有这两颗按钮。「稍后」只收起，卡还在会话里；主按钮也只是收起——
// 真正的动作要等 onExited（弹窗完全退场）之后调用方再做：接入弹窗要升系统登录页，不能叠在一张正在退场的 Modal 上
// （ConnectAppDialog.tsx 头注释）。
import { Text, View } from "react-native";
import { catalogIcon } from "../../../src/shared/appIcon.js";
import { APP_CONNECT_BUTTON, appConnectCardTitle, type AppConnectAction } from "../../../src/shared/appConnect.js";
import type { ChatRow } from "../../../src/shared/mobileChat.js";
import { Dialog } from "../dialog.js";
import { AppTile } from "../machine/AppTile.js";
import { usePalette } from "../theme.js";
import { Button } from "../ui.js";

export function AppConnectPrompt({ row, action, visible, onShown, onPrimary, onLater, onExited }: {
  row: Extract<ChatRow, { kind: "app_connect" }>;
  /** 调用方只在知道按钮时才弹（appConnectActionFor 非 null）；开着时清单被清空（换号）回 null：主按钮不给点、标题中性 */
  action: AppConnectAction | null;
  visible: boolean;
  /** Modal 真的摊开之后调一次 */
  onShown: () => void;
  onPrimary: () => void;
  onLater: () => void;
  /** 退场放完、Modal 收起之后调一次：调用方在这里才卸掉它 / 才去做主按钮的动作 */
  onExited: () => void;
}) {
  const { c } = usePalette();
  return (
    <Dialog visible={visible} onShown={onShown} onExited={onExited}>
      <View style={{ alignItems: "center", paddingHorizontal: 20, gap: 10 }}>
        <AppTile name={row.appName} icon={catalogIcon(row.catalogId)} size={56} />
        <Text style={{ fontSize: 12, lineHeight: 16, color: c.faint }}>{row.name}</Text>
        <Text style={{ fontSize: 17, lineHeight: 22, fontWeight: "600", textAlign: "center", color: c.foreground }}>
          {appConnectCardTitle(row, action)}
        </Text>
        {row.why !== "" ? (
          <Text style={{ fontSize: 14, lineHeight: 20, textAlign: "center", color: c.mutedForeground }}>{row.why}</Text>
        ) : null}
        <View style={{ alignSelf: "stretch", gap: 8, marginTop: 6 }}>
          <Button size="dialog" variant="primary" label={action === null ? "…" : APP_CONNECT_BUTTON[action]} disabled={action === null} onPress={onPrimary} />
          <Button size="dialog" variant="quiet" label="稍后" onPress={onLater} />
        </View>
      </View>
    </Dialog>
  );
}
