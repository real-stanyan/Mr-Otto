// 「带进来的智能体」编辑页（#1642）：私聊页里点我自己的头像进来。三件事——给谁看（公开给 TA）、带上、移除。
// 原来分在页顶横幅上（点名单改带谁、点右边那颗标签切朝向），横幅撤了之后收到这一页。
// · 名单与朝向读 useLaneRoster（私聊页那条车道连接还在底下，这里借来读）；写走 pairLane 的 bringAgents / setLaneFacing。
// · 还没带过（没车道）：只有「带上」那一行；第一次带上时按「仅我可见」建，带上之后这一页就多出开关，随时改。
// · 移除到一只不剩也行：车道还在，名单空着（同原来改名单那张单子 min = 0）。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { LANE_FACING_DESC } from "../../../src/shared/pairChat.js";
import { friendName } from "../../../src/shared/wechatInbox.js";
import { agentNameOf } from "../../../src/shared/workspaceView.js";
import { PickAgentsDialog } from "../group/PickAgentsDialog.js";
import { useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { usePalette } from "../theme.js";
import { Group, Row } from "../ui.js";
import { FaceTile } from "../wx/Avatar.js";
import { useFriends } from "./friendsStore.js";
import { useLaneRoster } from "./laneRoster.js";
import { bringAgents, setLaneFacing } from "./pairLane.js";

type Props = NativeStackScreenProps<RootStackParams, "LaneAgents">;

export function LaneAgentsScreen({ route }: Props) {
  const { uid } = route.params;
  const { c } = usePalette();
  const home = useHome();
  const friends = useFriends();
  const row = friends.rows?.find((r) => r.profile.id === uid) ?? null;
  const name = row !== null ? friendName(row.profile) : "TA";
  const homeWs = home.home;
  const { laneSid, brought, facing } = useLaneRoster(uid);
  const mine = homeWs === null ? [] : brought.filter((id) => homeWs.agents.some((a) => a.agentId === id));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ key: number; visible: boolean } | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const run = async (what: string, f: () => Promise<{ ok: true } | { ok: false; message: string }>): Promise<boolean> => {
    setBusy(what);
    setError(null);
    const r = await f();
    setBusy(null);
    if (!r.ok) setError(r.message);
    return r.ok;
  };

  if (homeWs === null) return <View style={{ flex: 1, backgroundColor: c.background }} />;
  const rest = homeWs.agents.map((a) => a.agentId).filter((id) => !mine.includes(id));

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ gap: 8, paddingTop: 8, paddingBottom: 40 }}>
        {laneSid !== null ? (
          <Group footer={LANE_FACING_DESC[facing]}>
            <Row
              label={`公开给 ${name}`}
              trailing={
                <Switch
                  value={facing === "both"}
                  disabled={busy !== null}
                  onValueChange={(v) => void run("facing", () => setLaneFacing(homeWs.id, uid, v ? "both" : "self"))}
                  accessibilityLabel={`公开给 ${name}`}
                />
              }
            />
          </Group>
        ) : null}
        <Group
          header="带着"
          footer={mine.length === 0 ? `还没带智能体进和${name}的私聊。带上之后，在私聊里 @ 它们就行，它们会读你们最近的聊天来帮你。` : `@ 了它们的那句进它们的车道；不 @ 谁就是发给${name}。`}
          inset={16 + 32 + 12}
        >
          {mine.map((id) => (
            <Row
              key={id}
              label={agentNameOf(homeWs, id)}
              leading={<FaceTile slot={agentFaceSlot(homeWs, id)} size={32} />}
              trailing={
                <Text
                  accessibilityRole="button"
                  accessibilityLabel={`移除 ${agentNameOf(homeWs, id)}`}
                  suppressHighlighting
                  onPress={busy !== null ? undefined : () => void run(id, async () => bringAgents(homeWs.id, uid, mine.filter((x) => x !== id)))}
                  style={{ fontSize: 15, color: busy === id ? c.faint : c.destructive, paddingVertical: 6, paddingLeft: 12 }}
                >
                  {busy === id ? "移除中…" : "移除"}
                </Text>
              }
            />
          ))}
          {/* 一直画（#1652）：主场里只有管理员一只、又已经带进来时，藏掉这一行读起来像「这页没有添加」——置灰、说清为什么 */}
          <Row
            label="带上智能体"
            tone="accent"
            {...(rest.length === 0 ? { detail: "你的智能体都带进来了。要新的，跟你的管理员说一声" } : {})}
            disabled={busy !== null || rest.length === 0}
            onPress={() => { setAddError(null); setAdding({ key: Date.now(), visible: true }); }}
          />
        </Group>
        {error !== null ? <Text style={{ fontSize: 13, color: c.destructive, paddingHorizontal: 16 }}>{error}</Text> : null}
      </ScrollView>
      {adding !== null ? (
        <PickAgentsDialog
          key={adding.key}
          visible={adding.visible}
          ws={homeWs}
          title="带上我的智能体"
          lead={laneSid === null ? `挑几只带进和${name}的私聊，先只有你看得到；之后在这一页随时公开给 TA。` : `挑几只再带进和${name}的私聊。`}
          options={rest}
          min={1}
          okLabel="带上"
          busy={addBusy}
          error={addError}
          onOk={(picked) => {
            void (async () => {
              setAddBusy(true);
              setAddError(null);
              const r = await bringAgents(homeWs.id, uid, [...mine, ...picked]);
              setAddBusy(false);
              if (!r.ok) {
                setAddError(r.message);
                return;
              }
              setAdding((a) => (a === null ? a : { ...a, visible: false }));
            })();
          }}
          onClose={() => setAdding((a) => (a === null ? a : { ...a, visible: false }))}
          onExited={() => setAdding(null)}
        />
      ) : null}
    </View>
  );
}
