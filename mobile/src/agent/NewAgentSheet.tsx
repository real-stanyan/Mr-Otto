// 「新建智能体」抽屉（#1356 A2，spec §5.5）：X（不建了）+ 标题；上面一张 l 档大脸走一遍它干活的
// 样子（换一张脸从头走、不写状态词）；名字（必填，**不自动聚焦**——键盘一弹上来就把下面那面墙盖住
// 了，而挑脸才是这一屏的主事；打完按键盘上的「完成」收起来）；十张脸；「创建」（名字不合法时按不动）。
// 与「换个形象」走同一副骨架（FaceWall.tsx 的 FacePreview + FaceWall，demo 的 .newbot 同一个壳）。
//
// 编排在 shared/newAgentForm.ts：行只落一次；私聊没建成时钮变「再试一次」、只重试私聊（名字与脸这时
// 已经定了，锁住）；这时不建了就把「先开口」那一格清掉（不清的话之后从草稿发第一句会双答，spec §7.2）。
// 正在建的那几秒抽屉锁住（拖不走、X 与暗幕都不理）。这一次打开铸一个 id（调用方每开一次就换 key
// 重挂一次）：默认那张脸按它派生，落库也用它。
import * as ExpoCrypto from "expo-crypto";
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { agentIdFromBytes, createAgentChecked } from "../../../src/shared/agentAdmin.js";
import { createNewAgentFlow, defaultPickFor, newAgentNameError, type NewAgentStep } from "../../../src/shared/newAgentForm.js";
import { clearAgentOnboarding, insertAgentRow, listAgentNames } from "../../../src/shared/supabaseWorkspacesApi.js";
import { AGENT_NAME_MAX } from "../../../src/shared/workspaceAgents.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { supabase } from "../supabase.js";
import { type as t, usePalette } from "../theme.js";
import { Button, Field, Note } from "../ui.js";
import { FacePreview, FaceWall } from "./FaceWall.js";

export function NewAgentSheet({ visible, ws, selfUid, onClose, onCreated, onExited }: {
  visible: boolean;
  ws: WorkspaceSnapshot;
  selfUid: string;
  /** 人不建了（X / 暗幕 / 下拽）：调用方把 visible 置 false */
  onClose: () => void;
  /** 行与私聊都成了：调用方刷新名册、收抽屉，退场放完再推它那条线。它 resolve 之前抽屉一直锁着 */
  onCreated: (agentId: string) => Promise<void>;
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
    // 一次打开一份：ws.id / selfUid / agentId 在这一次打开里不变（名册刷新换的是快照对象，不是这三格）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const nameError = newAgentNameError(name, ws.agents.map((a) => a.name));
  // 行已经落了（私聊没建成）：名字与脸都定了，改了也不会生效——锁住，钮只重试私聊
  const locked = busy || step !== "form";
  // 空着的时候不喊「名字不能为空」：人还没开始打字（「创建」照样按不动）
  const shownError = step === "form" && name.trim() !== "" ? nameError : null;
  const canSubmit = !busy && (step !== "form" || nameError === null);

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const r = await flow.submit({ name, avatarSlot: face.slot });
    setStep(flow.step());
    if (r.ok) {
      // 不解锁：调用方刷新名册、收抽屉，退场放完就把这一份卸了
      await onCreated(agentId);
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
    <BottomSheet
      visible={visible}
      title="新建智能体"
      closeLabel="不建了"
      locked={busy}
      onClose={close}
      {...(onExited === undefined ? {} : { onExited })}
    >
      <View style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", paddingTop: 4, paddingBottom: 12 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <FacePreview slot={face.slot} ring={c.card} />
          <View
            pointerEvents={locked ? "none" : "auto"}
            style={[{ alignSelf: "stretch", paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, gap: 6 }, locked && { opacity: 0.5 }]}
          >
            <Field
              value={name}
              onChangeText={setName}
              placeholder="给它取个名字"
              maxLength={AGENT_NAME_MAX}
              align="center"
              invalid={shownError !== null}
              returnKeyType="done"
            />
            {shownError !== null ? (
              <Text style={{ ...t.footnote, color: c.destructive, textAlign: "center" }}>{shownError}</Text>
            ) : null}
          </View>
          <View pointerEvents={locked ? "none" : "auto"} style={[{ alignSelf: "stretch" }, locked && { opacity: 0.5 }]}>
            <FaceWall current={face.id} onPick={setFace} />
          </View>
        </ScrollView>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
          {error !== null ? <Note tone="error">{error}</Note> : null}
          <Button
            label={busy ? "正在建…" : step === "linking" ? "再试一次" : "创建"}
            onPress={() => void submit()}
            disabled={!canSubmit}
          />
        </View>
      </View>
    </BottomSheet>
  );
}
