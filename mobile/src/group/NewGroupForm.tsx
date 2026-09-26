// 建群那一页的正文（#1356 A3，spec §5.6）：群名（可空）+ 名册一列（勾选）+ 组尾那一句。受控：名字与
// 勾选住在调用方（NewGroupScreen 把「建」挂在原生导航条右边）——正文不碰导航与数据层，冒烟时拿假数据就能摆出来。
// 判据全在 shared/groupEdit.ts：名册顺序、满六只时没勾的锁住（勾上的照样点得动）、群名留空用成员名拼。
// 群名那一格的占位字就是此刻勾选的那几只拼出来的名字——留空时发出去的正是它（一只都没勾时给个例子）。
import { ScrollView, Text, View } from "react-native";
import { CHAT_GROUP_MAX, CHAT_NAME_MAX } from "../../../src/shared/chatRoster.js";
import { groupNameFor, groupPick, pickLocked, togglePick } from "../../../src/shared/groupEdit.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { CheckGlyph } from "../chrome/Glyphs.js";
import { space, type as t, usePalette } from "../theme.js";
import { Field, Group, Note } from "../ui.js";
import { AgentPickRow } from "./AgentPickRow.js";

/** 组尾那一句（demo 的 newGroup） */
export const NEW_GROUP_FOOTER = "一只的「群」就是私聊，所以至少两只；最多六只。";

export function NewGroupForm({ ws, name, picked, busy, error, onName, onPicked }: {
  ws: WorkspaceSnapshot;
  name: string;
  picked: string[];
  /** 正在建：表单锁住 */
  busy: boolean;
  error: string | null;
  onName: (v: string) => void;
  onPicked: (ids: string[]) => void;
}) {
  const { c } = usePalette();
  const pick = groupPick(ws, picked);
  const placeholder = pick.ids.length > 0 ? groupNameFor(ws, pick.ids, "") : "比如「发版组」";
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xl }}
    >
      <View style={{ gap: space.xs }}>
        <Text style={{ ...t.footnote, color: c.mutedForeground, paddingHorizontal: 4 }}>群名 · 不填就用它们的名字拼</Text>
        <Field value={name} onChangeText={onName} placeholder={placeholder} maxLength={CHAT_NAME_MAX} editable={!busy} returnKeyType="done" />
      </View>
      <Group header={`把谁放进去 · 已选 ${pick.ids.length} / ${CHAT_GROUP_MAX}`} footer={NEW_GROUP_FOOTER}>
        {ws.agents.map((a) => {
          const on = pick.ids.includes(a.agentId);
          return (
            <AgentPickRow
              key={a.agentId}
              ws={ws}
              agentId={a.agentId}
              checked={on}
              disabled={busy || pickLocked(pick, a.agentId)}
              onPress={() => onPicked(togglePick(ws, picked, a.agentId))}
              trailing={
                <View style={{ width: 22, alignItems: "center", opacity: on ? 1 : 0 }}>
                  <CheckGlyph color={c.brand} />
                </View>
              }
            />
          );
        })}
      </Group>
      {error !== null ? <Note tone="error">{error}</Note> : null}
    </ScrollView>
  );
}
