// 添加朋友（#1386，demo 的 addFriendDialog）：居中弹窗——填名字或邮箱，边打边搜（300ms 攒一下），
// 结果一行一个人，右边一颗「加」。已经是朋友 / 已经在等对方同意的，那颗钮换成一句实话，不给一颗点了必然
// 撞唯一约束的钮（#722）。自己不在结果里（friendsApi.searchProfiles 排掉了）。
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { FriendProfile } from "../../../src/shared/friends.js";
import { FRIEND_TIERS, REQUEST_DEFAULT_TIER, TIER_DESC, TIER_LABEL, type FriendTier } from "../../../src/shared/friendTier.js";
import { friendName } from "../../../src/shared/wechatInbox.js";
import { Dialog, DialogBody, DialogLead, DialogTitle } from "../dialog.js";
import { usePalette } from "../theme.js";
import { Button, Field, Spinner } from "../ui.js";
import { PersonTile } from "../wx/Avatar.js";
import { toast } from "../wx/toast.js";
import { searchProfiles } from "./friendsApi.js";
import { addFriend, AlreadyLinked, useFriends } from "./friendsStore.js";

export function AddFriendDialog({ visible, onClose, onExited }: { visible: boolean; onClose: () => void; onExited?: () => void }) {
  const { c } = usePalette();
  const friends = useFriends();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<FriendProfile[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term === "") {
      setResults(null);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      searchProfiles(term)
        .then((r) => {
          // 词变了：上一次的结果作废（慢的旧请求不许盖掉新结果）
          if (mine === seq.current) setResults(r);
        })
        .catch((e: unknown) => {
          if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (mine === seq.current) setSearching(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  const statusOf = (id: string): "friend" | "pending" | null => {
    const r = friends.rows?.find((x) => x.profile.id === id);
    if (r === undefined) return null;
    return r.status === "accepted" ? "friend" : "pending";
  };

  // 发请求时选我给 TA 的那一档（#1494），默认仅聊天；生效看两边的最小值
  const [tier, setTier] = useState<FriendTier>(REQUEST_DEFAULT_TIER);
  const add = async (p: FriendProfile): Promise<void> => {
    setBusyId(p.id);
    setError(null);
    try {
      await addFriend(p.id, tier);
      toast(`申请发给「${friendName(p)}」了，对方同意了就会出现在朋友里`);
    } catch (e) {
      setError(e instanceof AlreadyLinked ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog visible={visible} wide {...(onExited === undefined ? {} : { onExited })}>
      <DialogTitle>添加朋友</DialogTitle>
      <DialogLead>填对方的名字或邮箱。加了朋友才能私聊、把你的应用借给 TA 用。</DialogLead>
      <DialogBody>
        <Field variant="dialog" value={q} onChangeText={setQ} placeholder="名字或邮箱" autoFocus keyboardType="email-address" returnKeyType="search" />
      </DialogBody>
      <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 20, paddingTop: 10, flexWrap: "wrap" }}>
        {FRIEND_TIERS.map((t) => (
          <Pressable
            key={t}
            accessibilityRole="button"
            accessibilityState={{ selected: tier === t }}
            onPress={() => setTier(t)}
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: tier === t ? c.primary : c.inputBg }}
          >
            <Text style={{ fontSize: 13, color: tier === t ? c.primaryForeground : c.foreground }}>{TIER_LABEL[t]}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={{ fontSize: 12, lineHeight: 17, color: c.mutedForeground, paddingHorizontal: 20, paddingTop: 6 }}>{TIER_DESC[tier]} 这是你给 TA 的权限，真正生效的是你们俩里低的那一档；加了之后在 TA 的资料页能改。</Text>
      <ScrollView style={{ maxHeight: 260, marginTop: 8 }} keyboardShouldPersistTaps="handled">
        {searching && results === null ? (
          <View style={{ padding: 16 }}><Spinner /></View>
        ) : results !== null && results.length === 0 ? (
          <Text style={{ fontSize: 14, color: c.mutedForeground, textAlign: "center", padding: 16 }}>{`没有找到「${q.trim()}」`}</Text>
        ) : (
          (results ?? []).map((p) => {
            const st = statusOf(p.id);
            return (
              <View key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 8 }}>
                <PersonTile name={friendName(p)} url={p.avatarUrl} size={40} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontSize: 16, color: c.foreground }}>{friendName(p)}</Text>
                  {p.email !== "" ? <Text numberOfLines={1} style={{ fontSize: 13, color: c.mutedForeground }}>{p.email}</Text> : null}
                </View>
                {st === "friend" ? (
                  <Text style={{ fontSize: 13, color: c.mutedForeground }}>已是朋友</Text>
                ) : st === "pending" ? (
                  <Text style={{ fontSize: 13, color: c.mutedForeground }}>等对方同意</Text>
                ) : (
                  <Button size="sm" variant="primary" label={busyId === p.id ? "…" : "加"} disabled={busyId !== null} onPress={() => void add(p)} />
                )}
              </View>
            );
          })
        )}
      </ScrollView>
      {error !== null ? <Text style={{ fontSize: 13, color: c.destructive, textAlign: "center", paddingHorizontal: 20, paddingTop: 8 }}>{error}</Text> : null}
      {/* 只有一个出口（加谁是在行上点的），所以不是「取消 / 做」那一排 */}
      <View style={{ paddingHorizontal: 20, paddingTop: 12 }}>
        <Button size="dialog" variant="secondary" label="完成" onPress={onClose} />
      </View>
    </Dialog>
  );
}
