// 朋友资料（#1386，demo 的 friendPage）：头像、名字 +「朋友」、邮箱；一起在的群（团队群里有 TA 的那几个）；「发消息」；
// 删除朋友（底下单独一行，居中确认）。demo 那一行「拉进群聊」不画：把朋友和你的智能体放进同一个群要改后端（spec §2）。
// 「借给 TA 用的应用」在电脑上管（手机管不了连接器），这里不画一颗点了没去处的钮。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { friendName, teamChatTitle } from "../../../src/shared/wechatInbox.js";
import { CardHead, CenterAction } from "../agent/AgentScreen.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { useTeams } from "../inbox/teamsStore.js";
import type { RootStackParams } from "../nav/types.js";
import { usePalette } from "../theme.js";
import { Group, Note, Row } from "../ui.js";
import { PersonTile } from "../wx/Avatar.js";
import { drop, useFriends } from "./friendsStore.js";

type Props = NativeStackScreenProps<RootStackParams, "Friend">;

export function FriendScreen({ route, navigation }: Props) {
  const { uid } = route.params;
  const { c } = usePalette();
  const friends = useFriends();
  const teams = useTeams();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const row = friends.rows?.find((r) => r.profile.id === uid) ?? null;
  if (row === null) {
    return <View style={{ flex: 1, backgroundColor: c.background, padding: 24 }}><Text style={{ color: c.mutedForeground }}>{friends.rows === null ? "" : "你们已经不是朋友了。"}</Text></View>;
  }
  const name = friendName(row.profile);
  const together = teams.teams
    .filter((t) => t.ws.members.some((m) => m.uid === uid))
    .flatMap((t) => t.sessions.filter((s) => !s.archived).map((s) => teamChatTitle(t.ws, s)));
  const accepted = row.status === "accepted";
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 40 }}>
        <CardHead avatar={<PersonTile name={name} url={row.profile.avatarUrl} size={68} radius={12} />} name={name} tag={accepted ? "朋友" : "等对方同意"} sub={row.profile.email} />
        <Group>
          <Row label="一起在的群" value={together.length === 0 ? "没有" : together.join("、")} />
        </Group>
        {accepted ? <CenterAction icon="message-circle" label="发消息" onPress={() => navigation.navigate("FriendChat", { uid })} /> : null}
        <Group>
          <Row label={accepted ? "删除朋友" : "撤回申请"} align="center" tone="destructive" onPress={() => { setError(null); setConfirm(true); }} />
        </Group>
      </ScrollView>
      <Dialog visible={confirm} onExited={() => { if (done.current) navigation.goBack(); }}>
        <DialogTitle>{accepted ? `删除「${name}」？` : "撤回这条申请？"}</DialogTitle>
        <DialogLead>{accepted ? "从此发不了消息；借给 TA 用的应用一起收回。" : "对方那边这条申请就没了。"}</DialogLead>
        {error !== null ? <View style={{ paddingHorizontal: 20 }}><Note tone="error">{error}</Note></View> : null}
        <DialogFooter
          left={{ label: "取消", onPress: () => setConfirm(false), disabled: busy }}
          right={{
            label: busy ? "正在做…" : accepted ? "删除" : "撤回",
            tone: "destructive",
            disabled: busy,
            onPress: () => {
              setBusy(true);
              drop(row.friendshipId)
                .then(() => { done.current = true; setConfirm(false); })
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            },
          }}
        />
      </Dialog>
    </View>
  );
}
