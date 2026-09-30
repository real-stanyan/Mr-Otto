// 接好之后那一页（#1430，spec §8，demo 定稿）：hero（方块 / 名字 / 说明 / 状态点）→ 过期时一行「重新登录」→
// 「它能做的」（先列 TOOLS_PREVIEW 个，其余收在「全部 N 个」里、原地展开）→「借给团队」（开关一拨就生效，不再确认；
// 组尾说清「以你的身份」）→「断开」（居中确认，右边那颗实底红）。
// 一律从云端视图画（useConnectors）；动过之后重拉。一个开关在路上时所有开关都锁住（两次授权写同一只箱，
// 并发的话后到的那次会盖掉先到的）。断开等确认弹窗退场放完再发——不在退场途中换页。
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useLayoutEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { MCP_CATALOG } from "../../../src/shared/mcpCatalog.js";
import {
  APP_GONE, DISCONNECT_LEAD, LEND_FOOTER, TOOLS_PREVIEW, allToolsLabel, appDetail, disconnectTitle, disconnectedToast,
  lendRows, lendToast, reloginToast, toolCountText,
} from "../../../src/shared/mobileConnectors.js";
import { ensureUid } from "../cloud/cloudClient.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { refreshHome, useHome } from "../home/homeStore.js";
import { refreshTeams, useTeams } from "../inbox/teamsStore.js";
import type { RootStackParams } from "../nav/types.js";
import { MONO, space, type as t, usePalette } from "../theme.js";
import { toast } from "../wx/toast.js";
import { Dot, Group, Inset, ListPage, Note, Row, Spinner, useNow } from "../ui.js";
import { AppTile } from "./AppTile.js";
import { ConnectAppDialog } from "./ConnectAppDialog.js";
import { disconnect, lendToTeam } from "./connectApp.js";
import { refreshConnectors, useConnectors } from "./connectorsStore.js";

type Props = NativeStackScreenProps<RootStackParams, "AppDetail">;

async function myUid(): Promise<string> {
  const uid = await ensureUid();
  if (uid === null) throw new Error("还没登录。");
  return uid;
}

