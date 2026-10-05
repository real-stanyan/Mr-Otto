// 私聊 ＋ 里「应用」（#1648）：挑一个我的应用，直接发给这位朋友一张应用卡（同名片那条路）。
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { encodeAppCard } from "../../../src/shared/appCard.js";
import { fetchAppVersion } from "../../../src/shared/appsApi.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { supabase } from "../supabase.js";
import { usePalette, withAlpha } from "../theme.js";
import { refreshApps, useApps } from "./appsStore.js";

export function AppPickSheet({ visible, selfUid, selfName, onSend, onClose, onExited }: {
  visible: boolean;
  selfUid: string;
  selfName: string;
  /** 发出去（调用方用 sendToFriend）；抛错 = 没发出去 */
  onSend: (body: string) => Promise<void>;
  onClose: () => void;
  onExited: () => void;
}) {
  const { c } = usePalette();
  const apps = useApps();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (visible) void refreshApps(); }, [visible]);
  const send = async (appId: string): Promise<void> => {
    const a = apps.apps?.find((x) => x.id === appId);
    if (a === undefined || busy !== null) return;
    setBusy(appId);
    setError(null);
    try {
      const v = await fetchAppVersion(supabase, a.id, a.currentVersion);
      if (v === null) throw new Error("这个应用的最新一版读不出来");
      await onSend(encodeAppCard({ appId: a.id, version: v.version, name: a.name, icon: a.icon, slug: a.slug, description: a.description, from: { uid: selfUid, name: selfName } }));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const list = (apps.apps ?? []).filter((a) => a.currentVersion >= 1);
  return (
    <BottomSheet visible={visible} title="发一个应用" onClose={onClose} onExited={onExited}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
        {apps.apps === null ? (
          <Text style={{ fontSize: 14, color: c.mutedForeground, textAlign: "center" }}>{apps.error ?? "正在读…"}</Text>
        ) : list.length === 0 ? (
          <Text style={{ fontSize: 14, lineHeight: 21, color: c.mutedForeground, textAlign: "center" }}>还没有应用。跟管理员说一句「给我做个记账本」就有了。</Text>
        ) : (
          list.map((a) => (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              accessibilityLabel={`发送 ${a.name}`}
              disabled={busy !== null}
              onPress={() => void send(a.id)}
              style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: 12, backgroundColor: withAlpha(c.foreground, 0.04) }, (pressed || busy === a.id) && { opacity: 0.6 }]}
            >
              <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(c.foreground, 0.08) }}>
                <Text style={{ fontSize: 24 }}>{a.icon}</Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={{ fontSize: 16, color: c.foreground }}>{a.name}</Text>
                {a.description !== "" ? <Text numberOfLines={1} style={{ fontSize: 12, color: c.mutedForeground }}>{a.description}</Text> : null}
              </View>
              <Text style={{ fontSize: 14, color: c.brand }}>{busy === a.id ? "…" : "发送"}</Text>
            </Pressable>
          ))
        )}
        {error !== null ? <Text style={{ fontSize: 13, color: c.destructive }}>{error}</Text> : null}
      </ScrollView>
    </BottomSheet>
  );
}
