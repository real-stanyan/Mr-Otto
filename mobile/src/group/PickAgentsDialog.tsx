// 挑人（#1386，demo 的 pickMembers）：发起群聊 / 拉进群 / 移出群，同一副骨架——居中弹窗、一列可勾的行、
// 右上角「已选 N」、底下「取消 / 做」。判据在 shared/groupEdit.ts：智能体一律按名册顺序、满 6 只时没勾的锁住而勾上的
// 照样点得动（全锁死的话满员之后名单再也改不了）。
//
// 朋友那一段（#1393，ADR-0325）：你的智能体和朋友可以在同一个群里了。给了 `people` 就多一段「朋友」
// （移出时是「群里的人」），勾上的人随 onOk 的第三个参数交回去；下限按智能体 + 人合起来算（建群要凑够 2 位）。
// 只挑人不挑智能体（群里的客人拉自己的朋友）时 `options` 给空数组，那一段就不画。
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { CHAT_GROUP_MAX, CHAT_HUMANS_MAX, CHAT_NAME_MAX } from "../../../src/shared/chatRoster.js";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { mixedGroupName } from "../../../src/shared/chatGuests.js";
import { rosterOrder } from "../../../src/shared/groupEdit.js";
import { agentNameOf } from "../../../src/shared/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { Dialog, DialogBody, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { usePalette } from "../theme.js";
import { Field, Note } from "../ui.js";
import { FaceTile, PersonTile } from "../wx/Avatar.js";
import { Icon } from "../wx/Icon.js";

/** 能勾的一个人（朋友 / 群里的人） */
export interface PickPerson {
  uid: string;
  name: string;
  url: string;
}

export function PickAgentsDialog({
  visible, ws, title, lead, options, preset = [], min, max = CHAT_GROUP_MAX, okLabel, withName = false, busy, error,
  people, peopleLabel = "朋友", presetPeople = [], maxPeople = CHAT_HUMANS_MAX, onOk, onClose, onExited,
}: {
  visible: boolean;
  ws: WorkspaceSnapshot;
  title: string;
  lead?: string;
  /** 能挑的那几只（调用方按名册顺序给）。空 = 这张单子只挑人 */
  options: readonly string[];
  preset?: readonly string[];
  /** 至少挑几位（智能体 + 人合起来） */
  min: number;
  /** 最多挑几只智能体（拉人时 = 6 − 群里已有的） */
  max?: number;
  okLabel: string;
  /** 要不要一格群名（发起群聊才要；留空用成员名拼） */
  withName?: boolean;
  busy: boolean;
  error: string | null;
  /** 能挑的人（#1393）。缺席 = 这张单子上没有人那一段 */
  people?: readonly PickPerson[];
  /** 人那一段的小标题：拉人时是「朋友」，移出时是「群里的人」 */
  peopleLabel?: string;
  presetPeople?: readonly string[];
  /** 最多挑几个人 */
  maxPeople?: number;
  onOk: (picked: string[], name: string, pickedPeople: string[]) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const [picked, setPicked] = useState<string[]>(() => rosterOrder(ws, preset.filter((id) => options.includes(id))));
  const [pickedPeople, setPickedPeople] = useState<string[]>(() => presetPeople.filter((u) => people?.some((p) => p.uid === u) === true));
  const [name, setName] = useState("");
  const toggle = (id: string): void => {
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= max ? cur : rosterOrder(ws, [...cur, id])));
  };
  const togglePerson = (uid: string): void => {
    setPickedPeople((cur) => (cur.includes(uid) ? cur.filter((x) => x !== uid) : cur.length >= maxPeople ? cur : [...cur, uid]));
  };
  const total = picked.length + pickedPeople.length;
  const enough = total >= min;
  const hasPeople = people !== undefined && people.length > 0;
  const hasAgents = options.length > 0;
  const pickedPeopleRows = (people ?? []).filter((p) => pickedPeople.includes(p.uid));
  const counter = hasPeople ? `已选 ${total} 位` : `已选 ${picked.length} 只 · 最多 ${max}`;

  const sectionTitle = (text: string) => (
    <Text style={{ fontSize: 13, color: c.mutedForeground, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 4 }}>{text}</Text>
  );
  const row = (key: string, avatar: React.ReactNode, label: string, on: boolean, locked: boolean, first: boolean, onPress: () => void) => (
    <View key={key}>
      {first ? null : <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 68 }} />}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on, disabled: locked || busy }}
        accessibilityLabel={label}
        disabled={locked || busy}
        onPress={onPress}
        style={({ pressed }) => [
          { flexDirection: "row", alignItems: "center", gap: 12, height: 56, paddingHorizontal: 20 },
          pressed && { backgroundColor: c.press },
          locked && { opacity: 0.4 },
        ]}
      >
        {avatar}
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, color: c.foreground }}>{label}</Text>
        <View style={{ width: 22, alignItems: "center", opacity: on ? 1 : 0 }}>
          <Icon name="check" size={20} stroke={2.2} color={c.brand} />
        </View>
      </Pressable>
    </View>
  );

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
            placeholder={total > 0 ? mixedGroupName(ws, picked, pickedPeopleRows, "") : "群名（不填就用成员的名字）"}
            maxLength={CHAT_NAME_MAX}
            editable={!busy}
            returnKeyType="done"
          />
        ) : null}
        <Text style={{ fontSize: 12, color: c.faint, textAlign: "right", marginTop: 2 }}>{counter}</Text>
      </DialogBody>
      <ScrollView style={{ maxHeight: 300, marginTop: 4 }} contentContainerStyle={{ paddingVertical: 2 }} keyboardShouldPersistTaps="handled">
        {hasAgents && hasPeople ? sectionTitle("智能体") : null}
        {options.map((id, i) => {
          const on = picked.includes(id);
          return row(`a:${id}`, <FaceTile slot={agentFaceSlot(ws, id)} size={36} />, agentNameOf(ws, id), on, !on && picked.length >= max, i === 0, () => toggle(id));
        })}
        {hasPeople ? sectionTitle(peopleLabel) : null}
        {(people ?? []).map((p, i) => {
          const on = pickedPeople.includes(p.uid);
          return row(`p:${p.uid}`, <PersonTile name={p.name} url={p.url} size={36} />, p.name, on, !on && pickedPeople.length >= maxPeople, i === 0, () => togglePerson(p.uid));
        })}
      </ScrollView>
      {error !== null ? (
        <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
          <Note tone="error">{error}</Note>
        </View>
      ) : null}
      <DialogFooter
        left={{ label: "取消", onPress: onClose, disabled: busy }}
        right={{ label: busy ? "正在做…" : okLabel, onPress: () => onOk(picked, name, pickedPeople), disabled: busy || !enough }}
      />
    </Dialog>
  );
}
