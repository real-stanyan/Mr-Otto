// 一张带状态的脸 + 右下角标（#1282）。通讯录、资料页共用：脸的表情与角标出自同一个 activity，
// 不会一个说在跑、一个说闲着。会话列表那一行走 SpecAvatar（九宫格每格各带各的），角标在 ChatListRow 里画。
// 不知道的时候画法同闲着（列表静止、大脸 alive），角标都不画 —— alive 不声称任何状态（ADR-0317 第 3 条）。
// 没有状态行（没跑过、0044 与 runtime 部署之前）的那只在资料页上照旧 alive，不退成静止。
import { View } from "react-native";
import { activityBadge, activityFace, type AgentActivity } from "../../../src/shared/agentActivity.js";
import type { FaceState } from "../../../src/shared/ottoFace/index.js";
import { StatusBadge } from "../wx/Badge.js";
import { FaceTile } from "../wx/Avatar.js";

export function ActivityFace({ slot, size, activity, ring, badgeSize, idle = "plain", radius, phase }: {
  slot: number;
  size: number;
  /** null = 不知道：脸画法同闲着（idle 那一格），不画角标 */
  activity: AgentActivity | null;
  /** 角标外圈的颜色 = 头像底下那一层的颜色 */
  ring: string;
  badgeSize: number;
  /** 闲着画哪张：列表 plain，单张大脸 alive */
  idle?: FaceState;
  radius?: number;
  phase?: number;
}) {
  const badge = activityBadge(activity);
  return (
    <View>
      <FaceTile
        slot={slot}
        size={size}
        state={activityFace(activity ?? "idle", idle)}
        {...(radius !== undefined ? { radius } : {})}
        {...(phase !== undefined ? { phase } : {})}
      />
      {badge !== null ? (
        <View style={{ position: "absolute", bottom: -3, right: -3 }}>
          <StatusBadge badge={badge} ring={ring} size={badgeSize} />
        </View>
      ) : null}
    </View>
  );
}
