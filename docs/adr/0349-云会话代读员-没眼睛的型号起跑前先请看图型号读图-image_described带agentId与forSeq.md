# ADR-0349：云会话的代读员——没眼睛的型号起跑前先请看图型号读图，`image_described` 带 `agentId` 与 `forSeq`

日期：2026-10-04 · issue #1491（#1443 P4）· 承 ADR-0348

## 背景

ADR-0348 让云会话里的图进了 `user_message` / `chat_message` 的 `attachments`，支持视觉的型号直接看。不支持的
（DeepSeek、GLM 文本款、Kimi 等）在 `openaiCompatible` 里拿到的是一句占位「[图片附件:当前模型不支持直接查看…]」——
维护者拍板「群里的图智能体要看见」，这一半才算做完。桌面本机会话早有代读员（`src/main/visionBridge.ts`，
ADR-0009 追记）：发送路径先请视觉款把图读成文字，落 `image_described` 紧贴在 `user_message` 之前。

## 决定

1. **代读在 runtime 的 `runJob` 里、`engineFor` 之前做**，不在 say() 里。say() 那一刻不知道哪只会接、各自用什么型号；
   群里一条带图的发言可能同时给能看和不能看的智能体。判「看不看得了」用 `adapterFor(spec)` 现算的路由
   （`prepare()` 之后的 `model`）查目录的 `supportsVision`——与 hostedRoute 决定真正发请求的那个型号同一个来源。
2. **`image_described` 加两格：`agentId`（替哪一只读的）、`forSeq`（读的是哪一条）**。开场白在 say() 那一刻就落盘了，
   代读没法像桌面那样「紧贴在前」，于是改成「跟在后面、指回去」。两格都缺席 = 桌面的老形状，旧日志照常重放
   （schema 向后兼容硬规则）。`agentId` 在场让 `agentView` 现成的那条「别人的事件按表裁决」把别只的那份挡在外面——
   不然群里三只都不能看图，每只会读到三份解析。
3. **投影把带 `forSeq` 的那份折进它服务的那条发言**（`deriveMessages` 的 `userWithMedia`）：正文 + 一行说明 + 解析，
   **替掉** `image_ref`——这只看不了图，占位文字和解析放一起只是噪音。事件位置上不再单独注入。`barrenTurns` 跳掉
   作废的开场白时连着它后面那条代读一起跳。
4. **要读哪几条**是纯判据 `pendingImageDescriptions`：上一次收口之后的尾段里带图、且这只还没被替读过的
   （`forSeq` 集合里没有）。`chat_message`（没 @ 谁的随手一发）也在内——下一轮它照样会读到那条。
5. **代读员型号 = 网关此刻供的清单里最便宜那款带眼睛的**（`visionModelFor(DEFAULT_VISION_MODEL, me.models, true)`，
   #1051 给订阅用户定的同一条规矩），调用走 `createHostedRuntimeAdapter`（同一套 on-behalf / workspace / session 头，
   `withUsage` 记账）。提示词与桌面逐字同一段。
6. **代读失败不拦 turn**（与桌面不同）。桌面是一人一机，失败了人自己换型号重发；群里一只 agent 的代读员抖一下
   不该把整条接力链卡死。退回占位文字（它明说看不了，不是装看过），并落一句系统旁白说清是看图模型没读出来。
   网关一款带眼睛的都没供：同样一句旁白，不代读。

## 代价

- 每只没眼睛的 agent、每条带图的发言各一次视觉调用，账记在所有者名下；三只都不能看图 = 三次。
- 代读在 `engineFor` 之前串行跑，一轮多等一次网络往返（免费视觉档高峰期可能更久）；桌面那份的五段退避这里没搬——
  失败不拦 turn，重试的收益小于让人多等的代价。
- 旁白落的是 `chat_message{fromUid:"system"}`，群里每个人都看得见「看图模型没读出来」——这是实话，不藏。
- 真 runtime 一次没跑过（本机 Windows）；判据与接线有单测。
