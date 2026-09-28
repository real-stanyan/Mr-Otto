// 群聊（#1386，demo 的 groupsPage）：所有群一列——主场里你的群 + 有真人的群（团队里的每条会话）+ 别人拉你进去的群（#1393）；
// 右上「+」发起群聊（智能体和朋友都能拉，#1393）。点一行进那个群。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { CHAT_GROUP_CREATE_MIN } from "../../../src/shared/chatRoster.js";
import { mixedGroupName } from "../../../src/shared/chatGuests.js";
import { groupList } from "../../../src/shared/wechatInbox.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { PickAgentsDialog } from "../group/PickAgentsDialog.js";
import { friendPeople } from "../group/people.js";
import { useFriends } from "./friendsStore.js";
import { refreshHomeAfterWrite, useHome } from "../home/homeStore.js";
import { useTeams } from "../inbox/teamsStore.js";
import type { RootStackParams } from "../nav/types.js";
import { ContactRow } from "../tabs/ContactsScreen.js";
import { usePalette } from "../theme.js";
import { SpecAvatar } from "../wx/Avatar.js";
import { Icon } from "../wx/Icon.js";
import { HeaderIconButton } from "../wx/TabHeader.js";

type Props = NativeStackScreenProps<RootStackParams, "Groups">;

export function GroupsScreen({ navigation }: Props) {
  const { c } = usePalette();
  const home = useHome();
  const teams = useTeams();
  const friends = useFriends();
  const ws = home.home;
  const invitable = useMemo(() => friendPeople(friends.rows, new Set([home.selfUid ?? ""])), [friends.rows, home.selfUid]);
  const [picker, setPicker] = useState<{ key: number; visible: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const created = useRef<string | null>(null);
  const list = useMemo(
    () => groupList({ selfUid: home.selfUid ?? "", home: ws === null ? null : { ws, chats: home.chats, lasts: home.lasts }, teams: teams.teams, guests: teams.guests }),
    [home.selfUid, ws, home.chats, home.lasts, teams.teams, teams.guests],
  );
  const canNew = ws !== null && ws.agents.length + invitable.length >= CHAT_GROUP_CREATE_MIN;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () =>
        canNew ? (
          <HeaderIconButton label="发起群聊" onPress={() => { setError(null); setPicker({ key: Date.now(), visible: true }); }}>
            <Icon name="plus" size={24} stroke={1.8} color={c.foreground} />
          </HeaderIconButton>
        ) : null,
    });
  }, [navigation, canNew, c.foreground]);
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: 40 }}>
        {list.map((g, i) => (
          <ContactRow
            key={g.key}
            first={i === 0}
            avatar={<SpecAvatar spec={g.avatar} size={40} />}
            name={g.title}
            sub={g.members}
            onPress={() => navigation.navigate("Chat", g.target)}
          />
        ))}
        <Text style={{ fontSize: 13, lineHeight: 19, color: c.mutedForeground, padding: 16 }}>
          {list.length === 0 ? "还没有群。" : ""}
          群里的智能体归群主管，干活走群主的额度。
        </Text>
      </ScrollView>
      {picker !== null && ws !== null ? (
        <PickAgentsDialog
          key={picker.key}
          visible={picker.visible}
          ws={ws}
          title="发起群聊"
          lead="拉几位进来（智能体或朋友），凑够 2 位就能建。朋友让智能体动手要等你批。"
          options={ws.agents.map((a) => a.agentId)}
          min={CHAT_GROUP_CREATE_MIN}
          people={invitable}
          okLabel="建群"
          withName
          busy={busy}
          error={error}
          onOk={(picked, name, pickedPeople) => {
            setBusy(true);
            setError(null);
            const people = invitable.filter((p) => pickedPeople.includes(p.uid)).map((p) => ({ name: p.name }));
            cloudClient
              .create(ws.id, {
                kind: "group",
                name: mixedGroupName(ws, picked, people, name),
                agentIds: picked,
                ...(pickedPeople.length > 0 ? { humans: pickedPeople } : {}),
              })
              .then(async (r) => {
                if (!r.ok) throw new Error(r.message);
                await refreshHomeAfterWrite();
                created.current = r.value.sessionId;
                setPicker((p) => (p === null ? p : { ...p, visible: false }));
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
          onClose={() => setPicker((p) => (p === null ? p : { ...p, visible: false }))}
          onExited={() => {
            setPicker(null);
            const sid = created.current;
            created.current = null;
            if (sid !== null) navigation.navigate("Chat", { kind: "group", sessionId: sid });
          }}
        />
      ) : null}
    </View>
  );
}
