// 好友权限那一组（#1494，ADR-0350）：我给 TA 的（可改）、TA 给我的（只读）、实际生效（两边取最小值）+ 底下一行说明；
// 点第一行弹 TierPickDialog。朋友资料页与朋友私聊的「聊天信息」页都挂它（维护者 2026-10-04：聊天信息页也要能改），
// 状态自己管，两处不用各写一遍。
import { useState } from "react";
import { TIER_DESC, TIER_LABEL } from "../../../src/shared/friendTier.js";
import { friendName } from "../../../src/shared/wechatInbox.js";
import { Group, Row } from "../ui.js";
import type { FriendRow } from "./friendsApi.js";
import { setTier } from "./friendsStore.js";
import { TierPickDialog } from "./TierPickDialog.js";

export function FriendTierRows({ row }: { row: FriendRow }) {
  const [picking, setPicking] = useState<{ key: number; visible: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = friendName(row.profile);
  return (
    <>
      <Group footer={TIER_DESC[row.tiers.effective]}>
        <Row label="我给 TA 的权限" value={TIER_LABEL[row.tiers.mine]} chevron onPress={() => { setError(null); setPicking({ key: Date.now(), visible: true }); }} />
        <Row label="TA 给我的权限" value={TIER_LABEL[row.tiers.theirs]} />
        <Row label="实际生效" value={TIER_LABEL[row.tiers.effective]} />
      </Group>
      {picking !== null ? (
        <TierPickDialog
          key={picking.key}
          visible={picking.visible}
          title="我给 TA 的权限"
          lead={`${name} 那边给你开到「${TIER_LABEL[row.tiers.theirs]}」。`}
          initial={row.tiers.mine}
          okLabel="保存"
          busy={busy}
          error={error}
          onOk={(tier) => {
            void (async () => {
              setBusy(true);
              setError(null);
              try {
                await setTier(row.friendshipId, row.direction, tier);
                setPicking((p) => (p === null ? p : { ...p, visible: false }));
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            })();
          }}
          onClose={() => setPicking((p) => (p === null ? p : { ...p, visible: false }))}
          onExited={() => setPicking(null)}
        />
      ) : null}
    </>
  );
}
