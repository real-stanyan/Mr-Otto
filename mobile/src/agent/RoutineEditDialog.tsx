// 定时任务的编辑弹窗（#1283，spec §8.3）：居中 Dialog（表单类不用抽屉）。新建与编辑同一张；校验走 shared 的 routineErrors。
// 弹窗自己带竖向滚动（dialog.tsx 的卡超高就在卡里滚），这里不再套第二层竖向 ScrollView。
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  formatInTz, isIanaTimeZone, nextRunAt, parseRoutineSchedule, routineErrors, scheduleText, zonedParts,
  ROUTINE_INSTRUCTION_MAX, ROUTINE_TITLE_MAX, type RoutineRow, type RoutineSchedule,
} from "../../../src/shared/routines.js";
import { Dialog, DialogBody, DialogFooter, DialogTitle } from "../dialog.js";
import { type as t, usePalette, withAlpha } from "../theme.js";
import { Button, Field, Labeled } from "../ui.js";
import { TimeWheel } from "./TimeWheel.js";

type Kind = RoutineSchedule["kind"];
const KINDS: { k: Kind; label: string }[] = [{ k: "once", label: "一次" }, { k: "daily", label: "每天" }, { k: "weekly", label: "每周" }, { k: "every", label: "时段内重复" }, { k: "monthly", label: "每月" }];
/** every 的间隔档（#1659）：工具那边 5..720 都收，表单只给常用的几档 */
const STEPS = [10, 15, 30, 60];
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
/** Intl.supportedValuesOf 在这个引擎上可能没有（Hermes）：退回常用的几个，其余靠手打 IANA 名字 */
const COMMON_ZONES = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Asia/Seoul", "Asia/Singapore", "Australia/Sydney", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "UTC"];

const pad = (n: number): string => String(n).padStart(2, "0");

/** 从今天起 30 天的 YYYY-MM-DD——「今天」按**所选时区**算：人在悉尼给上海的闹钟挑日期，今天是上海的今天 */
function dateOptions(tz: string): string[] {
  const out: string[] = [];
  const today = zonedParts(Date.now(), tz);
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.UTC(today.y, today.m - 1, today.d + i, 12));
    out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  return out;
}

export interface RoutineDraft { title: string; instruction: string; schedule: RoutineSchedule; tz: string }

