// 「在当前作用域里落一份新定义」这件事的唯一实现。
//
// 三条路都要它：新建整页、只读定义的「复制到本层」、内置定义的 materialize。
// 三处各写一遍的话，那条中途切作用域的判断迟早在某一处漏掉——漏掉的后果不是
// 报个错，是把内容写穿到另一个工程的同名定义上。
//
// 为什么是两步（create 再 save）而不是一次写完：主进程的 createSubagent 才是
// 唯一知道文件落在哪条根、名字有没有被占的一侧，渲染层猜的路径它一概不采信
// （saveSubagent 的 IPC handler 会按 name 重查一遍磁盘并覆盖请求体里的路径）。

import { useChat } from "../store.js";
import { bridgeErrorMessage } from "./bridgeError.js";
import type { SubagentDef } from "../../../shared/subagent.js";

/** 要写进文件的那些字段。身份字段（name/path/source/scope/readOnly）不在里头：
    name 由调用方给，其余来自主进程刚建出来那份的磁盘现状 */
export type SubagentFileFields = Omit<
  SubagentDef,
  "name" | "path" | "source" | "scope" | "readOnly" | "builtin"
>;

/** 落一份定义。成功回 null，失败回一句给用户看的话（不抛：三处调用方都要把它
    显示在自己那块地方，抛出去只会变成一条谁也接不住的 unhandled rejection） */
export async function createSubagentFile(opts: {
  name: string;
  fields: SubagentFileFields;
  /** 当前作用域的短名和目录，只用来把错误说清楚 */
  scopeLabel: string;
  scopeDir: string;
}): Promise<string | null> {
  const { createSubagent, saveSubagent } = useChat.getState();
  // 作用域是所有落点的前提，整个流程钉在开始那一刻的那一层上
  const scopeAtStart = useChat.getState().subagentScope;
  try {
    // 认准 createSubagent **回传**的那份清单，不去 store 里翻：store 那份会被
    // 作用域代次门挡掉（用户中途切一下作用域就查不到了），而文件其实已经建出来了
    const created = (await createSubagent(opts.name)).find((d) => d.name === opts.name);
    if (!created) {
      return `「${opts.name}」已经建在 ${opts.scopeDir} 了，但清单里没有它——去那个目录里手工把内容填上`;
    }
    if (useChat.getState().subagentScope !== scopeAtStart) {
      // 切了作用域就不能接着存：saveSubagent 用的是 store 里此刻那一层，拿这个
      // 名字去新那层查——查不到是白跑一趟，查到个同名的就是把内容写穿到另一个
      // 工程的定义上。空壳文件留在原来那层，切回去展开它接着编
      return `「${opts.name}」已经建好了，但你切了作用域，内容没写进去——切回${opts.scopeLabel}在列表里展开它继续`;
    }
    await saveSubagent({
      name: opts.name,
      ...opts.fields,
      scope: created.scope,
      path: created.path,
      source: created.source,
      readOnly: created.readOnly,
    });
    return null;
  } catch (e) {
    return bridgeErrorMessage(e);
  }
}

/** 一份定义里"要写进文件"的那些字段。内置 materialize / 只读定义复制都用它
    把源那份原样搬过去 */
export function fileFieldsOf(def: SubagentDef, override?: { model?: string }): SubagentFileFields {
  return {
    description: def.description,
    instructions: def.instructions,
    tools: def.tools,
    unknownTools: def.unknownTools,
    approval: def.approval,
    preamble: def.preamble,
    context: def.context,
    ...(override?.model ?? def.model ? { model: override?.model ?? def.model! } : {}),
    ...(def.thinking ? { thinking: def.thinking } : {}),
  };
}
