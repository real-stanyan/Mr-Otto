# ADR-0348：云会话发图片和视频——协议 24 的 say 只带引用，runtime 下载校验后落附件库，视频只给模型封面

日期：2026-10-04 · issue #1491（#1443 P2 的 runtime 一半）· 维护者拍板：群里的图智能体要看见

## 背景

#1443 P1（ADR-0343）只做了朋友私聊：文件放 Storage，消息里带引用。群聊 / 智能体聊天走云会话协议，`say` 帧里没有附件
这个概念，runtime 里一行附件代码都没有（`attachments` / `readAttachment` / `vision` 零命中）。而桌面本机会话的整条链
——图进 `user_message.attachments` → `deriveMessages` 折成 `image_ref` → `openaiCompatible` 在 `vision` + `readAttachment`
在场时发 `image_url`——早就在，runtime 跑的是同一个 `LoopEngine` 和同一份投影。缺的只是 runtime 这段接线。

## 决定

1. **协议 24：`say` 多一格 `media`**（`ChatMediaRef[]`，1..9 个、要么全图片要么恰好一段视频，与 `planMediaMessages`
   的拆法一致）。引用里是 `sha256 + 格式 + 大小 + 尺寸`，视频另带时长与封面引用；**不带路径**——路径由 runtime 用
   `chatMediaPath(<团队>, <会话>, sha256)` 自己拼。客户端给路径就是给它一个指到别的会话目录的机会，而 RLS 只管
   「读的人读不读得到」。形状不对整帧拒掉（同 `mentions` 那条纪律）。ADR-0343 里写的「协议 23」已被 #1461 用掉。
2. **runtime 下载后复算 sha256、核对大小，再按桌面同一个 `AttachmentStore` 落盘**（`<dataDir>/<团队>-attachments/`，
   每个团队一份）。对象名就是客户端声称的哈希，名不副实（`chat-media` 按内容寻址又允许成员写入，一个成员可以抢先用
   某个哈希当名字放错的字节，#1475 第 7 条）一个字节不进附件库。附件库是 runtime 本机的缓存，id 与 Storage 对象名同一个
   hex，丢了可以从 Storage 重下（重下这次没写）。
3. **视频本体不下载。模型只看封面**（#1443 拍板第 5 条）：封面按图片收进 `attachments`（`name: "视频封面"`），视频
   引用放进事件的另一格 `videos`（`ChatVideoRef`：id / 格式 / 大小 / 尺寸 / 时长 / `poster` 指向封面的附件 id）。投影时
   `deriveMessages` 在正文后面拼一行「[发了一段 N 秒的视频，上面那张图是它的封面]」。与 `attachments` 分两格是拍板
   第 4 条：图生图的 `edit_last` 从 `attachments` 里取「最近一张图」，视频混进去会被当成底图。
4. **`chat_message` 也带 `attachments` / `videos`**。没 @ 谁的那句落的是这条事件，而模型下一轮照样会读到它——群里随手
   发的图若只挂在 `user_message` 上，模型只看得见 @ 了谁的那几张。两个事件的两格形状逐字相同，投影走同一个 `userWithMedia`。
   老日志没有这两格，投影逐字节不变（测试钉住）。
5. **纯发图的正文写占位** `[图片]` / `[视频]`（`mediaPlaceholder`，与朋友私聊同一份）：老客户端、模型、会话列表都读得出
   这里有东西。
6. **看图的开关在型号目录**：`hostedRoute` 只在 daemon 接了 `readAttachment` 时才给适配器 `vision: findModel(model)?.supportsVision`。
   目录认不出的型号 = 没验过 = 不开（与 `reasoningPassback` 同一条纪律）。不支持视觉的型号此刻看到的是 `openaiCompatible`
   的占位文字——代读员搬到 runtime 是 P4（#1491），不在这一条里。
7. **会话房没接媒体时，带图的 say 明说「这台服务器还收不了图片和视频」**，不静默丢图发文字。测试与冒烟的假会话房
   就是这种形状。

## 代价

- **协议进位：所有装着的桌面 / 手机在升级前都连不上云会话**（握手精确相等，ADR-0233）。部署顺序：0052（`chat-media`
  bucket 与 RLS，尚未在生产执行）→ runtime → 手机热更新（P3）→ 桌面发版（P5）。
- 这一条只是 runtime 一半：**手机还发不了**（`sendText` / `say` 的 `media` 参数接上了，上传 / 签名 / 气泡在 P3），桌面
  云会话时间线还画不出图（P5）。
- 附件库只增不删：删会话 / 删团队时清 Storage 与本机附件库是 P6。
- 代读员不在：DeepSeek 一类的智能体看到的是「[图片附件:当前模型不支持直接查看…]」那句占位，直到 P4。
- 真机 / 真 runtime 一次没跑过：本机 Windows，没有 iOS 模拟器也没有 Docker 的 runtime；tsc 四段与单测绿。
