# ADR-0377：聊天里发文件、智能体做 PDF / Word / Excel / PPT——文件是第四种聊天媒体，渲染在 runtime，PDF 字体靠系统

日期：2026-10-06 · issue #1683 · 维护者原话：「增加App可以分享文件功能。以及Agent生成PDF，PPT，Excel等文件功能。」

## 背景

聊天媒体（ADR-0343 / 0348 / 0351）只认图片、视频、语音。人发不了一份合同、一张账单表；智能体能写 Markdown 进工作区，但人看不见
沙箱，「做好了，在 /work/outputs/x.md」对手机上的人等于没做。沙箱镜像里也没有任何文档库。

## 决定

1. **文件是聊天媒体的第四种 `kind: "file"`**，与图片 / 视频 / 语音同一条路：同两个 bucket（0069 只放宽 mime 白名单）、同路径规矩
   （私聊 `<发送方>/<接收方>/<uuid>.<ext>`，云会话 `<团队>/<会话>/<sha256>.<ext>`）、同「先传后发」。白名单只收手机能直接预览、
   anydoc 转得出字的七种：PDF、docx、xlsx、pptx、txt、csv、md；单份 ≤ 20MB；一条消息一份；正文占位「[文件] 名字」——老客户端、
   推送、会话列表读 body 自动说得清发的是哪份。
2. **人发来的文件，runtime 收下时就转好字**：下载、复算哈希（同图片的纪律）、原件存进工作区 `inbox/`、anydoc 转 Markdown 写进
   `ChatFileRef.text`（快照语义同桌面 `UserTextFile`，≤ 60k 字，超了只给开头并点名 `read_document`）。转不出（扫描件、加密）写
   `textError`，不拒这句话。模型投影在正文后拼一段「[发来文件…][文件内容如下]」。群里发的文件随镜像进座位，@ 那一句带的随开场白进。
3. **三把刀**：`create_document`（PDF / docx / xlsx / pptx / csv / md，存 `outputs/`、作为文件发到聊天）、`read_document`、`send_file`。
   工具只交字节（`ToolFile`），传进 chat-media、换成 `tool_result.files` 的是中间件（`toolFiles.ts`，同出图的 `toolImages`）——硬规则
   「工具只依赖 ExecutionWorld」不破：二进制读写加在 `ExecutionWorld.fs.readBytes / writeBytes`（可选），字体与转文字从装配根注入。
   世界没有二进制读写、或没有上传口时整组不挂：不然模型说「发给你了」而人什么都没收到。
4. **渲染在 runtime 进程里（pdfkit / docx / exceljs / pptxgenjs），不在沙箱里**：沙箱断网、镜像里没有库，装 Python 全家桶只为出一份 PDF
   不值；在进程里渲染还能把结果直接交给中间件。正文用「小号 Markdown」（标题、段落、列表、表格、引用、加粗），PDF 与 Word 共用一份解析。
   Excel 的常用公式（SUM / AVERAGE / MIN / MAX / COUNT / ROUND / ABS / IF、四则）我们自己算一遍连结果写进去：手机预览读的是存着的
   结果，不写的话合计那一格是空的；算出来的数回给模型核。
5. **PDF 字体靠系统**：按字挑字体（中日韩分简繁日韩四套字形、泰文、天城文、Unicode 西文）。VPS 装 `fonts-noto-cjk fonts-noto-core
   fonts-dejavu-core`（部署脚本装过就跳过、装不上只提示不中断）。**缺某种文字的字体就不出那份 PDF**，抛错让模型改做 Word——
   Word / Excel / PPT 不嵌字体，看的设备用自己的；印一页豆腐块交给人比说实话糟。
6. **群座位**：座位里交出的文件跟着管理员的回话进群（群的目录再传一份，同出图）；**轮末还有没送出去的图 / 文件就直接送**，
   不再等它下一句（ADR-0376 第 9 条留下的那个坑）。别人使唤的那一轮照旧只有 `ask_owner`，碰不到文件刀。
7. **部署**：pdfkit（运行时读自己目录里的字体度量文件）与 anydoc（原生绑定）打不进单文件包，与 better-sqlite3 / dockerode 一起外置，
   `deploy-stamp.mjs` 的 `STAMP_TARGETS.runtime.external` 是唯一清单。四个文档库进 devDependencies（桌面安装包不背）。
   手机上选文件要 `expo-document-picker`（原生模块）：老原生包热更新过来不画「文件」那格，要新原生包才有。

## 后果

- 顺序：0069 → runtime → 手机热更新 → 新原生包（发文件的按钮）。0069 不跑，手机传文件、runtime 交文件都会被 bucket 拒。
- 文件不进附件库（附件库只收图）；座位桥要的字节留在进程内最近 16 份里，重启丢了只是群里少一份，座位里那份还在（同图）。
- Safari 打开纯文本按 bucket 存的 `text/plain` 显示，中文 .txt 可能乱码（bucket 白名单逐字比对 mime，加不了 charset）——已知，未处理。
