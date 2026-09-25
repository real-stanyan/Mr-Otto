// 智能体设置（#1356 A1，spec §5.4）。从私聊头部右边那颗进来。
// 判据全在 shared：表单校验与 patch（agentSettingsForm.ts）、落库前的校验 + 查重名 + 23505 翻译、
// 删一只的倒序四步（agentAdmin.ts，与桌面同一份编排）。这里只画与接线。
// 「存」挂在原生导航条右边：什么都没改 / 有一格不合法 / 正在存时按不动。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  deleteAgentEverywhere, updateAgentChecked, type AgentDeleteDeps, type AgentUpdateDeps,
} from "../../../src/shared/agentAdmin.js";
import { avatarPreviewSlot } from "../../../src/shared/agentAvatar.js";
import {
  agentFormErrors, agentFormOf, agentFormPatch, agentFormValid, type AgentForm,
} from "../../../src/shared/agentSettingsForm.js";
import { AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX } from "../../../src/shared/createAgentDraft.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { deleteAgentRow, listAgentChats, listAgentNames, updateAgentRow } from "../../../src/shared/supabaseWorkspacesApi.js";
import { agentPagePath } from "../../../src/shared/wiki.js";
import { ADMIN_AGENT_ID, AGENT_NAME_MAX } from "../../../src/shared/workspaceAgents.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { Face } from "../face/Face.js";
import { refreshHomeAfterWrite, useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { supabase } from "../supabase.js";
import { radius, space, type as t, usePalette } from "../theme.js";
import { Button, Field, Group, Note, Row } from "../ui.js";
import { FacePickerSheet } from "./FacePickerSheet.js";

const updateDeps: AgentUpdateDeps = { listAgentNames, updateAgentRow };
const deleteDeps: AgentDeleteDeps = {
  listAgentChats,
  deleteAgentRow,
  removeCloudSession: (w, s) => cloudClient.remove(w, s),
  updateChatRoster: (w, s, agentIds) => cloudClient.chatUpdate(w, s, { agentIds }),
  removeAgentPage: (w, agentId) =>
    cloudClient.workspaceWikiWrite(w, { op: "remove", path: agentPagePath(agentId) }).then(() => undefined),
};

/** 「删掉」的说明——弹窗与那一组的注脚说同一句话（spec §5.4 原文） */
const DELETE_LEAD = "它的私聊一起删掉；群里会被摘出去；它自己那页记忆一起删掉，它改过的共用页面留着。";

function Labeled({ label, hint, error, children }: { label: string; hint?: string; error: string | null; children: ReactNode }) {
  const { c } = usePalette();
  return (
    <View style={{ gap: space.xs }}>
      <Text style={{ ...t.footnote, color: c.mutedForeground, paddingHorizontal: 4 }}>
        {label}
        {hint ? ` · ${hint}` : ""}
      </Text>
      {children}
      {error ? <Text style={{ ...t.footnote, color: c.destructive, paddingHorizontal: 4 }}>{error}</Text> : null}
    </View>
  );
}

type Props = NativeStackScreenProps<RootStackParams, "AgentSettings">;

export function AgentSettingsScreen({ route, navigation }: Props) {
  const { agentId } = route.params;
  const { c } = usePalette();
  const home = useHome();
  const ws = home.home;
  const agent = ws?.agents.find((a) => a.agentId === agentId) ?? null;
  const [form, setForm] = useState<AgentForm | null>(() => (agent ? agentFormOf(agent) : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 快照是异步到的：进来时 agent 还没有就等它来了再种表单（种一次，之后听人的）
  useEffect(() => {
    if (form === null && agent !== null) setForm(agentFormOf(agent));
  }, [agent, form]);

  const errors = form ? agentFormErrors(form) : null;
  const patch = agent && form ? agentFormPatch(agent, form) : null;
  const canSave = !busy && errors !== null && agentFormValid(errors) && patch !== null;

  const save = async (): Promise<void> => {
    if (!ws || !canSave || patch === null) return;
    setBusy(true);
    setError(null);
    try {
      await updateAgentChecked(updateDeps, supabase, ws.id, agentId, patch);
      await refreshHomeAfterWrite();
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!ws || busy) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await deleteAgentEverywhere(deleteDeps, supabase, ws.id, agentId);
      setConfirming(false);
      await refreshHomeAfterWrite();
      // 回名册：它的私聊已经没了，退回那一页只会看见一条连不上的线
      navigation.popToTop();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 「存」挂在原生导航条右边。按下去调的是 ref 里最新的 save；setOptions 只在「按不按得动 /
  // 正在存」这两格变了时重设——不带依赖地每次渲染都 setOptions，会让导航器跟着重渲、再触发这里，
  // 形成一个死循环
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          hitSlop={10}
          onPress={() => void saveRef.current()}
          style={({ pressed }) => [pressed && { opacity: 0.6 }]}
        >
          <Text style={{ ...t.headline, color: canSave ? c.brand : c.mutedForeground }}>{busy ? "正在存…" : "存"}</Text>
        </Pressable>
      ),
    });
  }, [navigation, canSave, busy, c.brand, c.mutedForeground]);

  if (!ws || !agent || !form || !errors) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background, padding: space.lg }}>
        {/* 还没查到就什么都不说；查过了还是没有 = 刚被删了 */}
        {home.loaded ? <Note tone="warn">这只智能体已经不在了。</Note> : null}
      </View>
    );
  }

  const previewSlot = avatarPreviewSlot(ws, agentId, form.avatarSlot) ?? 0;
  const isAdmin = agent.agentId === ADMIN_AGENT_ID;
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xl }}
      >
        <View style={{ alignItems: "center", gap: space.sm }}>
          <Face slot={previewSlot} state="alive" tier="l" phase={facePhase(agentId)} label={`${agent.name}的形象`} />
          <Button size="auto" variant="outline" label="换个形象" onPress={() => setPicking(true)} />
        </View>

        <Labeled label="名字" error={errors.name}>
          <Field
            value={form.name}
            onChangeText={(name) => setForm({ ...form, name })}
            placeholder="群里 @ 它用的名字"
            maxLength={AGENT_NAME_MAX}
            invalid={errors.name !== null}
          />
        </Labeled>

        <Labeled label="职责" error={errors.description}>
          <Field
            value={form.description}
            onChangeText={(description) => setForm({ ...form, description })}
            placeholder="它负责什么，一句话"
            maxLength={AGENT_DESCRIPTION_MAX}
            invalid={errors.description !== null}
          />
        </Labeled>

        <Labeled label="还有什么要交代的" hint="它自己看得见这一段" error={errors.instructions}>
          <TextInput
            multiline
            value={form.instructions}
            onChangeText={(instructions) => setForm({ ...form, instructions })}
            placeholder="比如：只推分支，不动 main"
            placeholderTextColor={c.mutedForeground}
            maxLength={AGENT_INSTRUCTIONS_MAX}
            textAlignVertical="top"
            style={{
              minHeight: 132, borderRadius: radius.control, borderWidth: 1,
              borderColor: errors.instructions !== null ? c.destructive : c.input,
              backgroundColor: c.card, color: c.foreground,
              paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, fontSize: 16, lineHeight: 22,
            }}
          />
        </Labeled>

        {error ? <Note tone="error">{error}</Note> : null}

        {/* 管理员没有这一行（RLS 也删不掉它，画一颗必然失败的钮是撒谎） */}
        {!isAdmin ? (
          <Group footer={DELETE_LEAD}>
            <Row
              label={`删掉「${agent.name}」`}
              tone="destructive"
              align="center"
              disabled={busy}
              onPress={() => {
                setDeleteError(null);
                setConfirming(true);
              }}
            />
          </Group>
        ) : null}
      </ScrollView>

      <FacePickerSheet
        visible={picking}
        current={previewSlot}
        onPick={(slot) => setForm({ ...form, avatarSlot: slot })}
        onClose={() => setPicking(false)}
      />

      {/* 确认类用居中弹窗，不用抽屉（手机端既有规矩，spec §4） */}
      <Dialog visible={confirming}>
        <DialogTitle>删掉「{agent.name}」？</DialogTitle>
        <DialogLead>{DELETE_LEAD}</DialogLead>
        {deleteError ? (
          <View style={{ paddingHorizontal: 20 }}>
            <Note tone="error">{deleteError}</Note>
          </View>
        ) : null}
        <DialogFooter
          left={{ label: "取消", onPress: () => setConfirming(false), disabled: busy }}
          right={{ label: busy ? "正在删…" : "删掉", onPress: () => void remove(), disabled: busy }}
        />
      </Dialog>
    </View>
  );
}
