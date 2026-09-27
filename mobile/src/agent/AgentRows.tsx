// 一只智能体的那几行（#1386，demo 的 agentRows）：形象 / 名字 / 职责 / 还有什么要交代的 / 说话的声音 / 本周用了额度的。
// 智能体资料页与私聊的聊天信息页共用这一份。每一行点开改一格、存了就生效（居中弹窗；形象与声音是在几样里挑一样，
// 走底部抽屉），不再是 A1 那张整页表单 +「存」。
// 说话的声音（A4b 的那张表）例外一点：表里点一档 = 换成它 + 念一句，人会连着点好几档去听，所以**表收起时比一次、
// 变了才存**，不是每点一下写一次库（ADR-0323）。比的是「认得的那一档」（agentFormPatch 同一条）：认不出的新键
// （新版客户端存的）不会因为点了一下「自动」试听就被冲掉。判据原样：表单校验（agentSettingsForm）、落库前校验 + 查重名 + 23505 翻译
// （agentAdmin.updateAgentChecked，与桌面同一份编排）。
// 「模型」「能用哪几个应用」「它记下的东西」不在这里（#1356 撤掉的三样，理由原样成立）。
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { updateAgentChecked, type AgentUpdateDeps } from "../../../src/shared/agentAdmin.js";
import { avatarPreviewSlot } from "../../../src/shared/agentAvatar.js";
import { agentFormErrors, agentFormOf, agentFormPatch, type AgentForm } from "../../../src/shared/agentSettingsForm.js";
import { voiceRowValue } from "../../../src/shared/agentVoicePicker.js";
import { AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX } from "../../../src/shared/createAgentDraft.js";
import { listAgentNames, updateAgentRow } from "../../../src/shared/supabaseWorkspacesApi.js";
import { AGENT_NAME_MAX } from "../../../src/shared/workspaceAgents.js";
import { usageRows } from "../../../src/shared/workspaceUsageView.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { refreshHomeAfterWrite } from "../home/homeStore.js";
import { refreshUsage, useMachine } from "../machine/machineStore.js";
import { supabase } from "../supabase.js";
import { Group, Row } from "../ui.js";
import { FaceTile } from "../wx/Avatar.js";
import { EditTextDialog } from "../wx/EditTextDialog.js";
import { FacePickerSheet } from "./FacePickerSheet.js";
import { VoicePickerSheet } from "./VoicePickerSheet.js";

const updateDeps: AgentUpdateDeps = { listAgentNames, updateAgentRow };

type Field = "name" | "description" | "instructions";
const FIELD: Record<Field, { title: string; lead: string; max: number; multi: boolean; empty: boolean; placeholder: string }> = {
  name: { title: "名字", lead: "群里 @ 它用的就是这个名字。", max: AGENT_NAME_MAX, multi: false, empty: false, placeholder: "它的名字" },
  description: { title: "职责", lead: "它负责什么，一句话。改完下一句话就生效。", max: AGENT_DESCRIPTION_MAX, multi: false, empty: true, placeholder: "它负责什么" },
  instructions: { title: "还有什么要交代的", lead: "它自己看得见这一段。改完下一句话就生效。", max: AGENT_INSTRUCTIONS_MAX, multi: true, empty: true, placeholder: "比如：回复先给结论，别用感叹号" },
};

/** 改一格：拿当前那一行拼出表单、只改这一格，过表单校验，再交给 updateAgentChecked */
async function saveField(ws: WorkspaceSnapshot, agent: WorkspaceAgentRow, patch: Partial<AgentForm>): Promise<void> {
  const form = { ...agentFormOf(agent), ...patch };
  const errors = agentFormErrors(form);
  const msg = errors.name ?? errors.description ?? errors.instructions;
  if (msg !== null) throw new Error(msg);
  const p = agentFormPatch(agent, form);
  if (p === null) return;
  await updateAgentChecked(updateDeps, supabase, ws.id, agent.agentId, p);
  await refreshHomeAfterWrite();
}