/** 一颗小选项（种类 / 日期 / 星期几）：选中 = 点缀色 18% 底 + 点缀色字（蓝实底留给弹窗底下那颗主钮）。按下就缩 0.97，不等抬手 */
function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const { c } = usePalette();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={({ pressed }) => ({
        minHeight: 36, minWidth: 44, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", borderRadius: 18,
        backgroundColor: on ? withAlpha(c.brand, 0.18) : c.field,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <Text style={{ ...t.callout, fontWeight: on ? "600" : "400", color: on ? c.brand : c.foreground }}>{label}</Text>
    </Pressable>
  );
}

export function RoutineEditDialog({ visible, initial, onSave, onDelete, onClose, onExited }: {
  visible: boolean;
  /** null = 新建 */
  initial: RoutineRow | null;
  /** 存。抛出来的那句话画在弹窗里；成功了本弹窗自己调 onClose */
  onSave: (d: RoutineDraft) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [instruction, setInstruction] = useState(initial?.instruction ?? "");
  const [kind, setKind] = useState<Kind>(initial?.schedule.kind ?? "daily");
  const [time, setTime] = useState(initial === null ? "09:00" : initial.schedule.kind === "once" ? initial.schedule.at.slice(11, 16) : initial.schedule.kind === "every" ? initial.schedule.from : initial.schedule.time);
  const [until, setUntil] = useState(initial?.schedule.kind === "every" ? initial.schedule.to : "22:00");
  const [step, setStep] = useState(initial?.schedule.kind === "every" ? initial.schedule.minutes : 30);
  const [tz, setTz] = useState(initial?.tz ?? deviceTz);
  const [date, setDate] = useState(initial?.schedule.kind === "once" ? initial.schedule.at.slice(0, 10) : dateOptions(initial?.tz ?? deviceTz)[0]!);
  const [days, setDays] = useState<number[]>(
    initial?.schedule.kind === "weekly" ? initial.schedule.days : initial?.schedule.kind === "every" ? initial.schedule.days ?? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5],
  );
  const [monthDays, setMonthDays] = useState<number[]>(initial?.schedule.kind === "monthly" ? initial.schedule.days : [1]);
  const [tzOpen, setTzOpen] = useState(false);
  const [tzQuery, setTzQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const schedule = useMemo(
    (): unknown =>
      kind === "once" ? { kind, at: `${date}T${time}` }
      : kind === "daily" ? { kind, time }
      : kind === "every" ? { kind, minutes: step, from: time, to: until, ...(days.length === 7 ? {} : { days }) }
      : kind === "monthly" ? { kind, days: monthDays, time }
      : { kind, days, time },
    [kind, date, time, days, step, until, monthDays],
  );
  const problem = routineErrors({ title, instruction, schedule, tz });
  const parsed = problem === null ? parseRoutineSchedule(schedule) : null;
  const next = parsed === null ? null : nextRunAt(parsed, tz, Date.now());
  const dates = useMemo(() => dateOptions(tz), [tz]);
  const tzList = useMemo(() => {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? COMMON_ZONES;
    const q = tzQuery.trim().toLowerCase();
    const hit = (q === "" ? all : all.filter((z) => z.toLowerCase().includes(q))).slice(0, 40);
    // 手打的完整 IANA 名字：列表里没有它也能选
    const typed = tzQuery.trim();
    return typed !== "" && isIanaTimeZone(typed) && !hit.includes(typed) ? [typed, ...hit] : hit;
  }, [tzQuery]);

  const edit = <T,>(set: (v: T) => void) => (v: T): void => { setError(null); set(v); };
  const save = async (): Promise<void> => {
    if (busy) return;
    if (problem !== null) { setError(problem); return; }
    if (parsed === null || next === null) { setError("这个时刻已经过了，换一个将来的时间"); return; }
    setBusy(true);
    setError(null);
    try {
      await onSave({ title: title.trim(), instruction: instruction.trim(), schedule: parsed, tz });
      onClose(); // busy 不放回：弹窗在退场，别让那 140ms 里的一次点击再存一遍
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const remove = (): void => {
    if (onDelete === undefined || busy) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy(true);
    onDelete().then(onClose).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setBusy(false); setConfirmDelete(false); });
  };

  // 标题 / 内容还空着时不催（新开的弹窗一上来就红字是在骂人）；其余毛病（没选星期、时区不对）要说出来，按钮灰着人才知道为什么
  const quiet = title.trim() === "" || instruction.trim() === "";
  const hint = error ?? (problem !== null ? (quiet ? "" : problem) : next === null ? "这个时刻已经过了，换一个将来的时间" : `下次 ${formatInTz(next, tz)}`);
  return (
    <Dialog visible={visible} wide {...(onExited ? { onExited } : {})}>
      <DialogTitle>{initial === null ? "新建定时任务" : "定时任务"}</DialogTitle>
      <DialogBody>
        <View style={{ gap: 14 }}>
          <Labeled label="标题" error={null}>
            <Field value={title} onChangeText={edit(setTitle)} placeholder="比如：早报" maxLength={ROUTINE_TITLE_MAX} variant="dialog" editable={!busy} />
          </Labeled>
          <Labeled label="到点要做什么" hint="它会照这段话去做" error={null}>
            <Field value={instruction} onChangeText={edit(setInstruction)} placeholder="比如：看一眼昨天的销售报表，有异常告诉我" maxLength={ROUTINE_INSTRUCTION_MAX} variant="dialog" multiline editable={!busy} />
          </Labeled>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {KINDS.map((k) => <Chip key={k.k} label={k.label} on={kind === k.k} onPress={() => edit(setKind)(k.k)} />)}
          </View>
          {kind === "once" ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
              {dates.map((d, i) => <Chip key={d} label={i === 0 ? "今天" : i === 1 ? "明天" : d.slice(5)} on={date === d} onPress={() => edit(setDate)(d)} />)}
            </ScrollView>
          ) : null}
          {kind === "weekly" || kind === "every" ? (
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              {WEEK.map((w, i) => (
                <Chip key={w} label={w} on={days.includes(i + 1)} onPress={() => edit(setDays)(days.includes(i + 1) ? days.filter((x) => x !== i + 1) : [...days, i + 1].sort((a, b) => a - b))} />
              ))}
            </View>
          ) : null}
          {kind === "monthly" ? (
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <Chip key={d} label={d === 31 ? "月底" : String(d)} on={monthDays.includes(d)} onPress={() => edit(setMonthDays)(monthDays.includes(d) ? monthDays.filter((x) => x !== d) : [...monthDays, d].sort((a, b) => a - b))} />
              ))}
            </View>
          ) : null}
          {kind === "every" ? (
            <>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {STEPS.map((m) => <Chip key={m} label={m === 60 ? "每小时" : `每 ${m} 分钟`} on={step === m} onPress={() => edit(setStep)(m)} />)}
              </View>
              <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>从</Text>
              <TimeWheel value={time} onChange={edit(setTime)} />
              <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>到</Text>
              <TimeWheel value={until} onChange={edit(setUntil)} />
            </>
          ) : (
            <TimeWheel value={time} onChange={edit(setTime)} />
          )}
          <Pressable onPress={() => setTzOpen((v) => !v)} accessibilityRole="button" hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
            <Text style={{ ...t.footnote, color: c.mutedForeground, textAlign: "center" }}>
              时区 {tz}{tz !== deviceTz ? "（不是这台设备的）" : ""} · <Text style={{ color: c.brand }}>{tzOpen ? "收起" : "更换"}</Text>
            </Text>
          </Pressable>
          {tzOpen ? (
            <View style={{ gap: 6 }}>
              <Field value={tzQuery} onChangeText={setTzQuery} placeholder="搜城市 / 地区，比如 Sydney" variant="dialog" />
              <ScrollView style={{ maxHeight: 160 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                {tzList.map((z) => (
                  <Pressable key={z} onPress={() => { if (isIanaTimeZone(z)) { setError(null); setTz(z); } setTzOpen(false); setTzQuery(""); }} style={{ paddingVertical: 9, paddingHorizontal: 4 }}>
                    <Text style={{ ...t.body, color: z === tz ? c.brand : c.foreground }}>{z}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}
          {hint !== "" ? <Text style={{ ...t.footnote, textAlign: "center", color: error !== null ? c.destructive : c.mutedForeground }}>{hint}</Text> : null}
          {initial !== null && onDelete !== undefined ? (
            <Button label={confirmDelete ? "再点一次，确定删除" : "删除这条任务"} variant="destructive" size="dialog" disabled={busy} onPress={remove} />
          ) : null}
        </View>
      </DialogBody>
      <DialogFooter
        left={{ label: "取消", onPress: onClose, disabled: busy }}
        right={{ label: busy ? "正在存…" : initial === null ? "建好" : "保存", onPress: () => void save(), disabled: busy || problem !== null || next === null }}
      />
    </Dialog>
  );
}
