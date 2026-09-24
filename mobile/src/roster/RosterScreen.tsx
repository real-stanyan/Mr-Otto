// 名册（根，#1356 A1，spec §5.2）。
//
// · 头：左 = 账号；右 = 搜索（＋ 在 A2——点了什么都不发生的钮是撒谎的勾，#722）。没有大标题，
//   圆钮浮在内容上，列表从底下滚过去（spec §4）。
// · 进门七态照搬 rosterGate：还没查到 / 正在建主场 → 骨架、**不劝订阅**；没订阅 / 档位不带 →
//   一句实话、不画钮（A5 之前手机上办不了订阅）；建失败 → 原因 + 重试钮、不自动重试；
//   **有主场就进得去、不再看档位**（降了档的人的聊天记录还在）。
// · 一列：主场的智能体 + 群混排、按最近一次动静降序（判据在 shared/mobileRoster.ts）。
// · 刷新：进前台、从聊天页退回来（focus）、建 / 删之后（那几处自己调）。不轮询。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, FlatList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { rosterGate, type RosterGate } from "../../../src/shared/agentRoster.js";
import { filterRosterItems, rosterItems, type RosterItem } from "../../../src/shared/mobileRoster.js";
import { workspaceAccess } from "../../../src/shared/workspaceAccess.js";
import { SearchGlyph } from "../chrome/Glyphs.js";
import { ROUND_BUTTON_SIZE, RoundButton } from "../chrome/RoundButton.js";
import { ensureHome, refreshHome, useHome } from "../home/homeStore.js";
import { space, type as t, usePalette, withAlpha } from "../theme.js";
import { Button, Field, Note } from "../ui.js";
import { AccountButton } from "./AccountButton.js";
import { RosterRow } from "./RosterRow.js";

/** 还没查到 / 正在建时的骨架：四行灰块，形状与真行一致（脸 59×52 + 两行字） */
function Skeleton() {
  const { c } = usePalette();
  const block = withAlpha(c.foreground, 0.07);
  return (
    <View accessibilityLabel="正在读取名册" style={{ gap: 4 }}>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 10 }}>
          <View style={{ width: 59, height: 52, borderRadius: 14, backgroundColor: block }} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={{ width: "46%", height: 14, borderRadius: 7, backgroundColor: block }} />
            <View style={{ width: "72%", height: 12, borderRadius: 6, backgroundColor: block }} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** 名册之外的那几态。只说实话：该给钮的地方给钮，给不出有去处的钮就不画 */
function GateView({ gate, ensureError, loadError }: { gate: RosterGate; ensureError: string | null; loadError: string | null }) {
  const { c } = usePalette();
  const say = (lead: string, hint: string) => (
    <View style={{ paddingHorizontal: space.lg, gap: space.xs }}>
      <Text style={{ ...t.headline, color: c.foreground }}>{lead}</Text>
      <Text style={{ ...t.callout, color: c.mutedForeground }}>{hint}</Text>
    </View>
  );
  switch (gate) {
    case "no_subscription":
      return say("订阅 Pro 或 Max 之后才建得了智能体。", "订阅在电脑上的 Mr Otto 里办，办好回来就能用。");
    case "plan_too_low":
      return say("你现在的订阅档位建不了智能体，Pro 或 Max 才行。", "换档在电脑上的 Mr Otto 里办。");
    case "failed":
      return (
        <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
          <Note tone="error">{ensureError ?? "没能建好你的智能体空间。"}</Note>
          <Button size="auto" variant="outline" label="重试" onPress={() => void ensureHome()} />
        </View>
      );
    default:
      // unknown / ensuring / signed_out：画骨架，不下任何结论；读不到的那句挂在上面 + 一颗重试
      return (
        <View style={{ gap: space.md }}>
          {loadError !== null ? (
            <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
              <Note tone="warn">{loadError}</Note>
              <Button size="auto" variant="outline" label="重试" onPress={() => void refreshHome()} />
            </View>
          ) : null}
          <Skeleton />
        </View>
      );
  }
}

export function RosterScreen() {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const home = useHome();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");

  useFocusEffect(
    useCallback(() => {
      void refreshHome();
    }, []),
  );
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void refreshHome();
    });
    return () => sub.remove();
  }, []);

  const access = workspaceAccess({ signedIn: true, billing: home.billing });
  const gate: RosterGate = home.loaded ? rosterGate({ access, home: home.home, ensure: home.ensure }) : "unknown";
  // 档位带、主场还没有 → 自己去建（建失败不自动重试，那一颗钮要人点）
  useEffect(() => {
    if (gate === "ensuring" && home.ensure === "idle") void ensureHome();
  }, [gate, home.ensure]);

  const items = useMemo(
    () => (home.home !== null && home.selfUid !== null
      ? rosterItems({ home: home.home, chats: home.chats, lasts: home.lasts, selfUid: home.selfUid })
      : []),
    [home.home, home.chats, home.lasts, home.selfUid],
  );
  const shown = useMemo(() => filterRosterItems(items, query), [items, query]);
  const now = Date.now();
  const headerSpace = insets.top + 8 + ROUND_BUTTON_SIZE + 8;

  const open = (item: RosterItem): void => {
    navigation.navigate("Chat", item.kind === "agent" ? { kind: "agent", agentId: item.agentId } : { kind: "group", sessionId: item.sessionId });
  };
  const closeSearch = (): void => {
    setSearching(false);
    setQuery("");
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {gate === "ready" ? (
        <FlatList
          data={shown}
          keyExtractor={(it) => it.key}
          renderItem={({ item }) => <RosterRow item={item} now={now} onPress={() => open(item)} />}
          contentContainerStyle={{ paddingTop: headerSpace, paddingBottom: insets.bottom + space.xl }}
          ListHeaderComponent={
            home.loadError !== null ? (
              // 读不到 ≠ 空：旧的名册照画，失败那句挂在上面
              <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm }}>
                <Note tone="warn">{home.loadError}</Note>
                <Button size="auto" variant="outline" label="重试" onPress={() => void refreshHome()} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            query.trim() !== "" ? (
              <Text style={{ ...t.callout, color: c.mutedForeground, textAlign: "center", marginTop: space.xl }}>
                {`没有找到「${query.trim()}」`}
              </Text>
            ) : null
          }
          ListFooterComponent={
            __DEV__ ? (
              <View style={{ padding: space.lg }}>
                <Button variant="quiet" label="形象陈列馆（开发用）" onPress={() => navigation.navigate("FaceGallery")} />
              </View>
            ) : null
          }
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        />
      ) : (
        <View style={{ paddingTop: headerSpace }}>
          <GateView gate={gate} ensureError={home.ensureError} loadError={home.loadError} />
        </View>
      )}

      {/* demo 的 .pillnav：状态栏下 8pt、左右 12pt，没有实心导航条 */}
      <View
        pointerEvents="box-none"
        style={{ position: "absolute", top: 0, left: 0, right: 0, paddingTop: insets.top + 8, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 10 }}
      >
        {searching ? (
          <>
            <View style={{ flex: 1 }}>
              <Field value={query} onChangeText={setQuery} placeholder="搜名字、职责、最后一句" autoFocus returnKeyType="search" />
            </View>
            <Button size="auto" variant="plain" label="取消" onPress={closeSearch} />
          </>
        ) : (
          <>
            <AccountButton onPress={() => navigation.navigate("Account")} />
            <View style={{ flex: 1 }} />
            {gate === "ready" ? (
              <RoundButton label="搜索" onPress={() => setSearching(true)}>
                <SearchGlyph color={c.foreground} />
              </RoundButton>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}