export function AppDetailScreen({ route, navigation }: Props) {
  const { serverId } = route.params;
  const { c } = usePalette();
  const cloud = useConnectors();
  const homeId = useHome().home?.id ?? null;
  const teams = useTeams();
  const now = useNow(60_000);
  const [error, setError] = useState<string | null>(null);
  /** 正在路上的那一次借出 / 收回：开关先照它画，回来再照云端视图 */
  const [pending, setPending] = useState<{ workspaceId: string; on: boolean } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [relogin, setRelogin] = useState(false);
  const [confirm, setConfirm] = useState(false);
  /** 按了确认弹窗里的「断开」：等它退场放完再发 */
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void refreshConnectors();
      void refreshTeams();
      void refreshHome();
    }, []),
  );

  const item = cloud.apps?.find((a) => a.serverId === serverId) ?? null;
  const view = item === null ? null : appDetail(item, now);
  const title = view?.title ?? "";
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  if (item === null || view === null) {
    return (
      <ListPage>
        {cloud.apps === null && cloud.loadError === null ? <Inset><Spinner /></Inset> : null}
        {cloud.loadError !== null ? <Inset><Note tone="warn">{cloud.loadError}</Note></Inset> : null}
        {cloud.apps !== null ? (
          <Text style={{ ...t.callout, color: c.mutedForeground, textAlign: "center", paddingTop: 36, paddingHorizontal: 32 }}>{APP_GONE}</Text>
        ) : null}
      </ListPage>
    );
  }

  const entry = MCP_CATALOG.find((e) => e.id === item.catalogId) ?? null;
  const teamList = teams.teams.map((x) => ({ id: x.ws.id, name: x.ws.name }));
  const lend = lendRows(teamList, item).map((r) => (pending?.workspaceId === r.workspaceId ? { ...r, on: pending.on } : r));
  const locked = pending !== null || disconnecting;
  const shown = showAll ? view.tools : view.tools.slice(0, TOOLS_PREVIEW);

  const toggle = async (workspaceId: string, name: string, on: boolean): Promise<void> => {
    if (locked) return;
    setPending({ workspaceId, on });
    setError(null);
    try {
      await lendToTeam({ serverId, workspaceId, on, label: view.title, uid: await myUid() });
      await refreshConnectors();
      toast(lendToast(name, on));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const runDisconnect = async (): Promise<void> => {
    setDisconnecting(true);
    setError(null);
    try {
      // 主场那一条授权没有目录行（只有借给团队时才挂招牌），其余每一条都要摘
      await disconnect({ serverId, uid: await myUid(), workspaceIds: item.grants.filter((g) => g !== homeId) });
      await refreshConnectors();
      toast(disconnectedToast(view.title));
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDisconnecting(false);
    }
  };

  const side = { ...t.footnote, color: c.mutedForeground };
  return (
    <ListPage>
      <View style={{ gap: space.sm }}>
        <View style={{ alignItems: "center", gap: 8, paddingTop: 18, paddingHorizontal: 24, paddingBottom: 14 }}>
          <AppTile name={view.title} size={64} />
          <Text style={{ ...t.title, fontWeight: "600", color: c.foreground, textAlign: "center" }}>{view.title}</Text>
          {view.description !== "" ? (
            <Text style={{ fontSize: 14, lineHeight: 21, color: c.mutedForeground, textAlign: "center" }}>{view.description}</Text>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Dot tone={view.needsLogin ? "warn" : "ok"} />
            <Text style={side}>{view.statusText}</Text>
          </View>
        </View>
        {error !== null ? <Inset><Note tone="error">{error}</Note></Inset> : null}
        {view.needsLogin && entry !== null ? (
          <Group>
            <Row label="重新登录" tone="accent" align="center" disabled={locked} onPress={() => setRelogin(true)} />
          </Group>
        ) : null}
        <View>
          <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: space.md, paddingTop: 10, paddingBottom: 8 }}>
            <Text style={side}>它能做的</Text>
            <Text style={side}>{toolCountText(view.tools.length)}</Text>
          </View>
          {view.tools.length > 0 ? (
            <Group>
              {shown.map((name) => (
                <View key={name} style={{ minHeight: 54, justifyContent: "center", paddingHorizontal: space.md }}>
                  <Text style={{ fontFamily: MONO, fontSize: 15, color: c.foreground }} numberOfLines={1}>{name}</Text>
                </View>
              ))}
              {!showAll && view.tools.length > TOOLS_PREVIEW ? (
                <Row label={allToolsLabel(view.tools.length)} tone="accent" align="center" onPress={() => setShowAll(true)} />
              ) : null}
            </Group>
          ) : null}
        </View>
        {lend.length > 0 ? (
          <Group header="借给团队" footer={LEND_FOOTER}>
            {lend.map((r) => (
              <Row
                key={r.workspaceId}
                label={r.name}
                trailing={
                  <Switch
                    value={r.on}
                    disabled={locked}
                    onValueChange={(v) => void toggle(r.workspaceId, r.name, v)}
                    accessibilityLabel={r.name}
                  />
                }
              />
            ))}
          </Group>
        ) : null}
        <View style={{ height: 20 }} />
        <Group>
          <Row label="断开" tone="destructive" align="center" disabled={locked} onPress={() => setConfirm(true)} />
        </Group>
      </View>
      <Dialog
        visible={confirm}
        onExited={() => {
          if (!disconnectArmed) return;
          setDisconnectArmed(false);
          void runDisconnect();
        }}
      >
        <DialogTitle>{disconnectTitle(view.title)}</DialogTitle>
        <DialogLead>{DISCONNECT_LEAD}</DialogLead>
        <DialogFooter
          left={{ label: "取消", onPress: () => setConfirm(false) }}
          right={{
            label: "断开",
            tone: "destructive",
            onPress: () => {
              setDisconnectArmed(true);
              setConfirm(false);
            },
          }}
        />
      </Dialog>
      {relogin && entry !== null ? (
        <ConnectAppDialog
          entry={entry}
          relogin
          onClose={(landed) => {
            setRelogin(false);
            if (landed !== null) toast(reloginToast(entry.name));
          }}
        />
      ) : null}
    </ListPage>
  );
}
