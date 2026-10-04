// 私聊里的名片（#1524）：联系人名片画头像 + 名字 + 邮箱，智能体名片画脸 + 名字 + 职责；底下一颗钮——
// 「加为朋友」（走现成的好友请求，先选我给 TA 的档位，#1494）/「发消息」/「接受」（在我主场里复制出一只：新 id、我的电脑跑、
// 我的额度；记忆与连接器不带）。判据（抬头 / 钮画不画、画哪种）在 shared/contactCard.ts 的 contactCardView，这里只接线。
// 接受过只记在本机这一次会话里（刷新就没了）：再按一次会再建一只同名的——建之前查一次名单，同名就说已有。
import * as ExpoCrypto from "expo-crypto";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { agentIdFromBytes, createAgentChecked } from "../../../src/shared/agentAdmin.js";
import { voiceChoiceOf } from "../../../src/shared/agentVoice.js";
import { contactCardView, type ContactCard } from "../../../src/shared/contactCard.js";
import { REQUEST_DEFAULT_TIER, type FriendTier } from "../../../src/shared/friendTier.js";
import { insertAgentRow, listAgentNames, updateAgentRow } from "../../../src/shared/supabaseWorkspacesApi.js";
import { refreshHomeAfterWrite, useHome } from "../home/homeStore.js";
import { supabase } from "../supabase.js";
import { usePalette, withAlpha } from "../theme.js";
import { FaceTile, PersonTile } from "../wx/Avatar.js";
import { Icon } from "../wx/Icon.js";
import { toast } from "../wx/toast.js";
import { addFriend, AlreadyLinked, useFriends } from "./friendsStore.js";
import { TierPickDialog } from "./TierPickDialog.js";

export function ContactCardBubble({ card, mine, fromName, onOpenChat }: {
  card: ContactCard;
  mine: boolean;
  fromName: string;
  /** 「发消息」：去那位朋友的私聊 */
  onOpenChat: (uid: string) => void;
}) {
  const { c } = usePalette();
  const friends = useFriends();
  const home = useHome();
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<{ key: number; visible: boolean } | null>(null);
  const selfUid = friends.uid ?? home.selfUid ?? "";
  const friendUids = (friends.rows ?? []).filter((r) => r.status === "accepted").map((r) => r.profile.id);
  const v = contactCardView(card, { mine, fromName, selfUid, friendUids, accepted });

  const acceptAgent = async (): Promise<void> => {
    if (card.kind !== "agent") return;
    const ws = home.home;
    if (ws === null || selfUid === "") {
      setError("还没找到你的主场，稍后再试");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const agentId = agentIdFromBytes(ExpoCrypto.getRandomBytes(6));
      await createAgentChecked({ listAgentNames, insertAgentRow }, supabase, ws.id, selfUid, agentId, {
        name: card.name, description: card.description, instructions: card.instructions, models: [], tools: [], avatarSlot: card.avatarSlot,
      });
      // 声音另写一笔、尽力而为：认不出的键 / 0042 没跑都当没挑过，这只已经建成了
      if (card.voice !== undefined && voiceChoiceOf(card.voice) !== null) {
        await updateAgentRow(supabase, ws.id, agentId, { voice: card.voice }).catch(() => {});
      }
      setAccepted(true);
      toast(`「${card.name}」已保存到我的智能体`);
      void refreshHomeAfterWrite();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addPerson = async (tier: FriendTier): Promise<void> => {
    if (card.kind !== "person") return;
    setBusy(true);
    setError(null);
    try {
      await addFriend(card.uid, tier);
      toast(`申请发给「${card.name}」了，对方同意了就会出现在朋友里`);
      setPicking((p) => (p === null ? p : { ...p, visible: false }));
    } catch (e) {
      setError(e instanceof AlreadyLinked ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onAction = (): void => {
    if (busy) return;
    if (v.action.kind === "open_chat" && card.kind === "person") onOpenChat(card.uid);
    else if (v.action.kind === "add_friend") { setError(null); setPicking({ key: Date.now(), visible: true }); }
    else if (v.action.kind === "accept_agent") void acceptAgent();
  };

  return (
    <View style={{ width: 260, borderRadius: 12, backgroundColor: c.card, borderWidth: 0.5, borderColor: c.border, overflow: "hidden" }}>
      <View style={{ padding: 12, gap: 8 }}>
        <Text style={{ fontSize: 12, color: c.mutedForeground }}>{v.heading}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {card.kind === "person" ? <PersonTile name={card.name} url={card.avatarUrl} size={44} /> : <FaceTile slot={card.avatarSlot ?? 0} size={44} />}
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: "600", color: c.foreground }}>{v.title}</Text>
            {v.subtitle !== "" ? <Text numberOfLines={2} style={{ fontSize: 13, color: c.mutedForeground }}>{v.subtitle}</Text> : null}
          </View>
        </View>
        {error !== null ? <Text style={{ fontSize: 12, color: c.destructive }}>{error}</Text> : null}
      </View>
      <View style={{ borderTopWidth: 0.5, borderTopColor: c.border, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name={card.kind === "person" ? "user-round" : "sparkles"} size={12} stroke={2} color={c.faint} />
          <Text style={{ fontSize: 11, color: c.faint }}>{card.kind === "person" ? "联系人名片" : "智能体名片"}</Text>
        </View>
        {v.action.kind !== "none" ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onAction}
            style={({ pressed }) => [{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8, backgroundColor: withAlpha(c.brand, 0.12) }, (pressed || busy) && { opacity: 0.6 }]}
          >
            <Text style={{ fontSize: 13, fontWeight: "600", color: c.brand }}>{busy ? "…" : v.action.label}</Text>
          </Pressable>
        ) : v.action.label !== "" ? (
          <Text style={{ fontSize: 12, color: c.mutedForeground }}>{v.action.label}</Text>
        ) : null}
      </View>
      {picking !== null && card.kind === "person" ? (
        <TierPickDialog
          key={picking.key}
          visible={picking.visible}
          title={`加「${card.name}」为朋友`}
          lead="先选你给 TA 的权限，对方同意时也会选一档。"
          initial={REQUEST_DEFAULT_TIER}
          okLabel="发送申请"
          busy={busy}
          error={error}
          onOk={(tier) => void addPerson(tier)}
          onClose={() => setPicking((p) => (p === null ? p : { ...p, visible: false }))}
          onExited={() => setPicking(null)}
        />
      ) : null}
    </View>
  );
}
