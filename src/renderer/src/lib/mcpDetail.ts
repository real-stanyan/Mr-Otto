// 连接器详情页的判断题 —— 组件只管渲染（同 mcpDirectory.ts 的分工）。
//
// 卡片是索引，详情页是答案。一张卡上装得下的只有"这台叫什么"；装之前
// 用户真正要知道的三件事（代码跑在谁的机器上、地址是什么、要我填什么），
// 和装之后要知道的一件事（它到底给了哪些工具），都在这儿。

import type { CatalogEntry } from "../../../shared/mcpCatalog.js";
import type { McpDisplayStatus } from "./mcpForm.js";

export interface DetailFact {
  label: string;
  value: string;
  /** 地址 / 命令这类要等宽字体照原样看的 */
  mono?: boolean;
}

/** 「代码跑在谁的机器上」是这一页最重要的一句话，所以它是第一条事实，
    而且写的是后果不是名词：用户要判断的是风险，不是 transport 枚举值。
    这个区分本来只出现在未核验 stdio 的那道确认卡上（needsInstallConfirm），
    但那道卡只在长尾层弹——精选层的 stdio 同样会在你电脑上跑代码，
    只是我们核过。用户有权在装之前就看见这件事 */
export function transportFact(entry: CatalogEntry): DetailFact {
  return entry.transport === "http"
    ? { label: "连接方式", value: "远程服务 —— 代码跑在对方的机器上，你这边只发请求" }
    : { label: "连接方式", value: "本机进程 —— 会下载并在你的电脑上运行" };
}

/** 地址（http）或启动命令（stdio）。命令是 command + args 拼回一行，
    跟确认卡上给用户看的那一行是同一个拼法 */
export function endpointFact(entry: CatalogEntry): DetailFact {
  return entry.transport === "http"
    ? { label: "地址", value: entry.url ?? "", mono: true }
    : {
        label: "启动命令",
        value: [entry.command ?? "", ...(entry.args ?? [])].join(" ").trim(),
        mono: true,
      };
}

/** 这一页的事实清单。空值的条目不出——一行"分类：（空）"比没有这行更糟 */
export function connectorFacts(entry: CatalogEntry): DetailFact[] {
  const facts: DetailFact[] = [transportFact(entry), endpointFact(entry)];
  if (entry.category !== undefined) facts.push({ label: "分类", value: entry.category });
  if (entry.authNote.trim() !== "") facts.push({ label: "授权", value: entry.authNote });
  return facts.filter((f) => f.value.trim() !== "");
}

/** 来路那一句。verified 是**来路**的性质而不是条目自身的属性
    （见 mcpDirectory.ts 顶部），所以这句话说的是"从哪儿来的"，
    不是"这台好不好"——注册表里也有官方的好 server，只是没人替你核过 */
export function sourceNote(verified: boolean): string {
  return verified
    ? "仓内精选层：地址和参数都由人工核过，进过 PR review。"
    : "来自公开注册表：投稿开放，没有人替你核过。装之前先看清上面的地址和命令。";
}

/** 参数说明里的那个后缀。必填/选填要出现在标签上而不是只在别处解释——
    用户是照着这一行决定要不要现在去开控制台拿 key 的 */
export function paramSuffix(required: boolean): string {
  return required ? "必填" : "选填";
}

/** 已装的那台，「它提供的工具」这一段的标题。
    **必须看状态**：只看 `tools.length` 的那一版会在 needs-auth 上说"这台没有
    暴露任何工具"——把"还没连上"讲成"这台是空的"，跟 #722 那个撒谎的勾同一类
    错（issue #747）。没连上的时候工具清单当然是空的，那不是关于这台 server
    的事实，是关于连接的事实。

    零个也要说：一台**连上了**却没有工具的 server，用户看到"没有暴露任何工具"
    才知道该去查它，看到一片空白只会以为是这一页还没加载完。

    没装（tools === undefined）返回 null = 这一段不出现 */
export function toolsNote(
  status: McpDisplayStatus | null,
  tools: readonly string[] | undefined
): string | null {
  if (tools === undefined || status === null) return null;
  switch (status) {
    case "connected":
      return tools.length === 0 ? "这台没有暴露任何工具" : `${tools.length} 个工具`;
    case "needs-auth":
      return "还没授权，授权之后才知道它提供什么";
    case "connecting":
      return "正在连，连上才知道它提供什么";
    case "failed":
      return "连不上，看不到它提供什么";
    case "disabled":
      return "已经关掉了，打开才能看到它提供什么";
  }
}