export function AgentRows({ ws, agent }: { ws: WorkspaceSnapshot; agent: WorkspaceAgentRow }) {
  const machine = useMachine();
  const [editing, setEditing] = useState<{ field: Field; key: number; visible: boolean } | null>(null);
  const [picking, setPicking] = useState(false);
  /** 表开着时点到的那一档（null = 自动）；收起时拿它和存下来的比一次 */
  const [voiceDraft, setVoiceDraft] = useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  /** 收起之后、写库回来之前那一行先写刚挑的，免得闪回旧的一下（undefined = 照存下来的写） */
  const [voiceShown, setVoiceShown] = useState<string | null | undefined>(undefined);
  /** 形象、声音这两格挑完就存，存不进去的那句话写在这一组底下 */
  const [pickError, setPickError] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      void refreshUsage(ws.id);
    }, [ws.id]),
  );
  const usage = machine.usage.kind === "ok" ? machine.usage.usage : machine.usage.kind === "error" ? machine.usage.usage : null;
  const percent = useMemo(() => {
    if (usage === null || usage === undefined) return null;
    const r = usageRows(ws, usage).find((x) => x.agentId === agent.agentId);
    return r?.percent ?? "0%";
  }, [usage, ws, agent.agentId]);
  const slot = avatarPreviewSlot(ws, agent.agentId, agent.avatarSlot) ?? 0;
  const close = (): void => setEditing((e) => (e === null ? e : { ...e, visible: false }));
  const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const openVoice = (): void => {
    setVoiceDraft(agent.voice ?? null);
    setPickError(null);
    setVoiceOpen(true);
  };
  const closeVoice = (): void => {
    setVoiceOpen(false);
    setVoiceShown(voiceDraft);
    saveField(ws, agent, { voice: voiceDraft })
      .catch((e: unknown) => setPickError(why(e)))
      .finally(() => setVoiceShown(undefined));
  };
  const voiceNow = voiceOpen ? voiceDraft : voiceShown !== undefined ? voiceShown : (agent.voice ?? null);
  const text = (v: string): string => (v.trim() === "" ? "没写" : v.replace(/\s+/g, " "));
  return (
    <>
      <Group {...(pickError !== null ? { footer: pickError } : {})}>
        <Row label="形象" trailing={<FaceTile slot={slot} size={30} radius={6} />} chevron onPress={() => setPicking(true)} />
        <Row label="名字" value={agent.name} chevron onPress={() => setEditing({ field: "name", key: Date.now(), visible: true })} />
        <Row label="职责" value={text(agent.description)} chevron onPress={() => setEditing({ field: "description", key: Date.now(), visible: true })} />
        <Row label="还有什么要交代的" value={text(agent.instructions)} chevron onPress={() => setEditing({ field: "instructions", key: Date.now(), visible: true })} />
        <Row label="说话的声音" value={voiceRowValue(voiceNow)} chevron onPress={openVoice} />
        {percent !== null ? <Row label="本周用了额度的" value={percent} /> : null}
      </Group>

      <FacePickerSheet
        visible={picking}
        current={slot}
        onPick={(s) => {
          setPickError(null);
          saveField(ws, agent, { avatarSlot: s }).catch((e: unknown) => setPickError(why(e)));
        }}
        onClose={() => setPicking(false)}
      />
      <VoicePickerSheet
        visible={voiceOpen}
        agentId={agent.agentId}
        name={agent.name}
        description={agent.description}
        picked={voiceDraft}
        agents={ws.agents}
        onPick={setVoiceDraft}
        onClose={closeVoice}
      />
      {editing !== null ? (
        <EditTextDialog
          key={editing.key}
          visible={editing.visible}
          title={FIELD[editing.field].title}
          lead={FIELD[editing.field].lead}
          initial={agent[editing.field]}
          placeholder={FIELD[editing.field].placeholder}
          maxLength={FIELD[editing.field].max}
          multiline={FIELD[editing.field].multi}
          allowEmpty={FIELD[editing.field].empty}
          check={(v) => {
            const e = agentFormErrors({ ...agentFormOf(agent), [editing.field]: v });
            return e[editing.field] ?? "";
          }}
          onSave={async (v) => {
            await saveField(ws, agent, { [editing.field]: v });
            close();
          }}
          onClose={close}
          onExited={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
