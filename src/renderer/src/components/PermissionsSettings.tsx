// PermissionsSettings — 设置页「权限」栏目（issue #370）。
// 两份文件的可视化入口：permissions.json（永久授权 key，审批卡点「永久允许」
// 产出）和 execPolicy.json（前缀规则，审批卡的「永久」也可能产出 allow 规则，
// forbidden 由用户手写）。撤销/删除热生效——审批链每次 decide 现读文件，
// 这页看到的和下一次判定用的是同一个事实。

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Trash2 } from "lucide-react";
import { HEADER, HINT, MAIN_COL, SETTINGS_BODY, SettingsTitle } from "../settingsShell.js";
import { SidebarNub } from "./SidebarNub.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import { describeGrantKey, describeExecPattern } from "../lib/grantDisplay.js";
import type { PermissionsSnapshot } from "../../../shared/shellBridge.js";
import type { ExecRule } from "../../../shared/execPolicy.js";

const DECISION_LABEL: Record<string, string> = {
  allow: "放行",
  prompt: "弹卡",
  forbidden: "禁止",
};

export function PermissionsSettings() {
  // null = 还没从主进程读到（同 AutoCompactSettings 的 loaded 模式）
  const [snap, setSnap] = useState<PermissionsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.otter
      .listPermissions()
      .then((s) => { if (!cancelled) setSnap(s); })
      .catch((e: unknown) => { if (!cancelled) setError(bridgeErrorMessage(e)); });
    return () => { cancelled = true; };
  }, []);

  const revoke = (key: string) => {
    setError(null);
    window.otter
      .revokeGrant(key)
      .then(setSnap)
      .catch((e: unknown) => setError(bridgeErrorMessage(e)));
  };

  const removeRule = (rule: ExecRule) => {
    setError(null);
    window.otter
      .removeExecRule(rule)
      .then(setSnap)
      .catch((e: unknown) => setError(bridgeErrorMessage(e)));
  };

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="permissions" />
      </header>
      <div className={SETTINGS_BODY}>
        {error && <p className="text-xs text-err">{error}</p>}

        <section className="space-y-2">
          <h3 className="text-sm font-[650]">永久授权</h3>
          <p className={HINT}>
            审批卡上点「永久允许」落在这里（permissions.json）。撤销后立即生效——下一次同样的操作会重新弹审批。
          </p>
          {snap !== null && snap.grants.length === 0 && (
            <p className="text-xs text-muted-foreground">还没有永久授权。</p>
          )}
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {(snap?.grants ?? []).map((key) => {
              const g = describeGrantKey(key);
              return (
                <li key={key} className="flex items-center gap-2 px-3 py-2">
                  <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px]">
                    {g.tool}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={g.detail ?? ""}>
                    {g.detail ?? (g.legacy ? "整个工具放行（旧条目，宽语义）" : "该工具的所有调用")}
                  </span>
                  {g.cwd !== undefined && (
                    <span className="hidden max-w-[30%] truncate text-[11px] text-muted-foreground sm:inline" title={g.cwd}>
                      {g.cwd}
                    </span>
                  )}
                  <Button variant="ghost" size="icon-sm" title="撤销这条授权" onClick={() => revoke(key)}>
                    <Trash2 />
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-[650]">命令规则</h3>
          <p className={HINT}>
            execPolicy.json 的前缀规则：禁止（手写，永不放行）/ 放行（审批卡「永久」产出的一类）。删除后立即生效。
          </p>
          {snap?.execError !== undefined && (
            <p className="rounded-lg border border-err/40 bg-err/5 px-3 py-2 text-xs text-err">
              文件没通过校验，规则未生效（fail-safe，一切照旧弹审批）：{snap.execError}
            </p>
          )}
          {snap !== null && snap.execError === undefined && snap.execRules.length === 0 && (
            <p className="text-xs text-muted-foreground">还没有规则。</p>
          )}
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {(snap?.execRules ?? []).map((rule, i) => (
              <li key={`${i}-${describeExecPattern(rule.pattern)}`} className="flex items-center gap-2 px-3 py-2">
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
                    rule.decision === "forbidden"
                      ? "bg-err/10 text-err"
                      : rule.decision === "allow"
                        ? "bg-brand/10 text-brand"
                        : "bg-foreground/[0.06]"
                  }`}
                >
                  {DECISION_LABEL[rule.decision] ?? rule.decision}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={describeExecPattern(rule.pattern)}>
                  {describeExecPattern(rule.pattern)}
                </span>
                {rule.cwd !== undefined && (
                  <span className="hidden max-w-[30%] truncate text-[11px] text-muted-foreground sm:inline" title={rule.cwd}>
                    {rule.cwd}
                  </span>
                )}
                <Button variant="ghost" size="icon-sm" title="删除这条规则" onClick={() => removeRule(rule)}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
