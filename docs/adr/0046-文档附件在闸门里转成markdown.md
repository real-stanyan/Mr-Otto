# ADR-0046：文档附件在闸门里转成 Markdown，走文本那条路

- 状态：已接受
- 日期：2026-08-21
- 相关：ADR-0009（附件库与日志的取舍）、ADR-0030（三条入口共用同一道闸门）、ADR-0040（附件归 store 所有）
- 授权：维护者 stanyan 在 2026-08-21 会话中提出「用 anydoc 处理用户上传的附件转为 llm 更方便阅读的 md 格式」，并在确认取舍后要求「开 issue + ADR，然后动手」
- Issue：#133

## 背景

`intakeFile` 分类闸门原本三条出口：图片嗅探入库返 ref、UTF-8 文本内联带走、其余
`rejected`。docx / pdf / xlsx / pptx 全部撞在 `\0` 二进制嗅探那行上被拒收，理由写着
「图片之外的二进制本期不支持」。

用户把简历、报表、幻灯片拖进来，现在什么都拿不到。这不是"处理得不好"，是没有这条路。

## 决定

### 1. 第四条出口接在同一道闸门里，插在二进制嗅探之前

新分支进 `intakeFile`，不新开入口——ADR-0030 定死了三条入口共用一道闸门，
绕开它就是散成两套策略。

顺序有硬约束：文档嗅探必须在 `\0` 二进制判断**之前**。docx 是 zip、pdf 头是 `%PDF`，
两者都含 `\0`，放在后面等于永远走不到。

格式识别**只用** anydoc 的 `formatFromBytes`（按容器签名认），**不做扩展名回退**。
和现有的图片嗅探同一个口径：字节是事实，扩展名不是。

不回退是有意的，不是省事。anydoc 唯一没有容器签名的格式是 CSV，而 CSV 走扩展名
回退会制造一个真回归：一份 90KB 的 .csv 现在能当文本收下，转成 GFM 表格后
（`| a | b |` 的分隔符开销）可能撑过 100KB 上限，**本来能用的文件变成不能用**。
而 CSV 本身模型读得很好，转换收益接近零 —— 负收益换零收益，不做。

RTF 正好是反面例子：它有签名（`{\rtf`），原文是一堆控制字，模型读不了，
转换是纯赚。同一条规则把这两种情况分对了，不需要格式白名单。

### 2. 出口复用 `kind: "text"`，转出的 md 不入库

转出来的 Markdown 走文本那条路：内联进消息，天然满足"model-visible means logged"。
不碰 SessionEvent schema，不碰 AttachmentStore，不需要新事件。

原始 docx/pdf **不留档**。留档意味着 AttachmentStore 要放开非图片类型，那是 ADR-0009
的边界变更，成本远高于收益：模型看的是 md，原始字节留着没人读。

100KB 上限也复用文本路的那条——转出来的 md 超限就拒，和 100KB 的 .txt 同口径。
上限判的是 **md 的长度，不是原文件的**：一个 3MB 的 pptx 可能只转出 8KB 文字，
按原文件大小拒它没有道理。

### 3. 转换器选 anydoc，版本锁死

选它的理由按重要性排：

- **纯 Rust，无 ML 模型、无云调用、无 API key**。本地 agent 工具，这条是硬需求——
  任何"把用户文档 POST 到某个 API"的方案直接出局。
- **napi-rs 预编译二进制**（含 `darwin-arm64`）。Rust 在发布时就编译好了，
  本机不需要 cargo/rustc/node-gyp，TS 侧就是普通 import。
- **N-API ABI 跨 Electron 版本稳定** → 不用进 `rebuild-native` 那串 electron-rebuild
  （better-sqlite3 / node-pty 是老式 addon 才需要）。
- `electron-builder.yml` 现有的 `asarUnpack: "**/*.node"` 直接覆盖它的二进制，打包零改动。
- 一个依赖吃掉 12 种格式，比 mammoth + xlsx + pdf-parse 拼一堆干净。
- MIT。

版本锁 `0.2.3`，不用 `^`：包 2026-08-20 才发布，0.2.x 的 API 一定会动。

