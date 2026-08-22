// Mr Otto 自己的 directive 语法。
//
// assistant-ui 的 directive 机制有两头:composer 那头把选中的项**写成文本**
// (serialize),消息那头把文本**认回来**渲染成 chip(parse)。上游自带的
// unstable_defaultDirectiveFormatter 用的是一套带 id 的转义写法,本仓用不了 ——
// 本仓的 `$skill名` 是**要发给 harness 的真语法**(App.tsx 的 submit() 靠它分出
// "名字给 harness、正文给模型"),换成别的写法等于改协议。
//
// 所以这里自己实现一份:serialize 就是 `$名字 `,parse 认回 `$名字`。
//
// parse 需要一份"哪些名字算数"的名单 —— 没有它,`$100` 和 `$ARGV` 都会被画成 chip。
// 名单来自 store 的 skills(已安装的 skill),所以 formatter 是**按名单造**的,
// 不是模块级单例。
//
// 纯函数,不碰 React:边界(转义、相邻、名字是另一个名字的前缀)靠单测逼。

import type {
  Unstable_DirectiveFormatter,
  Unstable_DirectiveSegment,
  Unstable_TriggerItem,
} from "@assistant-ui/react";

/** skill 名允许的字符。跟 `$` 后面能一路吃到哪为止是同一件事:
    限制在字母/数字/连字符/下划线 —— 中文标点、空格、句号都不该被吃进名字里 */
const NAME_CHARS = /[A-Za-z0-9_-]/;

/** 从 i(指向 `$`)开始,尽量长地吃一个名字。返回吃到的那段(可能是空串) */
function readName(text: string, i: number): string {
  let j = i + 1;
  while (j < text.length && NAME_CHARS.test(text[j]!)) j++;
  return text.slice(i + 1, j);
}

/**
 * 造一个只认这批名字的 formatter(skill 用,`$` 打头)。
 *
 * 匹配用"最长优先":名单里同时有 `review` 和 `review-pr` 时,
 * `$review-pr` 必须整条命中长的那个 —— 从 `$` 往后一路吃字符再回头比名单,
 * 天然就是最长优先(吃到的那段本身就是最长的候选)。
 */
export function ottoDirectiveFormatter(skillNames: readonly string[]): Unstable_DirectiveFormatter {
  return makeFormatter("$", "skill", skillNames);
}

/**
 * 斜杠指令的那一份(`/` 打头,type = "command")。名单传**不带斜杠**的名字
 * (`compact`、`rename`、MCP prompt 的 name)。选中只把 `/名字 ` 填进输入框,
 * 真正执行等回车 —— submit() 那头按首个空白前的名字分发(commands.ts)。
 */
export function ottoSlashFormatter(commandNames: readonly string[]): Unstable_DirectiveFormatter {
  return makeFormatter("/", "command", commandNames);
}

function makeFormatter(
  sigil: string,
  type: string,
  names: readonly string[]
): Unstable_DirectiveFormatter {
  const known = new Set(names);
  return {
    // 末尾那个空格是刻意的:插进 composer 之后光标直接落在名字后面,
    // 用户接着打任务正文,不用自己补空格(旧的 pickSkill 就是这个手感)
    serialize: (item: Unstable_TriggerItem) => `${sigil}${item.id} `,

    parse(text: string): readonly Unstable_DirectiveSegment[] {
      const out: Unstable_DirectiveSegment[] = [];
      let plain = "";
      let i = 0;
      const flush = (): void => {
        if (plain !== "") {
          out.push({ kind: "text", text: plain });
          plain = "";
        }
      };

      while (i < text.length) {
        if (text[i] !== sigil) {
          plain += text[i];
          i++;
          continue;
        }
        const name = readName(text, i);
        if (name === "" || !known.has(name)) {
          // 不在名单里:`$`/`/` 只是个普通字符(价格、shell 变量、路径)
          plain += text[i];
          i++;
          continue;
        }
        flush();
        out.push({ kind: "mention", type, label: `${sigil}${name}`, id: name });
        i += 1 + name.length;
      }

      flush();
      // 一个 segment 且是 text 时,DirectiveText 会走"原样输出"的快路径 ——
      // 空文本也要给它一个 segment,否则 segments.length === 1 那个判断会落空
      return out.length === 0 ? [{ kind: "text", text }] : out;
    },
  };
}
