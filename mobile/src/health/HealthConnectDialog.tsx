// 连接 Apple 健康那一张居中弹窗（#1671，demo 方向 B）：先说清读什么、只在你问的时候读，再交给 iOS 的 HealthKit 授权页。
// 同 ConnectAppDialog 的做法：系统授权页升起时这张弹窗是完全摊开的（不叠在一张正在退场的 Modal 上），按钮里转着；
// 授权回来才收弹窗，收完（onExited）再回调——调用方在那里弹 toast，不在退场途中叠第二层。
// 授权页点「不允许」也算连上：iOS 不告诉 App 拒了哪类，只能照开关算（详情页那句「某一类读不到，多半是没允许」就是为这个）。
import { useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { HEALTH_CONNECT } from "../../../src/shared/mobileHealthApp.js";
import { Dialog, DialogBody, DialogLead, DialogTitle } from "../dialog.js";
import { radius, space, type as t, usePalette } from "../theme.js";
import { Button } from "../ui.js";
import { Icon } from "../wx/Icon.js";
import { setHealthEnabled } from "./healthPrefs.js";
import { HealthTile } from "./HealthTile.js";

export function HealthConnectDialog({ onClose }: { onClose: (connected: boolean) => void }) {
  const { c } = usePalette();
  const [visible, setVisible] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = useRef(false);

  const go = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setHealthEnabled(true);
      connected.current = true;
      setVisible(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog visible={visible} onExited={() => onClose(connected.current)}>
      <View style={{ alignItems: "center", marginBottom: 10 }}>
        <HealthTile />
      </View>
      <DialogTitle>{HEALTH_CONNECT.title}</DialogTitle>
      <DialogLead>{HEALTH_CONNECT.lead}</DialogLead>
      <DialogBody>
        <View style={{ flexDirection: "row", gap: 8, backgroundColor: c.field, borderRadius: radius.tile, paddingVertical: 9, paddingHorizontal: 11 }}>
          <View style={{ paddingTop: 2 }}>
            <Icon name="info" size={16} color={c.faint} />
          </View>
          <Text style={{ ...t.footnote, color: c.mutedForeground, lineHeight: 19, flex: 1 }}>{HEALTH_CONNECT.note}</Text>
        </View>
        {error !== null ? (
          <Text accessibilityRole="alert" style={{ ...t.footnote, color: c.destructive, textAlign: "center", marginTop: space.xs }}>
            {error}
          </Text>
        ) : null}
      </DialogBody>
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingTop: 20 }}>
        <Button grow size="dialog" variant="secondary" label="取消" onPress={() => setVisible(false)} disabled={busy} />
        <Button
          grow
          size="dialog"
          label={busy ? "连接中" : HEALTH_CONNECT.confirm}
          {...(busy ? { icon: <ActivityIndicator size="small" color={c.primaryForeground} /> } : {})}
          onPress={() => void go()}
          disabled={busy}
        />
      </View>
    </Dialog>
  );
}
