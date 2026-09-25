// 名册（根，#1356 A1 / A2，spec §5.2 / §5.5）。
//
// · 头：左 = 账号；右 = 搜索、＋。没有大标题，圆钮浮在内容上，列表从底下滚过去（spec §4）。
// · 进门七态照搬 rosterGate：还没查到 / 正在建主场 → 骨架、**不劝订阅**；没订阅 / 档位不带 →
//   一句实话、不画钮（A5 之前手机上办不了订阅）；建失败 → 原因 + 重试钮、不自动重试；
//   **有主场就进得去、不再看档位**（降了档的人的聊天记录还在）。
// · 一列：主场的智能体 + 群混排、按最近一次动静降序（判据在 shared/mobileRoster.ts）。
// · ＋ 先问一句（居中弹窗、点外面能退）→「一只智能体」→ 70% 抽屉建一只 → 建成：名册刷新（新的
//   那一行放一段入场，首次渲染不算新来的）、抽屉退场放完再推它那条线（spec §5.5）。两个 Modal
//   不叠着出场：弹窗退场放完（onExited）才升抽屉。
// · 刷新：进前台、从聊天页退回来（focus）、建 / 删之后（那几处自己调）。不轮询。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { rosterGate, type RosterGate } from "../../../src/shared/agentRoster.js";
import { resolveChatTarget, type ChatTarget } from "../../../src/shared/mobileChat.js";
import { filterRosterItems, freshRosterKeys, rosterItems, type RosterItem } from "../../../src/shared/mobileRoster.js";
import { workspaceAccess } from "../../../src/shared/workspaceAccess.js";
import { NewAgentSheet } from "../agent/NewAgentSheet.js";
import { PlusGlyph, SearchGlyph } from "../chrome/Glyphs.js";
import { ROUND_BUTTON_SIZE, RoundButton } from "../chrome/RoundButton.js";
import { ensureHome, homeSnapshot, refreshHome, refreshHomeAfterWrite, useHome } from "../home/homeStore.js";
import { space, type as t, usePalette, withAlpha } from "../theme.js";
import { Button, Field, Note } from "../ui.js";
import { AccountButton } from "./AccountButton.js";
import { NewThingDialog } from "./NewThingDialog.js";
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
  /** ＋ 那张岔路弹窗开着没有 */
  const [fork, setFork] = useState(false);
  /** 弹窗退场放完之后要不要升抽屉（点的是「一只智能体」，不是取消 / 点外面） */
  const sheetAfterFork = useRef(false);
  /** 建一只那张抽屉。有值才画：每开一次换一个 key（= 重挂一次 = 新铸一个 id）；关的时候 visible
      先翻 false，退场放完（onExited）再卸 */
  const [sheet, setSheet] = useState<{ key: number; visible: boolean } | null>(null);
  /** 建成的那一只：等抽屉退场放完再推它那条线 */
  const created = useRef<string | null>(null);

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
  // 新来的那几行（放一段入场）：跟上一次画过的**整份**名单比（不是过滤后的——搜索框清空时重新露出来
  // 的那几行不是新来的）。上一次的名单在 effect 里推进、不在渲染里改 ref：StrictMode 下渲染跑两遍，
  // 边渲染边改的话第二遍就看不到差集，动效在 dev 里一次都不放（同桌面 A5 那条注释）
  const seenRows = useRef<{ homeId: string; keys: string[] } | null>(null);
  const homeId = home.home?.id ?? null;
  const fresh = useMemo(
    () => (homeId === null ? new Set<string>() : freshRosterKeys(seenRows.current, { homeId, keys: items.map((i) => i.key) })),
    [homeId, items],
  );
  useEffect(() => {
    seenRows.current = homeId === null ? null : { homeId, keys: items.map((i) => i.key) };
  }, [homeId, items]);
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
  /** 抽屉里那个「不建了」：可能已经落了一行（私聊没建成、人又不建了）——名册要看得见它 */
  const closeSheet = (): void => {
    setSheet((s) => (s === null ? s : { ...s, visible: false }));
    void refreshHomeAfterWrite();
  };
  /** 建成了：先把名册刷新（新的那一行带入场），再收抽屉；推它那条线等退场放完（onSheetExited） */
  const onCreated = async (agentId: string): Promise<void> => {
    await refreshHomeAfterWrite();
    created.current = agentId;
    setSheet((s) => (s === null ? s : { ...s, visible: false }));
  };
  const onSheetExited = (): void => {
    setSheet(null);
    const agentId = created.current;
    created.current = null;
    if (agentId === null) return;
    const h = homeSnapshot();
    const target: ChatTarget = { kind: "agent", agentId };
    // 名册没读回来（刷新失败）就不推：推进去是一页「这条聊天已经不在了」，而它明明在——
    // 名册顶上那句读不到的话 + 重试钮才是实话
    if (h.home === null || resolveChatTarget(h.home, h.chats, target) === null) return;
    navigation.navigate("Chat", target);
  };
  const ws = home.home;
  /** 「一个群聊」那一行左边那几张：名册里的前三只——这一选会生出来的，就是它们凑成的一条线 */
  const groupFaces = ws === null ? [] : ws.agents.slice(0, 3).map((a) => ({ id: a.agentId, slot: agentFaceSlot(ws, a.agentId) }));

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {gate === "ready" ? (
        <FlatList
          data={shown}
          keyExtractor={(it) => it.key}
          renderItem={({ item }) => <RosterRow item={item} now={now} fresh={fresh.has(item.key)} onPress={() => open(item)} />}
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
              <>
                <RoundButton label="搜索" onPress={() => setSearching(true)}>
                  <SearchGlyph color={c.foreground} />
                </RoundButton>
                <RoundButton label="新建" onPress={() => setFork(true)}>
                  <PlusGlyph color={c.foreground} />
                </RoundButton>
              </>
            ) : null}
          </>
        )}
      </View>

      <NewThingDialog
        visible={fork}
        groupFaces={groupFaces}
        onAgent={() => {
          sheetAfterFork.current = true;
          setFork(false);
        }}
        onDismiss={() => setFork(false)}
        onExited={() => {
          if (!sheetAfterFork.current) return;
          sheetAfterFork.current = false;
          setSheet({ key: Date.now(), visible: true });
        }}
      />
      {sheet !== null && ws !== null && home.selfUid !== null ? (
        <NewAgentSheet
          key={sheet.key}
          visible={sheet.visible}
          ws={ws}
          selfUid={home.selfUid}
          onClose={closeSheet}
          onCreated={onCreated}
          onExited={onSheetExited}
        />
      ) : null}
    </View>
  );
}
