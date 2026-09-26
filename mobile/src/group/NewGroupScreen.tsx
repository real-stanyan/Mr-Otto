// 建群（#1356 A3，spec §5.6）：从 ＋ 那张岔路弹窗的「一个群聊」推进来。原生导航条：返回 | 新的群聊 | 建。
// 「建」= create{chat:{kind:"group"}}（群名留空时发出去的是成员名拼起来的那个，groupNameFor）→ 名册刷新
// （新群那一行与群名都从那份清单来）→ **换成**那条群聊（replace：返回回到名册，不回到这张表）。
// 名册没读回来就退回名册（那里有读不到的那句话 + 重试钮），不推一页「这条聊天已经不在了」——它明明在。
// 建失败那句话留在这一页、表单不清（关掉就等于把「没建成」说成「建成了」，同桌面建群弹窗）。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { View } from "react-native";
import { groupNameFor, groupPick } from "../../../src/shared/groupEdit.js";
import { resolveChatTarget, type ChatTarget } from "../../../src/shared/mobileChat.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { homeSnapshot, refreshHomeAfterWrite, useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { space, usePalette } from "../theme.js";
import { Note, Spinner } from "../ui.js";
import { NewGroupForm } from "./NewGroupForm.js";

type Props = NativeStackScreenProps<RootStackParams, "NewGroup">;

export function NewGroupScreen({ navigation }: Props) {
  const { c } = usePalette();
  const home = useHome();
  const ws = home.home;
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = ws === null ? null : groupPick(ws, picked);
  const canCreate = !busy && pick !== null && pick.enough;

  const create = async (): Promise<void> => {
    if (ws === null || pick === null || !canCreate) return;
    setBusy(true);
    setError(null);
    const r = await cloudClient.create(ws.id, { kind: "group", name: groupNameFor(ws, pick.ids, name), agentIds: pick.ids });
    if (!r.ok) {
      setBusy(false);
      setError(r.message);
      return;
    }
    await refreshHomeAfterWrite();
    // 这几秒里人可能已经退出了这一页：不隔着别的屏硬推一条聊天
    if (!navigation.isFocused()) return;
    const h = homeSnapshot();
    const target: ChatTarget = { kind: "group", sessionId: r.value.sessionId };
    if (h.home !== null && resolveChatTarget(h.home, h.chats, target) !== null) navigation.replace("Chat", target);
    else navigation.popToTop();
  };

  // 「建」挂在原生导航条右边（同智能体设置的「存」）：按下去调 ref 里最新的 create；
  // setOptions 只在按不按得动 / 正在建变了时重设
  const createRef = useRef(create);
  useEffect(() => {
    createRef.current = create;
  });
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderTextButton label={busy ? "正在建…" : "建"} disabled={!canCreate} onPress={() => void createRef.current()} />
      ),
    });
  }, [navigation, canCreate, busy]);

  if (ws === null) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background, padding: space.lg }}>
        {home.loaded ? <Note tone="warn">还没读到你的智能体。</Note> : <Spinner />}
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <NewGroupForm ws={ws} name={name} picked={picked} busy={busy} error={error} onName={setName} onPicked={setPicked} />
    </View>
  );
}
