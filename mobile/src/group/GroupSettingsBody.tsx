// 群设置的正文（#1356 A3，spec §5.6）：群名 / 里面有谁（每行「移出」）/ 加一只 / 解散这个群。受控：
// 名字草稿与各个动作的进行状态住在调用方（GroupSettingsScreen 接线）——正文不碰导航与数据层，冒烟时拿假数据就能摆出来。
// · 名单当场生效（移出 / 加一只各发一次 chat_update，发的是变动之后的完整名单）；群名要按「存」
//   （原生导航条右边）——两格分开发：只改名时不把名单一起发过去，那等于替人声明「那一格我也确认是
//   这个值」（同桌面群设置 ②）。
// · 最后一只也移得走：空群合法（ADR-0297 的 0..6）——删一只智能体不该连坐删掉它待过的群。
// · 「加一只」满六只 / 名册里没有别的了就按不动，原因写在那一行右边（#722：不画一颗点了必然被拒的钮）。
// · 一次只做一件事：有一个动作在路上时别的钮都按不动（两条 chat_update 前后脚发出去，后到的那份名单
//   会把先到的覆盖回去）。
import { ScrollView, Text, View } from "react-native";
import { CHAT_NAME_MAX } from "../../../src/shared/chatRoster.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { PlusGlyph } from "../chrome/Glyphs.js";
import { space, type as t, usePalette } from "../theme.js";
import { Button, Field, Group, Note, Row } from "../ui.js";
import { AgentPickRow } from "./AgentPickRow.js";

/** 解散那一组底下那一句（spec §5.6） */
export const DISSOLVE_FOOTER = "解散只删这条线，里面那几只都还在。";

export function GroupSettingsBody({
  ws, agentIds, name, onName, busy, removingId, addReason, error, onRemove, onAdd, onDissolve,
}: {
  ws: WorkspaceSnapshot;
  /** 此刻的名单（名册顺序、只含名册里还在的） */
  agentIds: string[];
  name: string;
  onName: (v: string) => void;
  /** 有一个动作在路上：别的钮都按不动 */
  busy: boolean;
  /** 正在移出的那一只（那一行的钮换字） */
  removingId: string | null;
  /** 「加一只」按不动的原因；null = 按得动 */
  addReason: string | null;
  error: string | null;
  onRemove: (agentId: string) => void;
  onAdd: () => void;
  onDissolve: () => void;
}) {
  const { c } = usePalette();
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xl }}
    >
      <View style={{ gap: space.xs }}>
        <Text style={{ ...t.footnote, color: c.mutedForeground, paddingHorizontal: 4 }}>群名</Text>
        <Field
          value={name}
          onChangeText={onName}
          placeholder="给这个群起个名字"
          maxLength={CHAT_NAME_MAX}
          editable={!busy}
          returnKeyType="done"
        />
      </View>

      <Group header="里面有谁" footer="移出之后它在群里说过的话还在，只是不再接这个群的活。">
        {agentIds.map((id) => (
          <AgentPickRow
            key={id}
            ws={ws}
            agentId={id}
            trailing={
              <Button
                size="sm"
                variant="outline"
                label={removingId === id ? "正在移…" : "移出"}
                disabled={busy}
                onPress={() => onRemove(id)}
              />
            }
          />
        ))}
        {agentIds.length === 0 ? <Row label="这个群里没有智能体了" /> : null}
        <Row
          label="加一只"
          tone="accent"
          leading={<PlusGlyph color={c.brand} size={13} />}
          {...(addReason === null ? {} : { value: addReason })}
          disabled={busy || addReason !== null}
          onPress={onAdd}
        />
      </Group>

      {error !== null ? <Note tone="error">{error}</Note> : null}

      <Group footer={DISSOLVE_FOOTER}>
        <Row label="解散这个群" tone="destructive" align="center" disabled={busy} onPress={onDissolve} />
      </Group>
    </ScrollView>
  );
}
