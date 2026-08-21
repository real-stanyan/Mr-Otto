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
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/lib/utils.js";
import { HEADER, HEADER_GHOST, HINT, MAIN_COL, SETTINGS_BODY } from "../App.js";
import { SidebarNub } from "./SidebarNub.js";
import { SubagentFields, useSubagentDraft, ERR_TXT } from "./SubagentFields.js";
import { SubagentScopeSelect } from "./SubagentScopeSelect.js";
import { useChat } from "../store.js";
import { subagentNameError } from "../../../shared/subagent.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import { blankSubagentDef, shadowedSubagent } from "../lib/newSubagent.js";
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
  const createSubagent = useChat((s) => s.createSubagent);
  const saveSubagent = useChat((s) => s.saveSubagent);
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

    // 作用域是所有落点的前提，整个流程钉在按下按钮那一刻的那一层上
    const scopeAtStart = useChat.getState().subagentScope;
    setBusy(true);
    setError(null);
    try {
      // 认准 createSubagent **回传**的那份清单，不去 store 里翻：store 那份会被
      // 作用域代次门挡掉（用户中途切一下作用域就查不到了），而文件其实已经建出来了
      const created = (await createSubagent(trimmed)).find((d) => d.name === trimmed);
      if (!created) {
        setError(
          `「${trimmed}」已经建在 ${scope.scopeDir} 了，但清单里没有它——去那个目录里手工把内容填上`
        );
        return;
      }
      if (useChat.getState().subagentScope !== scopeAtStart) {
        // 切了作用域就不能接着存：saveSubagent 用的是 store 里此刻那一层，拿这个
        // 名字去新那层查——查不到是白跑一趟，查到个同名的就是把内容写穿到另一个
        // 工程的定义上。空壳文件留在原来那层，切回去展开它接着编
        setError(
          `「${trimmed}」已经建好了，但你切了作用域，填的内容没写进去——切回${scope.current.label}在列表里展开它继续`
        );
        return;
      }
      // path / source / readOnly / scope 一律用刚建出来那份的磁盘现状，不用草稿里
      // 的（后端也会按名字重查一遍覆盖掉，但组件不该装作"知道"一个它没查过的路径）
      await saveSubagent({
        name: trimmed,
        ...draft.payload(),
        scope: created.scope,
        path: created.path,
        source: created.source,
        readOnly: created.readOnly,
      });
      onDone();
    } catch (e) {
      setError(bridgeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <span className="inline-flex items-baseline gap-[6px] flex-1 min-w-0">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground transition-colors duration-150"
            onClick={onCancel}
          >
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
              <SubagentScopeSelect scope={scope} id="new-subagent-scope" className="py-[7px]" />
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
