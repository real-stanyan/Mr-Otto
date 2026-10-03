// 智能体资料（#1386，demo 的 agentPage）：从通讯录、聊天里点它的头像进来。
// · 我主场里的：大头像 + 名字 +「智能体」+ 职责；那几行（AgentRows，点开改一格）；「发消息」「语音通话」。
// · 团队群里的 / 别人拉我进去的群里的（#1393，别人的）：只看——名字、「X 的智能体」、职责、在的群；
//   注脚「在群里 @ 它就行，干活走 X 的额度」。
//   改不了、也私聊不了（demo 同款：智能体归群主管）。
// 删一只在它私聊的「聊天信息」里（demo 同款），不在这里。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Pressable, ScrollView, Text, View } from "react-native";
import { workspaceAgentActivity } from "../../../src/shared/agentActivityRows.js";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { teamChatTitle } from "../../../src/shared/wechatInbox.js";
import { labelOf } from "../../../src/shared/workspaceView.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { ActivityFace } from "../activity/ActivityFace.js";
import { useActivity } from "../activity/activityStore.js";
import { useHome } from "../home/homeStore.js";
import { useTeams } from "../inbox/teamsStore.js";
import type { RootStackParams } from "../nav/types.js";
import { usePalette } from "../theme.js";
import { Group, Row, useNow } from "../ui.js";
import { useVoice, voiceUsable } from "../voice/voiceStore.js";
import { Icon, type IconName } from "../wx/Icon.js";
import { AgentRows } from "./AgentRows.js";

type Props = NativeStackScreenProps<RootStackParams, "Agent">;

/** 资料页顶上那一大块（demo 的 .card-head） */
export function CardHead({ avatar, name, tag, sub }: { avatar: React.ReactNode; name: string; tag: string; sub: string }) {
  const { c } = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 16, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 24, backgroundColor: c.card }}>
      {avatar}
      <View style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 22, fontWeight: "600", letterSpacing: -0.3, color: c.foreground }}>{name}</Text>
          <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5, backgroundColor: c.field }}>
            <Text style={{ fontSize: 11, fontWeight: "500", color: c.mutedForeground }}>{tag}</Text>
          </View>
        </View>
        {sub !== "" ? <Text style={{ fontSize: 14, lineHeight: 21, color: c.mutedForeground, marginTop: 6 }}>{sub}</Text> : null}
      </View>
    </View>
  );
}

/** 资料页底下那几颗居中的动作（demo 的 .mrow.center）：「发消息」「语音通话」 */
export function CenterAction({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [{ height: 54, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: c.card }, pressed && { backgroundColor: c.press }]}
    >
      <Icon name={icon} size={20} stroke={1.8} color={c.brand} />
      <Text style={{ fontSize: 17, fontWeight: "500", color: c.brand }}>{label}</Text>
    </Pressable>
  );
}

function TeamAgent({ ws, agent, groups }: { ws: WorkspaceSnapshot; agent: WorkspaceAgentRow; groups: string }) {
  const { c } = usePalette();
  const activity = useActivity();
  const now = useNow(30_000);
  const owner = labelOf(ws, ws.ownerUid);
  return (
    <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 40 }}>
      <CardHead
        avatar={
          <ActivityFace
            slot={agentFaceSlot(ws, agent.agentId)}
            size={68}
            radius={12}
            idle="alive"
            phase={facePhase(agent.agentId)}
            activity={workspaceAgentActivity(activity.rows, ws.id, agent.agentId, now)}
            ring={c.card}
            badgeSize={13}
          />
        }
        name={agent.name}
        tag={`${owner}的智能体`}
        sub={agent.description}
      />
      <Group footer={`它是${owner}的智能体：在群里 @ 它就行，干活走${owner}的额度。`}>
        <Row label="在的群" value={groups === "" ? "没有" : groups} />
      </Group>
    </ScrollView>
  );
}

export function AgentScreen({ route, navigation }: Props) {
  const { agentId, workspaceId } = route.params;
  const { c } = usePalette();
  const activity = useActivity();
  const now = useNow(30_000);
  const home = useHome();
  const teams = useTeams();
  const voice = useVoice();
  if (workspaceId !== undefined) {
    const team = teams.teams.find((t) => t.ws.id === workspaceId) ?? null;
    // 别人主场里拉我进去的群（#1393）：它只在那几条群里，每条群的快照各带那几只
    if (team === null) {
      const mine = teams.guests.filter((g) => g.ws.id === workspaceId && g.ws.agents.some((a) => a.agentId === agentId));
      const first = mine[0];
      const agent = first?.ws.agents.find((a) => a.agentId === agentId) ?? null;
      if (first === undefined || agent === null) {
        return <View style={{ flex: 1, backgroundColor: c.background, padding: 24 }}><Text style={{ color: c.mutedForeground }}>{teams.loaded ? "这只智能体已经不在了。" : ""}</Text></View>;
      }
      const groups = mine.filter((g) => !g.session.archived && g.outreach !== true).map((g) => g.session.title).filter((t) => t.trim() !== "").join("、");
      return <View style={{ flex: 1, backgroundColor: c.background }}><TeamAgent ws={first.ws} agent={agent} groups={groups} /></View>;
    }
    const agent = team.ws.agents.find((a) => a.agentId === agentId) ?? null;
    if (agent === null) {
      return <View style={{ flex: 1, backgroundColor: c.background, padding: 24 }}><Text style={{ color: c.mutedForeground }}>{teams.loaded ? "这只智能体已经不在了。" : ""}</Text></View>;
    }
    const groups = team.sessions.filter((s) => !s.archived).map((s) => teamChatTitle(team.ws, s)).join("、");
    return <View style={{ flex: 1, backgroundColor: c.background }}><TeamAgent ws={team.ws} agent={agent} groups={groups} /></View>;
  }
  const ws = home.home;
  const agent = ws?.agents.find((a) => a.agentId === agentId) ?? null;
  if (ws === null || agent === null) {
    return <View style={{ flex: 1, backgroundColor: c.background, padding: 24 }}><Text style={{ color: c.mutedForeground }}>{home.loaded ? "这只智能体已经不在了。" : ""}</Text></View>;
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 40 }}>
        <CardHead
          avatar={
            <ActivityFace
              slot={agentFaceSlot(ws, agentId)}
              size={68}
              radius={12}
              idle="alive"
              phase={facePhase(agentId)}
              activity={workspaceAgentActivity(activity.rows, ws.id, agentId, now)}
              ring={c.card}
              badgeSize={13}
            />
          }
          name={agent.name}
          tag="智能体"
          sub={agent.description}
        />
        <AgentRows ws={ws} agent={agent} />
        <View>
          <CenterAction icon="message-circle" label="发消息" onPress={() => navigation.navigate("Chat", { kind: "agent", agentId })} />
          {voiceUsable(voice) ? (
            <>
              <View style={{ height: 0.5, backgroundColor: c.border, marginLeft: 16 }} />
              <CenterAction icon="phone" label="语音通话" onPress={() => navigation.navigate("Chat", { kind: "agent", agentId, autoCall: true })} />
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
