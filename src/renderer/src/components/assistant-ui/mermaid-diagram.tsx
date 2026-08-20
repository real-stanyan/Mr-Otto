"use client";

// ```mermaid 代码块 → elements/diagram 的画框 + mermaid 渲染出的 SVG。
//
// 为什么自己渲染而不是开 streamdown 的 mermaid 插件:插件会把图直接铺在正文里，
// 而 diagram 元件的价值恰恰是那圈画框 —— 标题、缩放百分比、放大/缩小/复位。
// 一张流程图在对话流里通常比正文宽、比正文高，没有边界和缩放就只能干瞪眼。
// 插件仍然装着（@streamdown/mermaid），mermaid 实例从它拿：初始化参数、版本
// 都归它管，我们不另起一个。
//
// 安全:securityLevel 显式钉 "strict"（mermaid 的默认值，但这种默认不该靠记忆）——
// 图的源码是模型写的，strict 会禁掉 HTML 标签和脚本，只留文本标签。

import { useEffect, useState } from "react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-streamdown";
import { useIsCodeFenceIncomplete } from "streamdown";

import { Diagram } from "@/components/elements/diagram.js";
import { useIsDark } from "@/lib/useIsDark.js";

/** 缩放挡:2 的开方一档,点两下正好翻倍。上下封顶，免得缩成一个点或撑爆卡 */
const STEP = Math.SQRT2;
const MIN = 0.5;
const MAX = 3;

/** 第一行常常就是图的种类（flowchart TD / sequenceDiagram / …），拿它当标题 */
function titleOf(code: string): string {
  const first = code.trim().split("\n")[0]?.trim() ?? "";
  return first === "" ? "diagram" : first;
}

export function MermaidDiagram({ code }: SyntaxHighlighterProps) {
  const dark = useIsDark();
  // 还在流的围栏不渲染:半张图必然解析失败，一路报错刷到写完为止
  const incomplete = useIsCodeFenceIncomplete();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (incomplete) return;
    let alive = true;
    void (async () => {
      try {
        // 动态 import:mermaid 是个大件，只有真出现 ```mermaid 的会话才该付这份钱
        const { mermaid } = await import("@streamdown/mermaid");
        const instance = mermaid.getMermaid({
          theme: dark ? "dark" : "default",
          securityLevel: "strict",
        });
        // id 里带上内容长度和主题:同一屏可能有多张图，mermaid 用 id 建临时节点
        const id = `otto-mermaid-${Math.abs(hash(code))}-${dark ? "d" : "l"}`;
        const out = await instance.render(id, code);
        if (!alive) return;
        setSvg(out.svg);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setSvg(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, dark, incomplete]);

  // 画不出来就把源码原样交回去:一张"渲染失败"的空卡等于把模型写的东西吞了
  if (error !== null || (incomplete && svg === null)) {
    return (
      <pre className="aui-md-pre bg-muted my-3 overflow-x-auto rounded-lg p-3 text-[13px]">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <Diagram
      title={titleOf(code)}
      zoom={zoom}
      onZoomIn={() => setZoom((z) => Math.min(MAX, z * STEP))}
      onZoomOut={() => setZoom((z) => Math.max(MIN, z / STEP))}
      onReset={() => setZoom(1)}
      className="my-3 max-w-none"
    >
      {svg === null ? (
        <span className="text-muted-foreground text-[13px]">画图中…</span>
      ) : (
        // mermaid 自己生成的 SVG，源码经 securityLevel:"strict" 过滤
        <div className="[&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </Diagram>
  );
}

/** 只为拼一个稳定的 DOM id，不是校验和 */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
