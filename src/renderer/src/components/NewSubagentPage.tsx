// 「新建子智能体」整页 —— 曾经是个只填名字的弹窗，其余字段建完再回列表里展开填。
//
// 换成整页不只是换个容器：弹窗那版落盘的是一份空壳（description 空着、工具是缺省
// 那几把、审批档 deny），用户要是在"回列表展开填"这一步走神，磁盘上就留下一个
// 没有 description 的定义——而 description 正是主 agent 挑人的唯一依据，空着的
// 那份模型永远派不出去，看上去像新建失败了。整页表单让"建出来"和"能用"是同一步。
//
// 落盘仍是两步（create 拿到真路径 → save 写内容）：主进程的 createSubagent 才是
// 唯一知道文件落在哪条根、名字有没有被占的一侧，渲染层猜的路径它一概不采信。
// 两步之间用户可能切了作用域，那时不能接着写（见 submit 里的第二道判断）。

import { useMemo, useState } from "react";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/lib/utils.js";
import { HEADER, HEADER_GHOST, HINT, MAIN_COL, SETTINGS_BODY } from "../settingsShell.js";
import { SidebarNub } from "./SidebarNub.js";
import { SubagentFields, useSubagentDraft, ERR_TXT } from "./SubagentFields.js";
import { SubagentScopeSelect } from "./SubagentScopeSelect.js";
import { useChat } from "../store.js";
import { subagentNameError } from "../../../shared/subagent.js";
import { blankSubagentDef, shadowedSubagent } from "../lib/newSubagent.js";
import { createSubagentFile } from "../lib/createSubagentFile.js";
import type { SubagentScopeView } from "../lib/useSubagentScope.js";

export function NewSubagentPage({
  scope,
  onDone,
  onCancel,
}: {
  scope: SubagentScopeView;
  /** 建好了 —— 回列表 */
  onDone: () => void;
  onCancel: () => void;
}) {
  const subagents = useChat((s) => s.subagents);

  const seed = useMemo(() => blankSubagentDef(scope.current.workspace ? "workspace" : "user"), []);
  const draft = useSubagentDraft(seed);

  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 撞名先说一声（不是拦住：工作区级盖住同名的用户级那份正是覆盖规则的用法）
  const shadowed = useMemo(() => shadowedSubagent(name, subagents), [name, subagents]);

  const submit = async () => {
    const trimmed = name.trim();
    // 与主进程同一条规则（shared 的 subagentNameError）：两边各写一条正则迟早
    // 分家，曾经就是这么破的——渲染层挡住了中文，主进程那侧把中文 replace 成
    // "-"，于是"搜索员"塌成"---"照样建了出来
    const nameError = subagentNameError(trimmed);
    if (nameError) {
      setError(nameError);
      return;
    }
    if (draft.blocked) return;

    setBusy(true);
    setError(null);
    // 落盘的两步（create 拿真路径 → save 写内容）和中途切作用域那道判断都在
    // createSubagentFile 里——三条建定义的路共用一份，漏掉那道判断的后果不是
    // 报个错，是把内容写穿到另一个工程的同名定义上
    const err = await createSubagentFile({
      name: trimmed,
      fields: draft.payload(),
      scopeLabel: scope.current.label,
      scopeDir: scope.scopeDir,
    });
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    onDone();
  };

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <span className="inline-flex items-baseline gap-[6px] flex-1 min-w-0">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground transition-colors duration-150 [&_svg]:align-[-3px] [&_svg]:me-[6px] [&_svg]:inline"
            onClick={onCancel}
          >
            <Bot className="size-4" />
            子智能体
          </button>
          <span className="text-muted-foreground/60">/</span>
          <span className="font-[650] truncate">新建</span>
        </span>
        <Button variant="ghost" size="sm" className={HEADER_GHOST} onClick={onCancel}>
          返回
        </Button>
      </header>

      <section className={SETTINGS_BODY}>
        <p className={HINT}>
          填完就落盘。建在<b>{scope.current.label}</b>这一层（<code>{scope.scopeDir}</code>）——
          「用户」处处可用，选中某个工程时只在该工程的会话里派得出去，同名时盖过用户级那份。
        </p>

        <div className="border border-border rounded-[10px] px-[14px] py-4 flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row sm:items-end gap-4">
            <div className="flex-1 flex flex-col gap-[6px] min-w-0">
              <label
                className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase"
                htmlFor="new-subagent-name"
              >
                名称
              </label>
              <Input
                id="new-subagent-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 code-reviewer"
                className="font-mono"
              />
            </div>
            <div className="flex flex-col gap-[6px] shrink-0">
              <label
                className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase"
                htmlFor="new-subagent-scope"
              >
                作用域
              </label>
              <SubagentScopeSelect scope={scope} id="new-subagent-scope" />
            </div>
          </div>
          {shadowed && (
            <p className={cn(HINT, "-mt-2")}>
              「{shadowed.name}」这个名字在
              <b>{shadowed.scope === "workspace" ? "工作区" : "用户"}</b>
              这一层已经有一份（{shadowed.source}）。建出来的这份会盖住它 —— 在这个作用域里，
              <code>task</code> 派到的会是新建的这份。
            </p>
          )}

          <SubagentFields draft={draft} />

          {error && <p className={ERR_TXT}>{error}</p>}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={busy || name.trim() === "" || draft.blocked}
              onClick={() => void submit()}
            >
              {busy ? "创建中…" : "创建"}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
