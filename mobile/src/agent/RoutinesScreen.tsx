// 一只智能体的定时任务列表（#1283，spec §8.2）：重复 / 一次性 / 已完成三段；开关直接拨；右上「+」手动新建。
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useLayoutEffect, useState } from "react";
import { Switch } from "react-native";
import { nextRunAt, scheduleText, ROUTINES_ENABLED_MAX, type RoutineRow } from "../../../src/shared/routines.js";
import { deleteRoutine, insertRoutine, updateRoutine } from "../../../src/shared/supabaseRoutinesApi.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { supabase } from "../supabase.js";
import { usePalette } from "../theme.js";
import { Group, Hint, Inset, ListPage, Note, Row } from "../ui.js";
import { HeaderIconButton } from "../wx/TabHeader.js";
import { Icon } from "../wx/Icon.js";
import { RoutineEditDialog, type RoutineDraft } from "./RoutineEditDialog.js";
import { useRoutines } from "./routinesStore.js";

const statusText = (r: RoutineRow): string =>
  r.lastStatus === "done" ? "已执行" : r.lastStatus === "missed" ? "错过了" : r.lastStatus === "skipped_quota" ? "额度不够没跑" : r.lastStatus === "failed" ? "没跑成" : "";
const capText = `启用中的最多 ${ROUTINES_ENABLED_MAX} 条`;
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function RoutinesScreen() {
  const { c } = usePalette();
  const route = useRoute<RouteProp<RootStackParams, "Routines">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const home = useHome();
  const ws = home.home;
  const agentId = route.params.agentId;
  const routines = useRoutines(ws?.id ?? "", agentId);
  const [editing, setEditing] = useState<{ row: RoutineRow | null; key: number; visible: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 开关拨下去那一刻先按人拨的样子画，服务器回来再对账——不然要等一个来回才动，手感是坏的 */
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});

  // 从别处（私聊里跟它说一句建的）回来也要看见新的
  const { refresh } = routines;
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderIconButton label="新建定时任务" onPress={() => { setError(null); setEditing({ row: null, key: Date.now(), visible: true }); }}>
          <Icon name="plus" size={22} color={c.foreground} />
        </HeaderIconButton>
      ),
    });
  }, [navigation, c.foreground]);

  if (ws === null || home.selfUid === null) return null;
  const selfUid = home.selfUid;
  const enabledCount = (except?: string): number => routines.rows.filter((x) => x.enabled && x.id !== except).length;
  const close = (): void => setEditing((e) => (e === null ? e : { ...e, visible: false }));

  const toggle = async (r: RoutineRow, on: boolean): Promise<void> => {
    setError(null);
    setFlipped((f) => ({ ...f, [r.id]: on }));
    try {
      if (on && enabledCount(r.id) >= ROUTINES_ENABLED_MAX) throw new Error(capText);
      const next = on ? nextRunAt(r.schedule, r.tz, Date.now()) : null;
      if (on && next === null) throw new Error("这个时刻已经过了，点进去改个时间");
      await updateRoutine(supabase, r.id, { enabled: on, nextRunAt: next });
      await routines.refresh();
    } catch (e) {
      setError(why(e));
    } finally {
      setFlipped((f) => { const { [r.id]: _gone, ...rest } = f; return rest; });
    }
  };

  const save = async (d: RoutineDraft, row: RoutineRow | null): Promise<void> => {
    if (row === null) {
      if (enabledCount() >= ROUTINES_ENABLED_MAX) throw new Error(capText);
      const next = nextRunAt(d.schedule, d.tz, Date.now());
      // 先保证私聊存在（runtime 对私聊幂等）：到点 runtime 按私聊找房，没有私聊这条任务没有归宿
      const made = await cloudClient.create(ws.id, { kind: "dm", agentId });
      if (!made.ok) throw new Error(made.message);
      await insertRoutine(supabase, { workspaceId: ws.id, agentId, ownerUid: selfUid, ...d, nextRunAt: next });
    } else {
      // 只有时间 / 时区动了、或这条本来是关着的，才重算下一跳：只改个标题不能把「一分钟后到点」的那一跳顺手跳过去
      const rescheduled = JSON.stringify(d.schedule) !== JSON.stringify(row.schedule) || d.tz !== row.tz || !row.enabled;
      if (!row.enabled && enabledCount() >= ROUTINES_ENABLED_MAX) throw new Error(capText);
      await updateRoutine(supabase, row.id, {
        title: d.title, instruction: d.instruction, schedule: d.schedule, tz: d.tz,
        ...(rescheduled ? { enabled: true, nextRunAt: nextRunAt(d.schedule, d.tz, Date.now()) } : {}),
      });
    }
    await routines.refresh();
  };

  const live = routines.rows.filter((r) => r.enabled || (r.lastStatus !== "done" && r.lastStatus !== "missed"));
  const recurring = live.filter((r) => r.schedule.kind !== "once");
  const once = live.filter((r) => r.schedule.kind === "once");
  const finished = routines.rows.filter((r) => !r.enabled && (r.lastStatus === "done" || r.lastStatus === "missed"));
  const open = (r: RoutineRow): void => { setError(null); setEditing({ row: r, key: Date.now(), visible: true }); };
  const rowOf = (r: RoutineRow, done = false) => (
    <Row
      key={r.id}
      label={r.title}
      detail={`${scheduleText(r.schedule, r.tz)}${done ? ` · ${statusText(r)}` : r.lastStatus !== null && r.lastStatus !== "done" ? ` · 上次${statusText(r)}` : ""}`}
      onPress={() => open(r)}
      // 开关在右边、整行点开编辑：开关后面不再跟 ›（两个「可以点」叠在一起读不清）
      {...(done ? { chevron: true } : { trailing: <Switch value={flipped[r.id] ?? r.enabled} onValueChange={(v) => void toggle(r, v)} accessibilityLabel={`${r.title} 开关`} /> })}
    />
  );

  return (
    <ListPage>
      {routines.loaded && routines.rows.length === 0 ? <Inset><Hint>跟它说一句「每天早上九点……」就能建，也可以点右上角自己加。</Hint></Inset> : null}
      {recurring.length > 0 ? <Group header="重复">{recurring.map((r) => rowOf(r))}</Group> : null}
      {once.length > 0 ? <Group header="一次性">{once.map((r) => rowOf(r))}</Group> : null}
      {finished.length > 0 ? <Group header="已完成" footer="跑完的一次性任务留 7 天">{finished.map((r) => rowOf(r, true))}</Group> : null}
      {error !== null ? <Inset><Note tone="error">{error}</Note></Inset> : null}
      {editing !== null ? (
        <RoutineEditDialog
          key={editing.key}
          visible={editing.visible}
          initial={editing.row}
          onSave={(d) => save(d, editing.row)}
          {...(editing.row !== null
            ? { onDelete: async () => { await deleteRoutine(supabase, editing.row!.id); await routines.refresh(); } }
            : {})}
          onClose={close}
          onExited={() => setEditing(null)}
        />
      ) : null}
    </ListPage>
  );
}
