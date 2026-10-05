// Apple 健康接好之后那一页（#1671，demo 方向 B）：骨架照 AppDetailScreen——hero（方块 / 名字 / 状态点）→「智能体能读的」
// →「这样问就行」→ 去「健康」App 改授权 →「断开」（居中确认，右边那颗实底红；等确认弹窗退场放完再断）。
// 断开只是把开关关掉（healthPrefs），runtime 那边随 caps 帧当场知道；真正收回系统授权只能在「健康」App 里，组尾说清。
// 别处把开关关了（另一次断开）时这一页没东西可画了：直接回上一页，不留一页「已连接」的假话。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { HEALTH_METRICS } from "../../../src/shared/health.js";
import {
  HEALTH_APP_NAME, HEALTH_DETAIL, HEALTH_DISCONNECT, HEALTH_METRIC_NAMES, healthDisconnectedToast,
} from "../../../src/shared/mobileHealthApp.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import type { RootStackParams } from "../nav/types.js";
import { space, type as t, usePalette } from "../theme.js";
import { toast } from "../wx/toast.js";
import { Dot, Group, ListPage, Row } from "../ui.js";
import { setHealthEnabled, useHealthEnabled } from "./healthPrefs.js";
import { HealthTile } from "./HealthTile.js";

type Props = NativeStackScreenProps<RootStackParams, "HealthDetail">;

/** iOS「健康」App 的 URL scheme；打不开（模拟器 / 没装）就说一句 */
const HEALTH_APP_URL = "x-apple-health://";

export function HealthDetailScreen({ navigation }: Props) {
  const { c } = usePalette();
  const on = useHealthEnabled();
  const [confirm, setConfirm] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!on && !armed) navigation.goBack();
  }, [on, armed, navigation]);

  const side = { ...t.footnote, color: c.mutedForeground };
  const openHealth = (): void => {
    void Linking.openURL(HEALTH_APP_URL).catch(() => toast("打不开「健康」App"));
  };

  return (
    <ListPage>
      <View style={{ gap: space.sm }}>
        <View style={{ alignItems: "center", gap: 8, paddingTop: 18, paddingHorizontal: 24, paddingBottom: 14 }}>
          <HealthTile size={64} />
          <Text style={{ ...t.title, fontWeight: "600", color: c.foreground, textAlign: "center" }}>{HEALTH_APP_NAME}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Dot tone="ok" />
            <Text style={side}>{HEALTH_DETAIL.status}</Text>
          </View>
        </View>
        <Group header={HEALTH_DETAIL.readsHeader} footer={HEALTH_DETAIL.readsFooter}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: space.md, paddingVertical: 12 }}>
            {HEALTH_METRICS.map((m) => (
              <Text
                key={m}
                style={{ ...t.footnote, color: c.foreground, backgroundColor: c.field, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, overflow: "hidden" }}
              >
                {HEALTH_METRIC_NAMES[m]}
              </Text>
            ))}
          </View>
        </Group>
        <Group header={HEALTH_DETAIL.askHeader} footer={HEALTH_DETAIL.askFooter}>
          {HEALTH_DETAIL.examples.map((q) => (
            <Row key={q} label={q} />
          ))}
        </Group>
        <View style={{ height: 12 }} />
        <Group>
          <Row label={HEALTH_DETAIL.openHealth} chevron onPress={openHealth} />
        </Group>
        <View style={{ height: 12 }} />
        <Group footer={HEALTH_DETAIL.disconnectFooter}>
          <Row label={HEALTH_DETAIL.disconnect} tone="destructive" align="center" onPress={() => setConfirm(true)} />
        </Group>
      </View>
      <Dialog
        visible={confirm}
        onExited={() => {
          if (!armed) return;
          // 返回交给上面那个 effect（开关关了 + 不在断开途中 = 回上一页），这里不再 goBack，免得退两层
          void setHealthEnabled(false).then(() => {
            toast(healthDisconnectedToast);
            setArmed(false);
          });
        }}
      >
        <DialogTitle>{HEALTH_DISCONNECT.title}</DialogTitle>
        <DialogLead>{HEALTH_DISCONNECT.lead}</DialogLead>
        <DialogFooter
          left={{ label: "取消", onPress: () => setConfirm(false) }}
          right={{
            label: HEALTH_DISCONNECT.confirm,
            tone: "destructive",
            onPress: () => {
              setArmed(true);
              setConfirm(false);
            },
          }}
        />
      </Dialog>
    </ListPage>
  );
}
