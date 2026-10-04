// 免打扰与汇报（#1569，ADR-0366）：设置页里的一页——一段免打扰时段（期间手机不推消息，管理员替你收着），
// 一条汇报计划（每天 / 按星期几的某个时刻，管理员打电话或发消息把这段时间的朋友消息与代办汇报给你）。
// 两样都存在 notify_prefs 上（quiet / report / tz），改完就存；0062 没跑时整页说清、不画成能改的样子。
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import {
  REPORT_MODE_LABEL, parseQuietWindow, parseReportPlan, quietWindowText, reportPlanText, type QuietWindow, type ReportMode, type ReportPlan,
} from "../../../src/shared/quietHours.js";
import { setQuietSettings, useNotify } from "../push/notifyStore.js";
import { usePalette, withAlpha } from "../theme.js";
import { Field, Group, Inset, Note, Row, Spinner } from "../ui.js";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"] as const;

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const { c } = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress} style={({ pressed }) => [{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: on ? c.brand : withAlpha(c.foreground, 0.06) }, pressed && { opacity: 0.7 }]}>
      <Text style={{ fontSize: 13, color: on ? "#fff" : c.foreground }}>{label}</Text>
    </Pressable>
  );
}

function DayChips({ days, onChange }: { days: number[] | undefined; onChange: (d: number[] | undefined) => void }) {
  const all = days === undefined;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
      <Chip label="每天" on={all} onPress={() => onChange(undefined)} />
      {WEEK.map((w, i) => {
        const d = i + 1;
        const on = !all && (days ?? []).includes(d);
        return <Chip key={w} label={`周${w}`} on={on} onPress={() => {
          const cur = all ? [1, 2, 3, 4, 5, 6, 7] : [...(days ?? [])];
          const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b);
          onChange(next.length === 0 ? undefined : next.length === 7 ? undefined : next);
        }} />;
      })}
    </View>
  );
}

export function QuietHoursScreen() {
  const { c } = usePalette();
  const notify = useNotify();
  const q = notify.quiet;
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 草稿：开关关着时也留着上次的时刻，再打开不用重填
  const [quietOn, setQuietOn] = useState(q?.quiet !== null && q?.quiet !== undefined);
  const [qStart, setQStart] = useState(q?.quiet?.start ?? "22:00");
  const [qEnd, setQEnd] = useState(q?.quiet?.end ?? "08:00");
  const [qDays, setQDays] = useState<number[] | undefined>(q?.quiet?.days);
  const [reportOn, setReportOn] = useState(q?.report !== null && q?.report !== undefined);
  const [rTime, setRTime] = useState(q?.report?.schedule.time ?? "09:00");
  const [rDays, setRDays] = useState<number[] | undefined>(q?.report?.schedule.kind === "weekly" ? q.report.schedule.days : undefined);
  const [rMode, setRMode] = useState<ReportMode>(q?.report?.mode ?? "message");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const quietDraft = useMemo<QuietWindow | null>(() => (quietOn ? parseQuietWindow({ start: qStart, end: qEnd, days: qDays }) : null), [quietOn, qStart, qEnd, qDays]);
  const reportDraft = useMemo<ReportPlan | null>(
    () => (reportOn ? parseReportPlan({ mode: rMode, schedule: rDays === undefined ? { kind: "daily", time: rTime } : { kind: "weekly", days: rDays, time: rTime } }) : null),
    [reportOn, rMode, rTime, rDays],
  );
  const quietBad = quietOn && quietDraft === null;
  const reportBad = reportOn && reportDraft === null;

  const save = async (): Promise<void> => {
    if (saving || quietBad || reportBad) return;
    setSaving(true);
    setErr(null);
    const r = await setQuietSettings({ quiet: quietDraft, report: reportDraft, tz: deviceTz });
    setSaving(false);
    if (!r.ok) setErr(r.message);
  };

  if (q === undefined) {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.background }}><Spinner /></View>;
  }
  if (q === null) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: c.background }} contentContainerStyle={{ paddingVertical: 16 }}>
        <Inset><Note tone="warn">服务器还没准备好这一项（迁移 0062 没跑），暂时设不了。</Note></Inset>
      </ScrollView>
    );
  }
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.background }} contentContainerStyle={{ paddingVertical: 8, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Group header="免打扰" footer={quietOn ? `${quietDraft !== null ? quietWindowText(quietDraft) : "时刻要写成 HH:mm"}。期间手机不推消息，朋友的消息和代办由管理员替你收着，到汇报时间一起说。` : "关着：消息照常推到手机。"}>
        <Row label="开启免打扰" trailing={<Switch value={quietOn} onValueChange={setQuietOn} accessibilityLabel="开启免打扰" />} />
        {quietOn ? (
          <View style={{ gap: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={{ fontSize: 15, color: c.foreground, width: 40 }}>从</Text>
              <View style={{ flex: 1 }}><Field value={qStart} onChangeText={setQStart} placeholder="22:00" variant="dialog" keyboardType="numbers-and-punctuation" maxLength={5} /></View>
              <Text style={{ fontSize: 15, color: c.foreground, width: 40, textAlign: "center" }}>到</Text>
              <View style={{ flex: 1 }}><Field value={qEnd} onChangeText={setQEnd} placeholder="08:00" variant="dialog" keyboardType="numbers-and-punctuation" maxLength={5} /></View>
            </View>
          </View>
        ) : null}
        {quietOn ? <DayChips days={qDays} onChange={setQDays} /> : null}
      </Group>
      <Group header="管理员汇报" footer={reportOn ? `${reportDraft !== null ? reportPlanText(reportDraft) : "时刻要写成 HH:mm"}。到点管理员把上一次汇报之后收到的朋友消息与代办任务汇报给你；打电话没接会改成写在它的聊天里。` : "关着：不主动汇报，想看自己去问管理员。"}>
        <Row label="定时汇报" trailing={<Switch value={reportOn} onValueChange={setReportOn} accessibilityLabel="定时汇报" />} />
        {reportOn ? (
          <View style={{ gap: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={{ fontSize: 15, color: c.foreground, width: 40 }}>时刻</Text>
              <View style={{ flex: 1 }}><Field value={rTime} onChangeText={setRTime} placeholder="09:00" variant="dialog" keyboardType="numbers-and-punctuation" maxLength={5} /></View>
            </View>
          </View>
        ) : null}
        {reportOn ? <DayChips days={rDays} onChange={setRDays} /> : null}
        {reportOn ? (
          <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
            {(["message", "call"] as const).map((m) => <Chip key={m} label={REPORT_MODE_LABEL[m]} on={rMode === m} onPress={() => setRMode(m)} />)}
          </View>
        ) : null}
      </Group>
      <Group footer={`时区按这台手机：${deviceTz}。`}>
        <Row label={saving ? "保存中…" : "保存"} align="center" {...(saving || quietBad || reportBad ? {} : { onPress: () => void save() })} />
      </Group>
      {err !== null ? <Inset><Note tone="error">{err}</Note></Inset> : null}
      {notify.error !== null ? <Inset><Note tone="error">{notify.error}</Note></Inset> : null}
    </ScrollView>
  );
}
