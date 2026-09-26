// 群设置（#1356 A3，spec §5.6）：从群聊头部右边那颗进来（中间没有菜单）。原生导航条：返回 | 群名 | 存。
// 群名与名单读名册那份清单（groupRows：workspace_sessions 的投影——runtime 回 chat_update 的回执之前已经
// 写完那两列），不读日志：这一页不开房（同桌面 GroupSettingsDrawer）。聊天页头部那排名字仍从日志推导
// （chatViewOf），名单变了房里会广播一条 chat_roster_changed，那边自己跟上。
// 每个动作做完拉一遍名册（refreshHomeAfterWrite）；进这一页也拉一次（别的设备可能刚改过名单）。
// 群名那一格人没动过时显示清单里那一格（名册刷新了跟着变），动过之后听人的。
// 解散 = 删除不是归档：居中确认（spec §4），右边那颗实底红（#1362）→ delete → 回名册（这条线没了，
// 退回聊天页只会看见一条连不上的线）。先回名册再刷新：反过来的话这一页会先闪一下「这个群已经不在了」。
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { groupRows } from "../../../src/shared/agentRoster.js";
import { addChoice, withAgent, withoutAgent } from "../../../src/shared/groupEdit.js";
import { HeaderTextButton } from "../chrome/HeaderTextButton.js";
import { cloudClient } from "../cloud/cloudClient.js";
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
    if (ws === null || row === null || busy) return;
    setRemovingId(agentId);
    setError(null);
    const r = await cloudClient.chatUpdate(ws.id, sessionId, { agentIds: withoutAgent(ws, row.agentIds, agentId) });
    if (r.ok) await refreshHomeAfterWrite();
    else setError(r.message);
    setRemovingId(null);
  };

  const add = async (agentId: string): Promise<void> => {
    if (ws === null || row === null || addBusyId !== null) return;
    setAddBusyId(agentId);
    setAddError(null);
    const r = await cloudClient.chatUpdate(ws.id, sessionId, { agentIds: withAgent(ws, row.agentIds, agentId) });
    if (!r.ok) {
      setAddBusyId(null);
      setAddError(r.message);
      return;
    }
    await refreshHomeAfterWrite();
    setAddBusyId(null);
    setAdding(false);
  };

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
    navigation.popToTop();
    void refreshHomeAfterWrite();
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

  if (ws === null || row === null) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background, padding: space.lg }}>
        {/* 还没查到就转圈；查过了还是没有 = 刚被解散了 */}
        {home.loaded ? <Note tone="warn">这个群已经不在了。</Note> : <Spinner />}
      </View>
    );
  }

  const choice = addChoice(ws, row.agentIds);
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <GroupSettingsBody
        ws={ws}
        agentIds={row.agentIds}
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
      <Dialog visible={confirming}>
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
