// 新的朋友（#1386，demo 的 requestsPage）：别人加我的在上面（接受 / 拒绝——那是这一屏唯一要人动手的东西）、我加别人的
// 在下面（等对方同意 / 撤回）。右上「添加朋友」。接受之后它就进了通讯录的「朋友」那一段，私聊从那里开。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useLayoutEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { friendName } from "../../../src/shared/wechatInbox.js";
import type { RootStackParams } from "../nav/types.js";
import { usePalette } from "../theme.js";
import { Button } from "../ui.js";
import { PersonTile } from "../wx/Avatar.js";
import { Icon } from "../wx/Icon.js";
import { HeaderIconButton } from "../wx/TabHeader.js";
import { toast } from "../wx/toast.js";
import { AddFriendDialog } from "./AddFriendDialog.js";
import { TierPickDialog } from "./TierPickDialog.js";
import { REQUEST_DEFAULT_TIER } from "../../../src/shared/friendTier.js";
import type { FriendRow } from "./friendsApi.js";
import { accept, drop, useFriends } from "./friendsStore.js";

type Props = NativeStackScreenProps<RootStackParams, "Requests">;

function Line({ r, right, first }: { r: FriendRow; right: React.ReactNode; first: boolean }) {
  const { c } = usePalette();
  const name = friendName(r.profile);
  return (
    <View style={{ backgroundColor: c.card }}>
      {first ? null : <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 76 }} />}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 72, paddingHorizontal: 16 }}>
        <PersonTile name={name} url={r.profile.avatarUrl} size={48} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text numberOfLines={1} style={{ fontSize: 17, color: c.foreground }}>{name}</Text>
          <Text numberOfLines={1} style={{ fontSize: 13, color: c.mutedForeground }}>{r.profile.email}</Text>
        </View>
        {right}
      </View>
    </View>
  );
}

export function RequestsScreen({ navigation }: Props) {
  const { c } = usePalette();
  const friends = useFriends();
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ key: number; visible: boolean } | null>(null);
  // 接受时选我给 TA 的那一档（#1494）：弹一张单选，选完才真的接受
  const [accepting, setAccepting] = useState<{ key: number; visible: boolean; r: FriendRow } | null>(null);
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderIconButton label="添加朋友" onPress={() => setAdding({ key: Date.now(), visible: true })}>
          <Icon name="user-round-plus" size={23} stroke={1.7} color={c.foreground} />
        </HeaderIconButton>
      ),
    });
  }, [navigation, c.foreground]);
  const rows = friends.rows ?? [];
  const incoming = rows.filter((r) => r.status === "pending" && r.direction === "incoming");
  const outgoing = rows.filter((r) => r.status === "pending" && r.direction === "outgoing");
  const act = (id: string, fn: () => Promise<void>, done: string): void => {
    setBusy(id);
    fn()
      .then(() => toast(done))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: 40, gap: 8 }}>
        {incoming.length === 0 && outgoing.length === 0 ? (
          <Text style={{ fontSize: 14, color: c.mutedForeground, textAlign: "center", paddingTop: 32 }}>没有新的申请。</Text>
        ) : null}
        {incoming.length > 0 ? (
          <View>
            <Text style={{ fontSize: 13, color: c.mutedForeground, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 }}>想加你的</Text>
            {incoming.map((r, i) => (
              <Line
                key={r.friendshipId}
                r={r}
                first={i === 0}
                right={
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    <Button size="sm" variant="quiet" label="拒绝" disabled={busy !== null} onPress={() => act(r.friendshipId, () => drop(r.friendshipId), "拒绝了")} />
                    <Button size="sm" variant="primary" label="接受" disabled={busy !== null} onPress={() => setAccepting({ key: Date.now(), visible: true, r })} />
                  </View>
                }
              />
            ))}
          </View>
        ) : null}
        {outgoing.length > 0 ? (
          <View>
            <Text style={{ fontSize: 13, color: c.mutedForeground, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 }}>你加的</Text>
            {outgoing.map((r, i) => (
              <Line
                key={r.friendshipId}
                r={r}
                first={i === 0}
                right={<Button size="sm" variant="quiet" label="撤回" disabled={busy !== null} onPress={() => act(r.friendshipId, () => drop(r.friendshipId), "撤回了")} />}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>
      {accepting !== null ? (
        <TierPickDialog
          key={accepting.key}
          visible={accepting.visible}
          title={`接受「${friendName(accepting.r.profile)}」`}
          lead="选一下你给 TA 的权限，之后在 TA 的资料页随时能改。"
          initial={REQUEST_DEFAULT_TIER}
          okLabel="接受"
          busy={busy !== null}
          onOk={(tier) => {
            const r = accepting.r;
            act(r.friendshipId, () => accept(r.friendshipId, tier), `你和「${friendName(r.profile)}」是朋友了`);
            setAccepting((a) => (a === null ? a : { ...a, visible: false }));
          }}
          onClose={() => setAccepting((a) => (a === null ? a : { ...a, visible: false }))}
          onExited={() => setAccepting(null)}
        />
      ) : null}
      {adding !== null ? <AddFriendDialog key={adding.key} visible={adding.visible} onClose={() => setAdding((a) => (a === null ? a : { ...a, visible: false }))} onExited={() => setAdding(null)} /> : null}
    </View>
  );
}
