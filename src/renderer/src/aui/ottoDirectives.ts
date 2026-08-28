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
 * sigil 被转义了吗 —— 看**前一个字符**(issue #441)。
 *
 * 扫全串(#438)带来的代价:「`$apple-design` 是什么」这种**提到**名字的写法
 * 也会被当成指令,skill 白注入一次、名字还被摘走,正文只剩一对空反引号。
 * 两个出口:
 * - **反引号** = 正式的转义写法。想提名字就 `` `$名字` ``,跟 markdown 里
 *   引用代码同一个手势,不用另学一套
 * - **斜杠** = URL 和路径。`https://x.com/$foo`、`./$foo` 不是指令
 *
 * 刻意只看贴身的那一个字符,不解析成对的代码段/围栏:三反引号代码块里
 * `$名字` 顶在行首(前一个字符是换行)的照旧算指令。真解析 markdown 结构是
 * 另一个量级的事,而输入框里贴多行代码块本来就少见 —— 真撞上了再说。
 *
 * parse 和 findSkillDirective 共用这一个 —— 判定只有一份(ADR-0106)。
 */
function escapedAt(text: string, i: number): boolean {
  const prev = i > 0 ? text[i - 1] : "";
  return prev === "`" || prev === "/";
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
 * 从输入框文本里找出 skill 指令（issue #438）。
 *
 * 为什么要有这个函数：`parse` 那头扫**整串**找 `$`，在哪都画 chip；而 submit()
 * 那头原来只认 `text.startsWith("$")`。于是「用$apple-design 干活」在输入框里
 * 亮着像被认出来了，回车却按纯文本发走——skill 没注入，模型收到一个它不认识的
 * token 只能瞎猜。**界面骗人比功能没生效更坏**，所以发的这头对齐画的那头：
 * 同一份名单、同一套「一路吃到底再回头比名单」的最长优先判定，扫全串。
 *
 * 判定与取舍：
 * - 第一个命中的已安装名字算数；一句里写两个，后面那个留在正文里当字面量，
 *   不报错也不注入（真有人这么写再说，现在猜不出他想要哪个）
 * - 正文 = 原文摘掉 `$名字(参数)` 这个 token，**别的字一个不删**。
 *   「用$apple-design 干活」的正文是「用 干活」——读着有点怪，但比自作聪明
 *   砍掉「用」诚实。摘完只把接缝处的连续空白折成一个，不动别处
 * - `$` 在行首时逐字节等价于旧行为（token 在最前面，摘掉再 trim = 旧的 slice）
 *
 * 认不出来返回 null —— 这时 submit() 还有第二道：行首打了 `$` 却没命中，
 * 说明是打错了名字，当场报错，不能悄悄发给模型。
 */
export function findSkillDirective(
  text: string,
  skillNames: readonly string[]
): { name: string; args?: string; task: string } | null {
  const known = new Set(skillNames);
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$" || escapedAt(text, i)) continue;
    const name = readName(text, i);
    if (name === "" || !known.has(name)) continue;

    // 名字后面紧跟 `(...)` 才是参数；括号没闭合就当没写参数，`(` 留在正文里
    let end = i + 1 + name.length;
    let args: string | undefined;
    if (text[end] === "(") {
      const close = text.indexOf(")", end + 1);
      if (close !== -1) {
        args = text.slice(end + 1, close).trim() || undefined;
        end = close + 1;
      }
    }

    const before = text.slice(0, i);
    const after = text.slice(end);
    // 摘掉 token 之后两边各剩一个空白 = 接缝，折成一个；别处的空白不碰
    const seam = /\s$/.test(before) && /^\s/.test(after);
    const task = (seam ? before + after.replace(/^\s+/, "") : before + after).trim();
    return { name, ...(args !== undefined ? { args } : {}), task };
  }
  return null;
}

/**
 * 斜杠指令的那一份(`/` 打头,type = "command")。名单传**不带斜杠**的名字
 * (`compact`、`rename`、MCP prompt 的 name)。选中只把 `/名字 ` 填进输入框,
 * 真正执行等回车 —— submit() 那头按首个空白前的名字分发(commands.ts)。
 */
export function ottoSlashFormatter(commandNames: readonly string[]): Unstable_DirectiveFormatter {
  return makeFormatter("/", "command", commandNames);
}

/**
 * `#路径` 的那一份(type = "path")。
 *
 * 触发字符是 `#` 不是 `@`（issue #611）：`@` 让给了「@好友 分享会话」，
 * 路径 mention 一刀切迁到 `#`（本期 shift 决策，不留兼容期）。
 *
 * 和 `$skill` / `/命令` 不是同一种判定:那两种有名单可比对,认不出就当普通字符;
 * 路径**没有名单**——工作区里任何一条路径都可能是真的,而且用户手打一半的路径
 * 也该跟着亮。所以这里靠**形状**:
 *   ① `#` 前面必须是行首或空白 —— 挡住 foo#bar、URL 锚点这类误命中
 *   ② 后面至少一个非空白字符 —— 光一个 `#` 不闪
 *   ③ 吃到下一个空白为止,末尾的中英文标点不算路径的一部分(`#a.md。`)
 *
 * 代价是会认错:`#话题` 这种非路径写法也会被画成 chip。接受——它进不了模型
 * 上下文,只是输入框里的一层高亮,而漏亮真路径比错亮一个词更烦人。
 */
export function ottoPathFormatter(): Unstable_DirectiveFormatter {
  return {
    serialize: (item: Unstable_TriggerItem) => `#${item.id} `,

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
        const atBoundary = i === 0 || /\s/.test(text[i - 1]!);
        if (text[i] !== "#" || !atBoundary) {
          plain += text[i];
          i++;
          continue;
        }
        let j = i + 1;
        while (j < text.length && !/\s/.test(text[j]!)) j++;
        // 句末标点不属于路径:`看 #a.md。` 的路径是 a.md
        while (j > i + 1 && TRAILING_PUNCT.test(text[j - 1]!)) j--;
        const path = text.slice(i + 1, j);
        if (path === "") {
          plain += text[i];
          i++;
          continue;
        }
        flush();
        out.push({ kind: "mention", type: "path", label: `#${path}`, id: path });
        i = j;
      }

      flush();
      return out.length === 0 ? [{ kind: "text", text }] : out;
    },
  };
}

