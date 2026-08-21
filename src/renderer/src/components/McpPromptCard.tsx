// MCP prompt 参数表单——composer `/` 菜单选中一个带参数的 prompt 后，
// 挂在输入框正上方等用户填完。位置/进场动效照 QuestionnaireCard：两者是
// 同一类东西——「管线停在这，等一个人」，一致的手感不用重新学。
//
// 壳复用 elements/elicitation-form，但它自带的 `fields` 只读展示（一屏看你
// 填了什么）服务的是"别人已经替你填好"的场景（如问卷答完之后的回执）；
// MCP prompt 的参数要用户**现场输入**，只能用 `children` 换掉身子——
// 同 QuestionnaireCard 换上 Questionnaire 组件的做法，这里换成一组普通输入框。
//
// 零参数的 prompt 不会走到这张卡（store.openMcpPromptForm 直接展开），
// 但"展开失败"（server 在选中之后、提交之前掉线）两条路径都会落到这里：
// 有参数的停在填表这一步失败，零参数的一进来就是 submitting:true 自动提交，
// 失败了同样落在这张卡上——都表现成一条内联错误 + 可以重试/取消，
// 不是白屏或者控制台里一条吞掉的 rejection。

import { PlugIcon, X } from "lucide-react";
import { useChat } from "../store.js";
import { mcpPromptFormKey } from "../lib/mcpPromptMenu.js";
import { ElicitationForm } from "./elements/elicitation-form.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { cn } from "@/lib/utils.js";
import { inkButton, mono } from "../lib/surfaces.js";

export function McpPromptCard() {
  const form = useChat((s) => s.mcpPromptForm);
  const setValue = useChat((s) => s.setMcpPromptFormValue);
  const cancel = useChat((s) => s.cancelMcpPromptForm);
  const submit = useChat((s) => s.submitMcpPromptForm);

  if (!form) return null;

  return (
    <ElicitationForm
      // key 换 = 换了一个 prompt，卡片重新进场（同 QuestionnaireCard 用
      // toolCallId 当 key 的道理）。取消又重开同一个 prompt 时 key 不变
      // （不重新播进场动效），这就是 mcpPromptFormKey 的定位——它只回答
      // "这是哪个 prompt"，不回答"这份异步响应还新不新鲜"（那是
      // store.ts 里 isCurrentMcpPromptSubmission 的事，见它的注释）
      key={mcpPromptFormKey(form)}
      server={`/${form.name} · ${form.server}`}
      state="request"
      icon={<PlugIcon className="size-3.5" />}
      headerEnd={
        <Button
          variant="ghost"
          size="icon"
          aria-label="取消，不展开这个 prompt"
          title="取消"
          className="-mr-1 size-6 shrink-0 text-muted-foreground"
          onClick={cancel}
        >
          <X className="size-3.5" />
        </Button>
      }
      {...(form.description !== undefined ? { message: form.description } : {})}
      actions={
        <>
          <button
            type="button"
            onClick={cancel}
            className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={form.submitting}
            onClick={() => void submit()}
            className={cn(
              inkButton,
              "flex h-8 items-center rounded-full px-3.5 text-xs font-medium disabled:pointer-events-none disabled:opacity-60",
            )}
          >
            {form.submitting ? "展开中…" : form.error ? "重试" : "展开"}
          </button>
        </>
      }
      // 与 QuestionnaireCard 同款外壳尺寸/进场动效——两张卡并排出现时不该
      // 看着像两个来源
      className="mx-5 mb-2 w-auto max-w-none gap-2 rounded-[10px] border-primary/40 bg-primary/[0.05] p-[14px] pt-2 transition-[opacity,transform] duration-[220ms] ease-strong starting:translate-y-2 starting:opacity-0 motion-reduce:transition-opacity motion-reduce:duration-200 motion-reduce:starting:translate-y-0 dark:bg-primary/[0.05]"
    >
      {form.arguments.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {form.arguments.map((arg, i) => (
            <div key={arg.name} className="flex flex-col gap-1">
              <span className={cn(mono, "text-foreground/35")}>
                {arg.name}
                {arg.required && <span className="text-foreground/25"> *</span>}
                {arg.description && (
                  <span className="text-foreground/30 font-sans"> — {arg.description}</span>
                )}
              </span>
              <Input
                value={form.values[arg.name] ?? ""}
                onChange={(e) => setValue(arg.name, e.target.value)}
                disabled={form.submitting}
                placeholder={arg.required ? "必填" : "可选"}
                autoFocus={i === 0}
                className="h-8 rounded-lg text-xs"
              />
            </div>
          ))}
        </div>
      )}
      {form.error && <p className="text-err text-xs leading-relaxed">{form.error}</p>}
    </ElicitationForm>
  );
}
