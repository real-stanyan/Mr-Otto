// 正文里的「文件:行号」→ 可点的节点。跑在 streamdown 的 rehype 管线最后一节。
//
// 为什么是 rehype 而不是在组件里正则替换字符串:markdown 的一段正文到组件手上
// 已经是若干个 React 子节点(粗体、行内代码各是一个),在那一层做替换就得自己
// 重走一遍"哪些子节点是纯文本"。hast 这一层文本节点是文本节点,切开就行。
//
// 为什么挂在默认插件**之后**:streamdown 的默认 rehype 是 [raw, sanitize, harden],
// sanitize 会按白名单削属性。我们造的 data-file-ref 属性要活下来,只能排在它后面
// (传 rehypePlugins 会整个替掉默认值,所以调用方必须 [...defaultRehypePlugins, 这个]
//  —— 少写前面那半就是把消毒也一起关了)。

import type { Element, ElementContent, Root, RootContent } from "hast";
import { scanFileRefs } from "../../../shared/fileRefs.js";

/** 这些标签底下不认路径:
    - pre:代码块。整块代码里随便一行都长得像路径,标出来是满屏噪音
    - a:已经是链接了,再套一层就是两个可点的东西叠着
    - 已经处理过的 span:防止插件被跑两次时套娃 */
const SKIP = new Set(["pre", "a"]);

/** 一个文本节点 → 若干节点(命中的那几段换成带标记的 span)。
    没命中就返回 null,让调用方原样留着原节点(少造一个数组) */
export function splitTextRefs(value: string): ElementContent[] | null {
  const hits = scanFileRefs(value);
  if (hits.length === 0) return null;
  const out: ElementContent[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor) out.push({ type: "text", value: value.slice(cursor, hit.start) });
    out.push({
      type: "element",
      tagName: "span",
      properties: {
        dataFileRef: hit.path,
        // 没行号就不写这个属性(而不是写 "null"):组件那边判断的是"有没有"
        ...(hit.line === null ? {} : { dataFileLine: String(hit.line) }),
      },
      children: [{ type: "text", value: value.slice(hit.start, hit.end) }],
    });
    cursor = hit.end;
  }
  if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
  return out;
}

function walk(node: Root | Element): void {
  const next: RootContent[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type === "text") {
      const split = splitTextRefs(child.value);
      if (split === null) next.push(child);
      else {
        next.push(...split);
        changed = true;
      }
      continue;
    }
    if (child.type === "element") {
      if (!SKIP.has(child.tagName) && child.properties?.["dataFileRef"] === undefined) {
        walk(child);
      }
    }
    next.push(child);
  }
  if (changed) node.children = next as Element["children"];
}

export function rehypeFileRefs() {
  return (tree: Root): void => walk(tree);
}
