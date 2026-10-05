// 朋友带来的智能体（#1653）：私聊页里点朋友的头像进来，只读。自己的头像进的是编辑页（LaneAgentsScreen，#1642）。
// · 公开给我的那几只：名字、脸、职责——在私聊里 @ 得到它们（代办入口只有 TA 的管理员，ADR-0363）
// · TA 的私人智能体：只知道几只，不知道是谁、说了什么（ADR-0346：在场只给一个数）
// 数据是私聊页那一刻给的快照（路由参数）：这一页压在私聊页上面，看的就是刚才头像底下那一排。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useLayoutEffect } from "react";
import { ScrollView, Text, View } from "react-native";
import { friendName } from "../../../src/shared/wechatInbox.js";
import type { RootStackParams } from "../nav/types.js";
import { usePalette } from "../theme.js";
import { Group, Row } from "../ui.js";
import { FaceTile } from "../wx/Avatar.js";
import { useFriends } from "./friendsStore.js";

type Props = NativeStackScreenProps<RootStackParams, "PeerLaneAgents">;

export function PeerLaneAgentsScreen({ route, navigation }: Props) {
  const { uid, agents, hidden } = route.params;
  const { c } = usePalette();
  const friends = useFriends();
  const row = friends.rows?.find((r) => r.profile.id === uid) ?? null;
  const name = row !== null ? friendName(row.profile) : "TA";
  useLayoutEffect(() => {
    navigation.setOptions({ title: `${name}带来的智能体` });
  }, [navigation, name]);
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ gap: 8, paddingTop: 8, paddingBottom: 40 }}>
        {agents.length > 0 ? (
          <Group header="公开给你的" footer={`在私聊里 @ 它就行。它动手时每一步都要${name}批，花的是${name}的额度。`} inset={16 + 32 + 12}>
            {agents.map((a) => (
              <Row
                key={a.agentId}
                label={a.name}
                {...(a.description !== "" ? { detail: a.description } : {})}
                leading={<FaceTile slot={a.slot} size={32} />}
              />
            ))}
          </Group>
        ) : null}
        {hidden > 0 ? (
          <Group header="私人的" footer={`只有${name}看得到它们说了什么，你也 @ 不到它们。`}>
            <Row label={`${hidden} 只私人智能体`} />
          </Group>
        ) : null}
        {agents.length === 0 && hidden === 0 ? (
          <Text style={{ fontSize: 14, color: c.mutedForeground, textAlign: "center", paddingTop: 40, paddingHorizontal: 32 }}>
            {`${name}还没带智能体进你们的私聊。`}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
