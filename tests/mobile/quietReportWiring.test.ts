// 免打扰与汇报（#1569，ADR-0365）在手机端的接线。判据在 shared 真跑（quietHours.test），这里读源码钉住：
// ① notifyStore 单独一问 quiet/report/tz（0060 没跑不拖累四个开关）、存只写三列并清 report_next_at；
// ② 设置页一行进 QuietHours；③ 那一页：读不到说清、两段各自开关、保存走 setQuietSettings、时区按手机。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("notifyStore", () => {
  const src = read("mobile/src/push/notifyStore.ts");
  it("单独一问 quiet / report / tz；读不到 = null；存只写三列 + 清 report_next_at；42703 说人话", () => {
    expect(src).toMatch(/supabase\.from\("notify_prefs"\)\.select\("quiet, report, tz"\)\.eq\("uid", me\)\.maybeSingle\(\)/);
    expect(src).toMatch(/quiet: qrow === null \? null : \{ quiet: parseQuietWindow\(qrow\.quiet\), report: parseReportPlan\(qrow\.report\), tz: typeof qrow\.tz === "string" \? qrow\.tz : null \}/);
    expect(src).toMatch(/\.upsert\(\{ uid: me, quiet: next\.quiet, report: next\.report, tz: next\.tz, report_next_at: null, updated_at: new Date\(\)\.toISOString\(\) \}, \{ onConflict: "uid" \}\)/);
    expect(src).toMatch(/error\.code === "42703" \? "服务器还没准备好这一项（迁移 0060 没跑）"/);
  });
});

describe("设置页 / 导航", () => {
  it("设置页一行进 QuietHours；路由与导航器都登记了", () => {
    expect(read("mobile/src/account/SettingsScreen.tsx")).toMatch(/navigation\.navigate\("QuietHours"\)/);
    expect(read("mobile/src/nav/types.ts")).toMatch(/QuietHours: undefined;/);
    expect(read("mobile/src/nav/RootNavigator.tsx")).toMatch(/<Root\.Screen name="QuietHours" component=\{QuietHoursScreen\} options=\{\{ title: "免打扰与汇报" \}\} \/>/);
  });
});

describe("QuietHoursScreen", () => {
  const src = read("mobile/src/account/QuietHoursScreen.tsx");
  it("读不到（null）说清 0060；两段各自开关；保存走 setQuietSettings，时区按手机；时刻坏了不让存", () => {
    expect(src).toMatch(/迁移 0060 没跑/);
    expect(src).toMatch(/<Row label="开启免打扰" trailing=\{<Switch value=\{quietOn\}/);
    expect(src).toMatch(/<Row label="定时汇报" trailing=\{<Switch value=\{reportOn\}/);
    expect(src).toMatch(/await setQuietSettings\(\{ quiet: quietDraft, report: reportDraft, tz: deviceTz \}\)/);
    expect(src).toMatch(/const deviceTz = Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone;/);
    expect(src).toMatch(/if \(saving \|\| quietBad \|\| reportBad\) return;/);
    expect(src).toMatch(/\(\["message", "call"\] as const\)\.map/);
  });
});