/** 跟在路径后面的这些字符是句子的一部分,不是路径的一部分 */
const TRAILING_PUNCT = /[.,;:!?)\]}，。；：、！？）】」]/;

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
        // 转义(反引号/斜杠打头)的那一份跟 find 共用判定 —— 画的和发的必须
        // 一起认、一起不认,否则 ADR-0106 立的规矩当场就破
        if (text[i] !== sigil || escapedAt(text, i)) {
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

// ─── @好友：把本次会话分享给好友（issue #611，PR#3）──────────────────────
// 与 $skill/@路径 不同：@好友 的 chip 不是给模型的语法，是**发送侧的一个动作信号**——
// 句子里带 @好友名 时，submit() 先把当前会话快照分享给这位好友
// (bridge.shareSessionToFriend)，正文照常作为留言发出去。
//
// chip 的 id 存 **uid**（不是显示名）：显示名可能含空格/中文/重名，uid 才是
// 发送要的那个精确地址。serialize 时 label 用显示名（人读），id 用 uid（机读）。

/** @好友 chip 的数据载体：显示名给人看，uid 给发送用 */
export interface FriendMention {
  uid: string;
  name: string;
}

/**
 * @好友 的那一份（type = "friend"，名单是 (uid, name) 对）。
 *
 * serialize 写成 `@显示名 `（人读的形态），但 mention 的 id 塞 uid——
 * composer 高亮靠 label，发送检测靠 id 对回 uid（见 findFriendMention）。
 * 显示名里的空格/中文不在 NAME_CHARS 里，所以 parse 不能靠"一路吃名字字符"，
 * 而是**拿好友名单做最长前缀匹配**：从 `@` 往后逐位试，命中名单里最长的名字。
 */
export function ottoFriendFormatter(friends: readonly FriendMention[]): Unstable_DirectiveFormatter {
  // 名字 → uid。重名时后到覆盖先到（同一 uid 不会重，重名是两个 uid 同名——
  // 发送侧 findFriendMention 同样这张表，画的和发的认的是同一个人，ADR-0106）
  const byName = new Map(friends.map((f) => [f.name, f.uid]));
  // 按名字长度降序：最长优先，「@小明」和「@小明同学」都在名单时命中长的
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);

  return {
    // 选中项的 id 是 uid（adapter 里 item.id = uid），但写进 composer 的是显示名——
    // serialize 收到的是 item，里面有 label；从 label 剥掉 @ 前缀就是显示名
    serialize: (item: Unstable_TriggerItem) => `@${item.label.replace(/^@/, "")} `,

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
        const atBoundary = i === 0 || /\s/.test(text[i - 1]!);
        if (text[i] !== "@" || !atBoundary || escapedAt(text, i)) {
          plain += text[i];
          i++;
          continue;
        }
        // 从 @ 之后的位置试名单里每个名字（已按长度降序），命中即停
        const rest = text.slice(i + 1);
        const hit = names.find((n) => rest.startsWith(n));
        if (!hit) {
          plain += text[i];
          i++;
          continue;
        }
        flush();
        out.push({
          kind: "mention",
          type: "friend",
          label: `@${hit}`,
          id: byName.get(hit)!,
        });
        i += 1 + hit.length;
      }

      flush();
      return out.length === 0 ? [{ kind: "text", text }] : out;
    },
  };
}

/**
 * 从输入框文本里找出 @好友 mention（发送检测，issue #611）。
 *
 * 与 findSkillDirective 同一份职责墙：画的（parse）和发的（这里）共用一份名单、
 * 同一套最长优先判定——界面上亮着的 chip，回车必须认成同一个好友，不许界面骗人。
 *
 * 命中返回 { uid, name, task }：task = 摘掉 `@显示名` 后的正文（用户的留言，
 * 随会话包一起发给好友，交代这个 fork 是去干什么的）。没命中返回 null。
 */
export function findFriendMention(
  text: string,
  friends: readonly FriendMention[]
): { uid: string; name: string; task: string } | null {
  const byName = new Map(friends.map((f) => [f.name, f.uid]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);

  for (let i = 0; i < text.length; i++) {
    const atBoundary = i === 0 || /\s/.test(text[i - 1]!);
    if (text[i] !== "@" || !atBoundary || escapedAt(text, i)) continue;
    const rest = text.slice(i + 1);
    const hit = names.find((n) => rest.startsWith(n));
    if (!hit) continue;

    const end = i + 1 + hit.length;
    const before = text.slice(0, i);
    const after = text.slice(end);
    // 摘掉 `@名字` token，接缝处连续空白折一个（同 findSkillDirective 的规矩）
    const seam = /\s$/.test(before) && /^\s/.test(after);
    const task = (seam ? before + after.replace(/^\s+/, "") : before + after).trim();
    return { uid: byName.get(hit)!, name: hit, task };
  }
  return null;
}
