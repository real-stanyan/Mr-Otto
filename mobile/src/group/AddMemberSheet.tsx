// 「加一只进来」（#1356 A3，spec §5.6）：群设置里「加一只」点开的底部抽屉，只列名册里还不在群里的；
// 点一只就加那一只（demo 的 addMember：点完抽屉就收）。加的时候抽屉锁住、每一行按不动，成了才收——
// 失败那句话留在抽屉里（先收掉就等于把「没加上」说成「加上了」）。满六只时这张抽屉根本打不开
// （「加一只」那一行按不动并写着为什么），所以这里不再判上限。
import { ScrollView, Text } from "react-native";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { space, type as t, usePalette } from "../theme.js";
import { Group, Note } from "../ui.js";
import { AgentPickRow } from "./AgentPickRow.js";

export function AddMemberSheet({ visible, ws, candidates, busyId, error, onPick, onClose, onExited }: {
  visible: boolean;
  ws: WorkspaceSnapshot;
  /** 名册里还不在群里的（groupEdit.addChoice） */
  candidates: WorkspaceAgentRow[];
  /** 正在加的那一只；null = 没在加 */
  busyId: string | null;
  error: string | null;
  onPick: (agentId: string) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  return (
    <BottomSheet
      visible={visible}
      title="加一只进来"
      locked={busyId !== null}
      onClose={onClose}
      {...(onExited === undefined ? {} : { onExited })}
    >
      <ScrollView contentContainerStyle={{ padding: space.md, gap: space.md }}>
        <Group footer="最多六只。">
          {candidates.map((a) => (
            <AgentPickRow
              key={a.agentId}
              ws={ws}
              agentId={a.agentId}
              disabled={busyId !== null}
              onPress={() => onPick(a.agentId)}
              trailing={busyId === a.agentId ? <Text style={{ ...t.footnote, color: c.mutedForeground }}>正在加…</Text> : null}
            />
          ))}
        </Group>
        {error !== null ? <Note tone="error">{error}</Note> : null}
      </ScrollView>
    </BottomSheet>
  );
}
