# ADR-0040：附件的所有权留在 store，不交给 assistant-ui

日期：2026-08-20
状态：已采纳

## 背景

assistant-ui 的 attachment 组件（registry 的 `attachment.tsx`：`ComposerAttachments`
/ `ComposerAddAttachment` / `UserMessageAttachments`）**全部**读它自己的 attachment
作用域。要用它们，就必须提供一个 `AttachmentAdapter`：

```ts
type AttachmentAdapter = {
  accept: string;
  add(state: { file: File }): Promise<PendingAttachment>;
  remove(attachment: Attachment): Promise<void>;
  send(attachment: PendingAttachment): Promise<CompleteAttachment>;
};
```

接了它，composer 的附件列表就归 assistant-ui 持有。

## 决定

**不接。** 附件的所有权留在 store（`staged`），`StagedChips` / `AttachDropZone` /
`pickFiles` / `attachPasted` 这条链一行不动。

13 项迁移里，这是唯一一项**没有**换底层的。原因不是工作量，是它会打断一条既有的
交接，或者养出第二个所有者。

## 为什么

三条，任何一条单独都够：

1. **暂存区是两个 composer 共用的，而其中一个够不着 runtime 作用域。**
   新会话卡（`Welcome`）在会话还不存在时就允许粘图/拖图，建会话后由 `send` 原样
   带走（见 `App.tsx` 的 `launch()`）。它渲染在 `OttoRuntimeProvider` 外面——那会儿
   没有会话，也就没有 thread/composer 作用域。把聊天区的附件交给 assistant-ui，
   要么这条交接断掉，要么同一批附件同时活在两个所有者手上。

2. **图片本体不在渲染层。** 图片走主进程的附件库、日志里只留内容寻址的 `ref`
   （ADR-0009）；`AttachmentAdapter` 是纯渲染层的 `File` 接口。桥得起来（`add` 里
   走 `intakePastedFiles` 换 ref），但换来的是一个「assistant-ui 以为自己持有附件、
   实际只持有一份句柄」的中间层——它增加的是间接层，不是能力。

3. **准入闸门只有一套，而它在主进程。** 图片限额、文本读全文、其余拒收带人话理由
   （`intakeFile`），都归主进程决定，渲染层只是显示结果。assistant-ui 的
   `accept` 字符串表达不了这套策略，接上去等于把闸门分成两半。

## 代价（明说）

- registry 的 `attachment.tsx` 装着没接。`UserMessageAttachments` 那一半本来就没接
  （ADR-0038：用户消息的附件走 `metadata.custom.otto` + 本仓的 `UserAttachments`，
  因为图片要走 IPC 懒取）；这条决定把 composer 那一半也留在外面。
- 输入框里的附件不长 assistant-ui 那副样子（缩略图卡片 + 悬停预览弹窗）。
  现在是 `StagedChips` 的小 chip 行。视觉上是退让，功能上没有缺口。

## 如果以后要改（把所有权真的移过去）

不是加个 adapter 那么简单，是四步，且都得一起做：

1. `OttoRuntimeProvider` 包到 `Welcome` 外面，或者接受「新会话卡不能贴附件」；
2. `AttachmentAdapter.add` 走 `intakePastedFiles` 拿 ref，adapter 内部维护
   `attachmentId → StagedAttachment` 的表；
3. 提交时从 `composer.getState().attachments` 查表换出 `OutgoingAttachment`，
   `store.send` 增加显式的 attachments 入参（现在是隐式读 `staged`）；
4. 会话建立那一刻，把 `staged` 里残留的（新会话卡贴的）一次性搬进 composer 并清空
   store——否则同一批附件会被两条路各发一次。

第 3 步会改 `store.send` 的契约（`tests/renderer/staging.test.ts` 钉着现在这套），
第 4 步是新增的一次性状态迁移。这是一次架构改动，不是接线，所以需要单独立项。
