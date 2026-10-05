// 私聊里的应用分享卡（#1648）：发的人那边写「你分享了应用」；收的人那边「添加到我的应用」，添加过的变「打开」。
// 添加走控制房 RPC（app_accept）：runtime 现读这条私信、核对好友、把文件复制到你名下。
// 整张卡都能点（#1657）：发的人点开自己那份（原件就在自己名下）；收的人加过打开、没加过走添加。
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { appShareMarker, type AppShareCard } from "../../../src/shared/appCard.js";
import { cloudClient } from "../cloud/cloudClient.js";
import type { RootStackParams } from "../nav/types.js";
import { usePalette, withAlpha } from "../theme.js";
import { toast } from "../wx/toast.js";
import { refreshApps, useApps } from "./appsStore.js";

export function AppShareBubble({ card, mine, messageId }: { card: AppShareCard; mine: boolean; messageId: number }) {
  const { c } = usePalette();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const apps = useApps();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const added = apps.apps?.find((a) => a.createdByAgent === appShareMarker(card.appId)) ?? null;
  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const r = await cloudClient.appAccept(messageId);
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    toast(r.value.already ? "已经在你的应用里了" : `「${card.name}」加到你的应用里了`);
    await refreshApps();
    navigation.navigate("MiniApp", { appId: r.value.appId });
  };
  const open = (): void => {
    if (busy) return;
    if (mine) navigation.navigate("MiniApp", { appId: card.appId });
    else if (added !== null) navigation.navigate("MiniApp", { appId: added.id });
    else void add();
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`应用：${card.name}`}
      onPress={open}
      style={({ pressed }) => [{ width: 240, padding: 12, borderRadius: 12, backgroundColor: c.card, borderWidth: 0.5, borderColor: c.border, gap: 8 }, pressed && { opacity: 0.85 }]}
    >
      <Text style={{ fontSize: 12, color: c.mutedForeground }}>{mine ? "你分享了一个应用" : `${card.from.name} 分享了一个应用`}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ width: 44, height: 44, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(c.foreground, 0.06) }}>
          <Text style={{ fontSize: 24 }}>{card.icon}</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: "600", color: c.foreground }}>{card.name}</Text>
          {card.description !== "" ? <Text numberOfLines={2} style={{ fontSize: 12, color: c.mutedForeground }}>{card.description}</Text> : null}
        </View>
      </View>
      <View style={[{ height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: mine || added !== null ? withAlpha(c.foreground, 0.08) : c.brand }, busy && { opacity: 0.7 }]}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: mine || added !== null ? c.foreground : "#fff" }}>{busy ? "…" : mine || added !== null ? "打开" : "添加到我的应用"}</Text>
      </View>
      {error !== null ? <Text style={{ fontSize: 12, color: c.destructive }}>{error}</Text> : null}
    </Pressable>
  );
}