### 4. 失败一律降级成 `rejected`，不抛

anydoc 的错误带 `code: ConvertErrorCode`（`unsupported` / `malformed` / `encrypted` /
`resourceLimit` / `missingPart` / `io`），逐条映射成人话理由。

一个坏文件不该炸掉整次多选——这是闸门里已有的原则（图片入库失败也是转
`rejected`），文档分支照办。转换成功但内容为空的，同样按 `rejected` 处理：
给模型一个空文件比告诉用户"没转出东西"更糟。

### 5. `intakeFile` 转 async

anydoc 的 API 全是 Promise，闸门跟着变异步。两个调用点（`src/main/index.ts` 的
pickAttachments / intakePastedFiles）本来就在 `ipcMain.handle` 里，吃 Promise 没有障碍。

这是这次唯一的结构性改动，代价明确、范围有限。

## 代价

**PDF 是这套里最弱的一环**。走 pdf-inspector 纯文本抽取，结构会丢——实测转一份简历，
标题层级没了，还混进一段 PDF 内部的标识符。扫描件/图片型 PDF 直接 `unsupported`。

OCR 只存在于 Firecrawl 的付费 hosted API，**不接**（违反第 3 条的第一个理由）。

docx/xlsx/pptx 走的是真正的解析器（完整 Document 模型、表格 grid、脚注、样式），
质量是另一个档次。所以现实预期：docx/xlsx/pptx/csv/epub 收益大，
PDF 是「有总比拒收强」，不是「转得好」。

接受这个不均衡：拒收的信息量是零，抽得不完美的 PDF 仍然远大于零。

## 补记（2026-08-21，本 ADR 合并之后）

上面第 2 条只说了"复用文本路的 100KB 上限"，没说 `bytes` 这个字段该是谁的大小。
落地时它取了转出的 md 长度，于是一个 1.3KB 的 docx 在界面上显示成 105 B —— 
用户丢进来的东西和看到的数字对不上（#137）。

`UserTextFile.bytes` 的注释一直写着「原始大小(展示用)」。本 ADR 在没有察觉的
情况下改掉了它的含义，注释因此开始说谎。

**修正：三个量含义分开，各归各的。**

| 量 | 是什么 | 谁用 |
|---|---|---|
| `bytes` | 用户丢进来那个文件的大小 | 只给界面看（`StagedChips` / `UserAttachments`） |
| `content` | 转出的 Markdown | 喂给模型 |
| markdownBytes | `content` 的长度 | 只做准入判据（100KB 上限） |

上限继续判 markdownBytes —— 3MB 的 pptx 可能只转出 8KB 文字，按原文件大小拒它
没道理，第 2 条那个理由依然成立。

**为什么展示口径要用原文件大小**：转成 Markdown 是喂给模型之前的内部优化，
不是用户请求的操作。用户拖进去一个 Word 文档，界面上就该是那个 Word 文档；
让一个奇怪的小数字把内部管线漏出去，用户既看不懂也帮不上忙。

代价是「转出的 md 有多大」在界面上完全不可见。接受：那是实现细节，
真要排查时日志里的 `content` 全文都在。

这条修正**不需要改 SessionEvent schema** —— `bytes` 本来就是纯展示字段
（全仓只有那两个组件读它），把它改回注释说的含义，反而是让记录重新变准。

## 什么情况下该推翻

- **anydoc 的 0.2.x 出现破坏性 API 变更或长期失修**：换掉转换器，闸门那一层的形状
  （第四条出口、复用文本路、失败降级）不受影响——这个设计对转换器是可替换的。
- **用户开始大量传扫描件**：第 4 条会把它们全拒了，那时需要本地 OCR
  （tesseract 一类），而不是接 Firecrawl 的云端。
- **转出的 md 需要保留原文件供回看**：第 2 条"不入库"的前提就没了，
  得让 AttachmentStore 放开非图片类型（ADR-0009 的边界）。
- **需要抽取文档里的图片**：现在 `Document.assets` 拿得到但被丢弃了；
  真要做，图片得进 store，md 里引 ref，那是一个明显更大的设计。
