"use client";

// 普通代码块 —— 把 streamdown 自己的 CodeBlock 接回来。
//
// 为什么需要这个文件:一旦给 StreamdownTextPrimitive 传了 componentsByLanguage
// (本仓传了 mermaid + otto-*),@assistant-ui/react-streamdown 的 adapter 就会
// **整个**接管 code 元素(见 node_modules/@assistant-ui/react-streamdown/dist/
// adapters/components-adapter.js 的 shouldUseCodeAdapter)。而 adapter 在
// 语言表里查不到、又没有全局 SyntaxHighlighter 时,退回的是
//   <pre><code>{children}</code></pre>
// 一个裸 pre —— 没有 shiki 高亮、没有标题栏、没有复制钮、没有底色。
// 表现就是:```javascript 的代码块渲染成一段等宽白字贴在正文里。
//
// 也就是说,接 mermaid/otto 卡片的代价是**所有其它语言的代码块一起降级**,
// 而这件事在装的时候不会报错、测试也测不出来(它是渲染结果,不是类型)。
// 补法是给 adapter 一个全局兜底:语言表查不到就走这里,而这里渲染的正是
// streamdown 原本要渲染的那个组件(CodeBlock 是它的公开导出),所以观感与
// 没接 componentsByLanguage 时一模一样,不是我们重新画一个像它的东西。

import { useContext } from "react";
import {
  CodeBlock,
  CodeBlockCopyButton,
  StreamdownContext,
  useIsCodeFenceIncomplete,
} from "streamdown";

// 不写 SyntaxHighlighterProps,只写实际用到的两个字段,而且都可选。两个原因:
// ① 这一枚是塞进 components 的全局兜底,而 StreamdownTextComponents 是
//    「索引签名 & { SyntaxHighlighter?: … }」的交集,带**必填**字段的组件过不了
//    那道索引签名;
// ② SyntaxHighlighterProps.node 用的是 @assistant-ui/react-streamdown 自己
//    嵌套的那份 @types/hast,与本仓根上的那份是两个不同的 Element 类型,写上去
//    就是一条与本仓无关的类型冲突。
// 两个字段都由 adapter 实际传入(见 code-adapter.js),默认值只是给类型兜底
export function ShikiCodeBlock({
  code = "",
  language = "",
}: {
  code?: string;
  language?: string;
  // 用不上,写在这里只为与 ExtraProps 有一个同名字段 —— 否则 TS 的
  // weak type detection 会以"两边一个共同属性都没有"为由拒掉这枚组件
  node?: unknown;
}) {
  // 行号跟随 Streamdown 的配置(默认开),与 streamdown 内部 MarkdownCode 同一条读法
  const { lineNumbers } = useContext(StreamdownContext);
  // 还在流的围栏:CodeBlock 自己会用这个标记收住(高亮等写完再上,免得每来一个
  // 字就重跑一遍 shiki)
  const incomplete = useIsCodeFenceIncomplete();

  return (
    <CodeBlock
      code={code}
      language={language}
      isIncomplete={incomplete}
      lineNumbers={lineNumbers !== false}
    >
      {/* 只给复制,不给下载:下载在桌面端是"存去哪儿"的一整套问题,
          而代码块真正每天要用的是把它拷进编辑器 */}
      <CodeBlockCopyButton />
    </CodeBlock>
  );
}
