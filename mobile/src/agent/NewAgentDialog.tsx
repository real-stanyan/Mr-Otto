// 新建智能体（#1386，demo 的 newAgentDialog）：居中弹窗——起个名字、挑张脸、「创建」。建好它先开口问你要它
// 干什么，你回的第一句就是它的职责（ADR-0319，runtime 那一半原样）。#1356 那张 70% 抽屉退役：表单用居中弹窗是
// 既有规矩，demo 也是这么画的。
//
// 编排原样用 shared/newAgentForm.ts（与那张抽屉同一份）：行只落一次；私聊没建成时钮变「再试一次」、只重试私聊
// （名字与脸这时已经定了，锁住）；这时不建了就把「先开口」那一格清掉（不清的话之后从草稿发第一句会双答）。
// 正在建的那几秒弹窗锁住（没有「点外面关」，按钮也按不动）。每打开一次铸一个 id（调用方换 key 重挂）。
import * as ExpoCrypto from "expo-crypto";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { agentIdFromBytes, createAgentChecked } from "../../../src/shared/agentAdmin.js";
import { createNewAgentFlow, defaultPickFor, newAgentNameError, type NewAgentStep } from "../../../src/shared/newAgentForm.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { clearAgentOnboarding, insertAgentRow, listAgentNames } from "../../../src/shared/supabaseWorkspacesApi.js";
import { AGENT_NAME_MAX } from "../../../src/shared/workspaceAgents.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { Dialog, DialogBody, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { supabase } from "../supabase.js";
import { type as t, usePalette } from "../theme.js";
import { Field, Note } from "../ui.js";
import { FaceTile } from "../wx/Avatar.js";
import { FacePicker } from "../wx/FacePicker.js";

export function NewAgentDialog({ visible, ws, selfUid, onClose, onCreated, onExited }: {
  visible: boolean;
  ws: WorkspaceSnapshot;
  selfUid: string;
  onClose: () => void;
  /** 行与私聊都成了：调用方收弹窗、刷新、切到它那条线 */
  onCreated: (agentId: string) => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const [agentId] = useState(() => agentIdFromBytes(ExpoCrypto.getRandomBytes(6)));
  const [face, setFace] = useState(() => defaultPickFor(ws, agentId));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<NewAgentStep>("form");
  const [error, setError] = useState<string | null>(null);
  const flow = useMemo(
    () =>
      createNewAgentFlow({
        insert: (input) =>
          createAgentChecked({ listAgentNames, insertAgentRow }, supabase, ws.id, selfUid, agentId, {
            name: input.name,
            description: "",
            instructions: "",
            models: [],
            tools: [],
            avatarSlot: input.avatarSlot,
            onboarding: "greet",
          }),
        openDm: () => cloudClient.create(ws.id, { kind: "dm", agentId }),
        clearGreeting: () => clearAgentOnboarding(supabase, ws.id, agentId),
      }),
    // 一次打开一份：ws.id / selfUid / agentId 在这一次打开里不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const nameError = newAgentNameError(name, ws.agents.map((a) => a.name));
  const locked = busy || step !== "form";
  const shownError = step === "form" && name.trim() !== "" ? nameError : null;
  const canSubmit = !busy && (step !== "form" || nameError === null);

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const r = await flow.submit({ name, avatarSlot: face.slot });
    setStep(flow.step());
    if (r.ok) {
      onCreated(agentId);
      return;
    }
    setBusy(false);
    setError(r.message);
  };
  const close = (): void => {
    if (busy) return;
    void flow.abandon();
    onClose();
  };

  return (
    <Dialog visible={visible} {...(onExited === undefined ? {} : { onExited })}>
      <DialogTitle>新建智能体</DialogTitle>
      <DialogLead>起个名字、挑张脸。建好它先跟你打招呼，你回的第一句话就是它的职责。</DialogLead>
      <DialogBody>
        <View style={{ alignItems: "center", marginBottom: 4 }}>
          <FaceTile slot={face.slot} size={72} state="alive" phase={facePhase(face.id)} label="它的样子" />
        </View>
        <View pointerEvents={locked ? "none" : "auto"} style={[{ gap: 8 }, locked && { opacity: 0.5 }]}>
          <Field
            variant="dialog"
            value={name}
            onChangeText={setName}
            placeholder="名字，比如「客服」「小周」"
            maxLength={AGENT_NAME_MAX}
            align="center"
            invalid={shownError !== null}
            returnKeyType="done"
          />
          {shownError !== null ? <Text style={{ ...t.footnote, color: c.destructive, textAlign: "center" }}>{shownError}</Text> : null}
          <View style={{ marginTop: 6 }}>
            <FacePicker current={face.id} onPick={setFace} size={40} />
          </View>
        </View>
        {error !== null ? <Note tone="error">{error}</Note> : null}
      </DialogBody>
      <DialogFooter
        left={{ label: "取消", onPress: close, disabled: busy }}
        right={{
          label: busy ? "正在建…" : step === "linking" ? "再试一次" : "创建",
          onPress: () => void submit(),
          disabled: !canSubmit || (step === "form" && name.trim() === ""),
        }}
      />
    </Dialog>
  );
}
