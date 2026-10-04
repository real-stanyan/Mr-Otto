// 「带进来的智能体」那一组（#1523）：朝向一行（仅我可见 / 公开给 TA）+ 底下一句说明；点开 LaneFacingDialog 切。
// 朋友私聊的「聊天信息」页挂它（同 FriendTierRows 的做法：状态自己管）。没有车道（还没带过）时不画——没有东西可切。
import { useState } from "react";
import { LANE_FACING_DESC, LANE_FACING_LABEL, type PairFacing } from "../../../src/shared/pairChat.js";
import { friendName } from "../../../src/shared/wechatInbox.js";
import { useHome } from "../home/homeStore.js";
import { Group, Row } from "../ui.js";
import type { FriendRow } from "./friendsApi.js";
import { LaneFacingDialog } from "./LaneFacingDialog.js";
import { setLaneFacing, usePairLane } from "./pairLane.js";

export function LaneFacingRows({ row }: { row: FriendRow }) {
  const home = useHome();
  const lane = usePairLane(row.profile.id);
  const [picking, setPicking] = useState<{ key: number; visible: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const homeId = home.home?.id ?? null;
  if (homeId === null || lane.status !== "ready") return null;
  const name = friendName(row.profile);
  const facing: PairFacing = lane.facing;
  return (
    <>
      <Group footer={LANE_FACING_DESC[facing]}>
        <Row label="带进来的智能体" value={LANE_FACING_LABEL[facing]} chevron onPress={() => { setError(null); setPicking({ key: Date.now(), visible: true }); }} />
      </Group>
      {picking !== null ? (
        <LaneFacingDialog
          key={picking.key}
          visible={picking.visible}
          title="带进来的智能体"
          lead={`你带进和 ${name} 私聊的智能体，给谁看。`}
          initial={facing}
          okLabel="保存"
          busy={busy}
          error={error}
          onOk={(f) => {
            void (async () => {
              setBusy(true);
              setError(null);
              const r = await setLaneFacing(homeId, row.profile.id, f);
              setBusy(false);
              if (!r.ok) {
                setError(r.message);
                return;
              }
              setPicking((p) => (p === null ? p : { ...p, visible: false }));
            })();
          }}
          onClose={() => setPicking((p) => (p === null ? p : { ...p, visible: false }))}
          onExited={() => setPicking(null)}
        />
      ) : null}
    </>
  );
}
