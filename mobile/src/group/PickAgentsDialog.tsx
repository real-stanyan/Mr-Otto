// 挑几只智能体（#1386，demo 的 pickMembers）：发起群聊 / 拉进群 / 移出群，三处同一副骨架——居中弹窗、一列可勾的行、
// 右上角「已选 N 只」、底下「取消 / 做」。判据在 shared/groupEdit.ts：名单一律按名册顺序、满 6 只时没勾的锁住而勾上的
// 照样点得动（全锁死的话满员之后名单再也改不了）。
//
// 只挑智能体：把朋友和你的智能体放进同一个群要改后端（智能体住在你的个人主场里，朋友不是主场成员——spec §2，
// 留给维护者拍板），所以这张单子上没有「朋友」那一段。
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { CHAT_GROUP_MAX, CHAT_NAME_MAX } from "../../../src/shared/chatRoster.js";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { groupNameFor, rosterOrder } from "../../../src/shared/groupEdit.js";
import { agentNameOf } from "../../../src/shared/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { Dialog, DialogBody, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { usePalette } from "../theme.js";
import { Field, Note } from "../ui.js";
import { FaceTile } from "../wx/Avatar.js";
import { Icon } from "../wx/Icon.js";

export function PickAgentsDialog({ visible, ws, title, lead, options, preset = [], min, max = CHAT_GROUP_MAX, okLabel, withName = false, busy, error, onOk, onClose, onExited }: {
  visible: boolean;
  ws: WorkspaceSnapshot;
  title: string;
  lead?: string;
  /** 能挑的那几只（调用方按名册顺序给） */
  options: readonly string[];
  preset?: readonly string[];
  min: number;
  /** 最多挑几只（拉人时 = 6 − 群里已有的） */
  max?: number;
  okLabel: string;
  /** 要不要一格群名（发起群聊才要；留空用成员名拼） */
  withName?: boolean;
  busy: boolean;
  error: string | null;
  onOk: (picked: string[], name: string) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const [picked, setPicked] = useState<string[]>(() => rosterOrder(ws, preset.filter((id) => options.includes(id))));
  const [name, setName] = useState("");
  const toggle = (id: string): void => {
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= max ? cur : rosterOrder(ws, [...cur, id])));
  };
  const enough = picked.length >= min;
  return (
    <Dialog visible={visible} wide {...(onExited === undefined ? {} : { onExited })}>
      <DialogTitle>{title}</DialogTitle>
      {lead !== undefined ? <DialogLead>{lead}</DialogLead> : null}
      <DialogBody>
        {withName ? (
          <Field
            variant="dialog"
            value={name}
            onChangeText={setName}
            placeholder={picked.length > 0 ? groupNameFor(ws, picked, "") : "群名（不填就用它们的名字）"}
            maxLength={CHAT_NAME_MAX}
            editable={!busy}
            returnKeyType="done"
          />
        ) : null}
        <Text style={{ fontSize: 12, color: c.faint, textAlign: "right", marginTop: 2 }}>{`已选 ${picked.length} 只 · 最多 ${max}`}</Text>
      </DialogBody>
      <ScrollView style={{ maxHeight: 300, marginTop: 4 }} contentContainerStyle={{ paddingVertical: 2 }} keyboardShouldPersistTaps="handled">
        {options.map((id, i) => {
          const on = picked.includes(id);
          const locked = !on && picked.length >= max;
          return (
            <View key={id}>
              {i > 0 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 68 }} /> : null}
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled: locked || busy }}
                accessibilityLabel={agentNameOf(ws, id)}
                disabled={locked || busy}
                onPress={() => toggle(id)}
                style={({ pressed }) => [
                  { flexDirection: "row", alignItems: "center", gap: 12, height: 56, paddingHorizontal: 20 },
                  pressed && { backgroundColor: c.press },
                  locked && { opacity: 0.4 },
                ]}
              >
                <FaceTile slot={agentFaceSlot(ws, id)} size={36} />
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, color: c.foreground }}>{agentNameOf(ws, id)}</Text>
                <View style={{ width: 22, alignItems: "center", opacity: on ? 1 : 0 }}>
                  <Icon name="check" size={20} stroke={2.2} color={c.brand} />
                </View>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
      {error !== null ? (
        <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
          <Note tone="error">{error}</Note>
        </View>
      ) : null}
      <DialogFooter
        left={{ label: "取消", onPress: onClose, disabled: busy }}
        right={{ label: busy ? "正在做…" : okLabel, onPress: () => onOk(picked, name), disabled: busy || !enough }}
      />
    </Dialog>
  );
}
