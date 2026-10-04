// 长按一条消息之后的那张单子（#1505，ADR-0352）：挑我主场里的一只智能体（单选，iOS 设置的勾）+ 一句提示（可空），
// 「派出去」= 开一条它的私聊，首句是提示 + 引用。弹窗（不是底部抽屉）：有输入框，照 dialog.tsx 的规矩。
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { DISPATCH_DEFAULT_PROMPT, DISPATCH_PROMPT_MAX_CHARS } from "../../../src/shared/dispatchQuote.js";
import { agentNameOf } from "../../../src/shared/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { Dialog, DialogBody, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { usePalette } from "../theme.js";
import { Field, Group, Row } from "../ui.js";
import { FaceTile } from "../wx/Avatar.js";

export function DispatchDialog({ visible, ws, agentIds, preview, onOk, onClose, onExited }: {
  visible: boolean;
  /** 我的主场（智能体名单从这儿来） */
  ws: WorkspaceSnapshot;
  agentIds: readonly string[];
  /** 被选的那句（给人看一眼是哪条） */
  preview: string;
  onOk: (agentId: string, prompt: string) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const [agentId, setAgentId] = useState<string | null>(agentIds.length === 1 ? (agentIds[0] ?? null) : null);
  const [prompt, setPrompt] = useState("");
  return (
    <Dialog visible={visible} wide {...(onExited === undefined ? {} : { onExited })}>
      <DialogTitle>交给管理员去办</DialogTitle>
      <DialogLead>{`它会收到这条和前面几句：「${preview.length > 60 ? `${preview.slice(0, 60)}…` : preview}」`}</DialogLead>
      <DialogBody>
        <Field variant="dialog" value={prompt} onChangeText={setPrompt} placeholder={DISPATCH_DEFAULT_PROMPT} maxLength={DISPATCH_PROMPT_MAX_CHARS} />
      </DialogBody>
      <ScrollView style={{ maxHeight: 260, marginTop: 8 }} keyboardShouldPersistTaps="handled">
        <Group>
          {agentIds.map((id) => (
            <Row
              key={id}
              label={agentNameOf(ws, id)}
              leading={<FaceTile slot={agentFaceSlot(ws, id)} size={32} />}
              checked={agentId === id}
              onPress={() => setAgentId(id)}
            />
          ))}
        </Group>
      </ScrollView>
      {agentIds.length === 0 ? (
        <Text style={{ fontSize: 13, color: c.mutedForeground, paddingHorizontal: 20, paddingTop: 8 }}>你的主场里还没有智能体。</Text>
      ) : null}
      <View>
        <DialogFooter
          left={{ label: "取消", onPress: onClose }}
          right={{ label: "派出去", onPress: () => { if (agentId !== null) onOk(agentId, prompt); }, disabled: agentId === null }}
        />
      </View>
    </Dialog>
  );
}
