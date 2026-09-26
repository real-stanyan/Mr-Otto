// 群设置（#1356 A3，spec §5.6）：从群聊头部右边那颗进来（中间没有菜单）。原生导航条：返回 | 群名 | 存。
// 群名读名册那份清单（groupRows：workspace_sessions 的投影；群名不是日志事实，改名走的是库）。**名单优先读
// 日志**：这一页只从群聊头部进来，底下那条聊天的房间一直开着（ChatScreen 没卸载），而移出 / 加一只发出去的是
// 「变动之后的完整名单」——拿投影当底，投影一陈旧（刷新失败，或 runtime 写那一列失败只记日志、照样回 ok）下一次
// 就会把上一次的改动悄悄覆盖回去。日志那份（chatViewOf，与聊天页头部、「@ 谁」同一份）每次改名单房里都会广播；
// 房间不在这一条上时才退回投影。名册那份清单这次没刷新成时，页顶一句「读不到」（spec §6：读不到 ≠ 空）。
// 每个动作做完拉一遍名册（refreshHomeAfterWrite）；进这一页也拉一次（别的设备可能刚改过名单）。
// 群名那一格人没动过时显示清单里那一格（名册刷新了跟着变），动过之后听人的。
// 解散 = 删除不是归档：居中确认（spec §4），右边那颗实底红（#1362）→ delete → 回名册（这条线没了，
// 退回聊天页只会看见一条连不上的线）。先回名册再刷新：反过来的话这一页会先闪一下「这个群已经不在了」。
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { chatViewOf, groupRows } from "../../../src/shared/agentRoster.js";
import { addChoice, withAgent, withoutAgent } from "../../../src/shared/groupEdit.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { useChatStore } from "../cloud/chatStore.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { refreshHome, refreshHomeAfterWrite, useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { space, usePalette } from "../theme.js";
import { Note, Spinner } from "../ui.js";
import { AddMemberSheet } from "./AddMemberSheet.js";
import { GroupSettingsBody } from "./GroupSettingsBody.js";

/** 解散确认里那句话（demo 的 disband） */
const DISSOLVE_LEAD = "这条线会删掉，不可恢复。里面那几只都还在，它们各自的线一个字不少。";

type Props = NativeStackScreenProps<RootStackParams, "GroupSettings">;

export function GroupSettingsScreen({ route, navigation }: Props) {
  const { sessionId } = route.params;
  const { c } = usePalette();
  const home = useHome();
  const ws = home.home;
  const row = useMemo(
    () => (ws === null ? null : (groupRows(ws, home.chats).find((g) => g.sessionId === sessionId) ?? null)),
    [ws, home.chats, sessionId],
  );
  const chat = useChatStore();
  /** 名单：底下那条聊天的日志优先（见头注）；房间不在这一条上 / 还不知道是哪种聊天时退回清单那一行 */
  const agentIds = useMemo(() => {
    if (ws === null || row === null) return null;
    const s = chat.session;
    const live = s !== null && s.sessionId === sessionId && s.chat ? chatViewOf(ws, s.chat, s.events, row.name) : null;
    return live?.agentIds ?? row.agentIds;
  }, [ws, row, chat.session, sessionId]);
  /** null = 人还没动过群名那一格（显示清单里那一格） */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addBusyId, setAddBusyId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const [dissolveError, setDissolveError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void refreshHome();
    }, []),
  );

  const busy = saving || removingId !== null || addBusyId !== null || dissolving;
  const name = nameDraft ?? row?.name ?? "";
  const trimmed = name.trim();
  const canSave = !busy && row !== null && trimmed !== "" && trimmed !== row.name;

  const save = async (): Promise<void> => {
    if (ws === null || !canSave) return;
    setSaving(true);
    setError(null);
    // 只发名字：名单那一格不带（见 GroupSettingsBody 头注）
    const r = await cloudClient.chatUpdate(ws.id, sessionId, { name: trimmed });
    if (!r.ok) {
      setSaving(false);
      setError(r.message);
      return;
    }
    await refreshHomeAfterWrite();
    setSaving(false);
    navigation.goBack();
  };

  const remove = async (agentId: string): Promise<void> => {
    if (ws === null || agentIds === null || busy) return;
    setRemovingId(agentId);
    setError(null);
    const r = await cloudClient.chatUpdate(ws.id, sessionId, { agentIds: withoutAgent(ws, agentIds, agentId) });
    if (r.ok) await refreshHomeAfterWrite();
    else setError(r.message);
    setRemovingId(null);
  };

  const add = async (agentId: string): Promise<void> => {
    if (ws === null || agentIds === null || busy) return;
    setAddBusyId(agentId);
    setAddError(null);
    const r = await cloudClient.chatUpdate(ws.id, sessionId, { agentIds: withAgent(ws, agentIds, agentId) });
    if (!r.ok) {
      setAddBusyId(null);
      setAddError(r.message);
      return;
    }
    await refreshHomeAfterWrite();
    setAddBusyId(null);
    setAdding(false);
  };

  /** 解散成了：先收确认弹窗，退场放完再回名册（弹窗还在的时候跳页，它会压在滑走的那一页上） */
  const dissolved = useRef(false);

  const dissolve = async (): Promise<void> => {
    if (ws === null || dissolving) return;
    setDissolving(true);
    setDissolveError(null);
    const r = await cloudClient.remove(ws.id, sessionId);
    if (!r.ok) {
      setDissolving(false);
      setDissolveError(r.message);
      return;
    }
    dissolved.current = true;
    setConfirming(false);
  };

  // 「存」挂在原生导航条右边（同智能体设置）：按下去调 ref 里最新的 save；setOptions 只在
  // 标题 / 按不按得动 / 正在存变了时重设
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useLayoutEffect(() => {
    navigation.setOptions({
      title: row?.name ?? "",
      headerRight: () => (
        <HeaderTextButton label={saving ? "正在存…" : "存"} disabled={!canSave} onPress={() => void saveRef.current()} />
      ),
    });
  }, [navigation, row?.name, canSave, saving]);

  if (ws === null || row === null || agentIds === null) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background, padding: space.lg }}>
        {/* 还没查到就转圈；查过了还是没有 = 刚被解散了 */}
        {home.loaded ? <Note tone="warn">这个群已经不在了。</Note> : <Spinner />}
      </View>
    );
  }

  const choice = addChoice(ws, agentIds);
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {home.loadError !== null ? (
        // 读不到 ≠ 空（spec §6）：名册那份清单这次没刷新成，群名是上一次读到的
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.md }}>
          <Note tone="warn">{home.loadError}</Note>
        </View>
      ) : null}
      <GroupSettingsBody
        ws={ws}
        agentIds={agentIds}
        name={name}
        onName={setNameDraft}
        busy={busy}
        removingId={removingId}
        addReason={choice.reason}
        error={error}
        onRemove={(id) => void remove(id)}
        onAdd={() => {
          setAddError(null);
          setAdding(true);
        }}
        onDissolve={() => {
          setDissolveError(null);
          setConfirming(true);
        }}
      />

      <AddMemberSheet
        visible={adding}
        ws={ws}
        candidates={choice.candidates}
        busyId={addBusyId}
        error={addError}
        onPick={(id) => void add(id)}
        onClose={() => setAdding(false)}
      />

      {/* 确认类用居中弹窗，不用抽屉（手机端既有规矩，spec §4）；「解散」实底红（#1362） */}
      <Dialog
        visible={confirming}
        onExited={() => {
          if (!dissolved.current) return;
          // 先回名册再刷新：反过来这一页会先闪一下「这个群已经不在了」
          navigation.popToTop();
          void refreshHomeAfterWrite();
        }}
      >
        <DialogTitle>解散「{row.name}」？</DialogTitle>
        <DialogLead>{DISSOLVE_LEAD}</DialogLead>
        {dissolveError !== null ? (
          <View style={{ paddingHorizontal: 20 }}>
            <Note tone="error">{dissolveError}</Note>
          </View>
        ) : null}
        <DialogFooter
          left={{ label: "取消", onPress: () => setConfirming(false), disabled: dissolving }}
          right={{
            label: dissolving ? "正在解散…" : "解散",
            onPress: () => void dissolve(),
            disabled: dissolving,
            tone: "destructive",
          }}
        />
      </Dialog>
    </View>
  );
}
