// 车道的朝向（#1523，#1461 P2）：带进来的智能体「仅我可见」还是「公开给 TA」。两行单选（同 TierPickDialog 的语汇），
// 每行一句小字说清会发生什么——公开那一档要把「TA 让它们动手时每一步都要你批、花的是你的额度」说出来，
// 不然人会以为公开只是让对方看得见。带上时选一次，之后横幅与「聊天信息」页都能改。
import { useState } from "react";
import { Text, View } from "react-native";
import { LANE_FACING_DESC, LANE_FACING_LABEL, type PairFacing } from "../../../src/shared/pairChat.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { usePalette } from "../theme.js";
import { Group, Row } from "../ui.js";

const FACINGS: readonly PairFacing[] = ["self", "both"];

export function LaneFacingDialog({ visible, title, lead, initial, okLabel, busy = false, error = null, onOk, onClose, onExited }: {
  visible: boolean;
  title: string;
  lead: string;
  initial: PairFacing;
  okLabel: string;
  busy?: boolean;
  error?: string | null;
  onOk: (facing: PairFacing) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const [facing, setFacing] = useState<PairFacing>(initial);
  return (
    <Dialog visible={visible} wide {...(onExited === undefined ? {} : { onExited })}>
      <DialogTitle>{title}</DialogTitle>
      <DialogLead>{lead}</DialogLead>
      <View style={{ marginTop: 8 }}>
        <Group>
          {FACINGS.map((f) => (
            <Row key={f} label={LANE_FACING_LABEL[f]} detail={LANE_FACING_DESC[f]} checked={facing === f} onPress={() => setFacing(f)} />
          ))}
        </Group>
      </View>
      {error !== null ? <Text style={{ fontSize: 13, color: c.destructive, paddingHorizontal: 20, paddingTop: 8 }}>{error}</Text> : null}
      <DialogFooter
        left={{ label: "取消", onPress: onClose, disabled: busy }}
        right={{ label: busy ? "…" : okLabel, onPress: () => onOk(facing), disabled: busy }}
      />
    </Dialog>
  );
}
