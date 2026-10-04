// 私聊页标题栏的电话钮（#1533 / #1534）：两项——给本人打电话（WebRTC，#1534）、给 TA 的公开智能体打电话。
// 同 LaneFacingDialog 的语汇：居中弹窗、两行可点。
import { Text } from "react-native";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { usePalette } from "../theme.js";
import { Group, Row } from "../ui.js";

export function CallPickDialog({ visible, friendName, agentName, busy = false, error = null, onPerson, onAgent, onClose, onExited }: {
  visible: boolean;
  friendName: string;
  /** 给本人打电话（#1534）：WebRTC 走中继配对；缺席 = 这一版还打不了（灰着说清） */
  onPerson?: () => void;
  /** TA 的公开智能体叫什么；null = 没设（那一行也灰着） */
  agentName: string | null;
  busy?: boolean;
  error?: string | null;
  onAgent: () => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  return (
    <Dialog visible={visible} wide {...(onExited === undefined ? {} : { onExited })}>
      <DialogTitle>打电话</DialogTitle>
      <DialogLead>{`给 ${friendName}，还是给 TA 的智能体。`}</DialogLead>
      <Group>
        <Row
          label={`给 ${friendName} 本人打电话`}
          detail={onPerson !== undefined ? "对方手机响铃；接起来就是你们俩的语音通话。" : "人与人的通话还没做好（#1534），先用对方的智能体代接。"}
          {...(onPerson !== undefined && !busy ? { chevron: true, onPress: onPerson } : {})}
        />
        <Row
          label={agentName !== null ? `给 TA 的智能体「${agentName}」打电话` : "给 TA 的智能体打电话"}
          detail={agentName !== null ? `说完它会把你的需求总结给 ${friendName}，你们俩都看得到。` : `${friendName} 还没有设定公开智能体。`}
          chevron
          {...(agentName !== null && !busy ? { onPress: onAgent } : {})}
        />
      </Group>
      {error !== null ? <Text style={{ fontSize: 13, color: c.destructive, paddingHorizontal: 20, paddingTop: 8 }}>{error}</Text> : null}
      <DialogFooter left={{ label: "取消", onPress: onClose, disabled: busy }} right={{ label: busy ? "…" : "关闭", onPress: onClose, disabled: busy }} />
    </Dialog>
  );
}
