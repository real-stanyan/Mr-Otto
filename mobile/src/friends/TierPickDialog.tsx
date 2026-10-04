// 选好友权限那一档（#1494，ADR-0350）：加好友时、接受请求时、朋友资料页里改都用这一张。三行单选（iOS 设置的单选语汇：
// 选中的那行右边一枚勾）+ 每档一行小字说清会发生什么。选的是「我给 TA 的那一边」——生效要看两边的最小值，
// 底下那句话把这件事说出来，不然人会以为自己开了「全部开放」对方的智能体就能来。
import { useState } from "react";
import { Text, View } from "react-native";
import { FRIEND_TIERS, TIER_DESC, TIER_LABEL, type FriendTier } from "../../../src/shared/friendTier.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { usePalette } from "../theme.js";
import { Group, Row } from "../ui.js";

export function TierPickDialog({ visible, title, lead, initial, okLabel, busy = false, error = null, onOk, onClose, onExited }: {
  visible: boolean;
  title: string;
  lead: string;
  initial: FriendTier;
  okLabel: string;
  busy?: boolean;
  error?: string | null;
  onOk: (tier: FriendTier) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const [tier, setTier] = useState<FriendTier>(initial);
  return (
    <Dialog visible={visible} wide {...(onExited === undefined ? {} : { onExited })}>
      <DialogTitle>{title}</DialogTitle>
      <DialogLead>{lead}</DialogLead>
      <View style={{ marginTop: 8 }}>
        <Group>
          {FRIEND_TIERS.map((t) => (
            <Row key={t} label={TIER_LABEL[t]} detail={TIER_DESC[t]} checked={tier === t} onPress={() => setTier(t)} />
          ))}
        </Group>
      </View>
      <Text style={{ fontSize: 12, lineHeight: 17, color: c.mutedForeground, paddingHorizontal: 20, paddingTop: 10 }}>
        这是你给 TA 的权限。真正生效的是你们俩里低的那一档。
      </Text>
      {error !== null ? <Text style={{ fontSize: 13, color: c.destructive, paddingHorizontal: 20, paddingTop: 8 }}>{error}</Text> : null}
      <DialogFooter
        left={{ label: "取消", onPress: onClose, disabled: busy }}
        right={{ label: busy ? "…" : okLabel, onPress: () => onOk(tier), disabled: busy }}
      />
    </Dialog>
  );
}
