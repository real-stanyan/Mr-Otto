// 「编辑子智能体」整页 —— 列表行点开后跳过来的那一页,和 NewSubagentPage 同一副骨架
// (面包屑头 + 同一组 SubagentFields)。
//
// 曾经是列表行里 <details> 原地展开:九个字段撑在一行下面,列表其它行被推到屏幕外,
// 改完还得自己把行收起来;两份同时展开时哪份的「保存」是哪份的也得靠数。换成整页后
// 列表只剩"挑哪一个",编辑只剩"改这一个"——两件事两张页,和新建那页对称。
//
// 草稿只活在这一页上:返回列表即丢弃未保存的改动,再进来从磁盘现状重新开始,
// 不留一份看不见的脏状态(和原来 <details> 收起时 reset 的约定相同)。
//
// 内置那份也走这一页,只读展示 + 「改成我自己的一份」:在当前作用域写出同名定义
// 盖住它(materialize 的取舍见 SubagentSettings 的头注)。

import { useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { HEADER, HEADER_GHOST, HINT, MAIN_COL, SETTINGS_BODY } from "../App.js";
import { SidebarNub } from "./SidebarNub.js";
import { SubagentFields, useSubagentDraft, ERR_TXT } from "./SubagentFields.js";
import { useChat } from "../store.js";
import type { SubagentDef } from "../../../shared/shellBridge.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import { freeCopyName } from "../lib/subagentScopes.js";
import { createSubagentFile, fileFieldsOf } from "../lib/createSubagentFile.js";
import type { SubagentScopeView } from "../lib/useSubagentScope.js";

export function EditSubagentPage({
  def,
  scope,
  onBack,
}: {
  def: SubagentDef;
  scope: SubagentScopeView;
  onBack: () => void;
}) {
  const saveSubagent = useChat((s) => s.saveSubagent);
  const draft = useSubagentDraft(def);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [copiedAs, setCopiedAs] = useState<string | null>(null);

  const editable = !def.builtin && !def.readOnly;

  const save = async () => {
    if (draft.blocked) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveSubagent({
        name: def.name,
        ...draft.payload(),
        scope: def.scope,
        path: def.path,
        source: def.source,
        readOnly: def.readOnly,
      });
    } catch (e) {
      setSaveError(bridgeErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  // 内置:同名写出一份盖住它。只读的磁盘定义:加后缀另存一份(「复制」的意思是多一份
  // 能改的副本,不是把眼前这份顶掉;顶掉该是用户明说的动作)。
  // 抄的都是**磁盘/代码现状**(def)而不是草稿:这两种都没有"改了但没存"的状态
  const materialize = async () => {
    const name = def.builtin
      ? def.name
      : freeCopyName(def.name, useChat.getState().subagents.map((d) => d.name));
    setCopying(true);
    setCopyError(null);
    setCopiedAs(null);
    const err = await createSubagentFile({
      name,
      fields: fileFieldsOf(def),
      scopeLabel: scope.current.label,
      scopeDir: scope.scopeDir,
    });
    setCopyError(err);
    if (!err) setCopiedAs(name);
    setCopying(false);
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(def.path);
    } catch {
      // 剪贴板权限被拒/不可用:静默失败——这只是个便利动作,不值得再弹一条错误
    }
  };

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <span className="inline-flex items-baseline gap-[6px] flex-1 min-w-0">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground transition-colors duration-150 [&_svg]:align-[-3px] [&_svg]:me-[6px] [&_svg]:inline"
            onClick={onBack}
          >
            <Bot className="size-4" />
            子智能体
          </button>
          <span className="text-muted-foreground/60">/</span>
          <span className="font-mono font-[650] text-brand truncate">{def.name}</span>
          {def.builtin && <Badge variant="secondary" className="shrink-0">内置</Badge>}
          {!def.builtin && def.readOnly && (
            <Badge variant="secondary" className="shrink-0">只读</Badge>
          )}
          {!def.builtin && scope.showScope && (
            <Badge variant="outline" className="shrink-0 text-muted-foreground" title={`来自 ${def.source}`}>
              {def.scope === "workspace" ? "工作区" : "用户"}
            </Badge>
          )}
        </span>
        <Button variant="ghost" size="sm" className={HEADER_GHOST} onClick={onBack}>
          返回
        </Button>
      </header>

      <section className={SETTINGS_BODY}>
        {def.builtin ? (
          <p className={HINT}>
            随 app 一起发的，不在磁盘上，删不掉也改不了。「改成我自己的一份」会在
            <b>{scope.current.label}</b>这一层写出一份同名定义盖住它，从此它是你的
            （代价：以后升级改了内置的正文或工具集，你这份跟不上）。
          </p>
        ) : (
          <p className={HINT} title={def.path}>
            <code>{def.path}</code>
            {def.readOnly && " —— 这份是只读的，想改就先复制到当前作用域。"}
          </p>
        )}

        <div className="border border-border rounded-[10px] px-[14px] py-4 flex flex-col gap-4">
          <SubagentFields draft={draft} readOnly={!editable} />

          {saveError && <p className={ERR_TXT}>{saveError}</p>}
          {copyError && <p className={ERR_TXT}>{copyError}</p>}
          {copiedAs && (
            <p className={HINT}>
              已写出「{copiedAs}」到{scope.current.label}这一层，回列表可以找到并编辑
            </p>
          )}

          <div className="flex items-center gap-2">
            {editable && (
              <Button
                size="sm"
                disabled={!draft.dirty || saving || draft.blocked}
                onClick={() => void save()}
              >
                {saving ? "保存中…" : draft.dirty ? "保存" : "已保存"}
              </Button>
            )}
            {!editable && (
              <Button
                variant="outline"
                size="sm"
                disabled={copying}
                title={scope.scopeDir}
                onClick={() => void materialize()}
              >
                {copying
                  ? "写入中…"
                  : def.builtin
                    ? "改成我自己的一份"
                    : `复制到${scope.current.label}这一层`}
              </Button>
            )}
            {!def.builtin && (
              <Button variant="ghost" size="sm" onClick={() => void copyPath()} title={def.path}>
                复制路径
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" size="sm" onClick={onBack}>
              返回列表
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
