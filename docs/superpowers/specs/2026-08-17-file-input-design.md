# Mr Otto 文件/图片输入 — 设计 v1(file-input-v1)

日期:2026-08-17　状态:已批准(会话内)

## 目的与范围

给会话内输入框加附件能力:审批模式切换按钮右边加 ＋ 按钮,点击弹系统文件
选择器,选中的图片/文本文件进入模型上下文。

**明确不做**:
- 新建会话页 composer(先只做会话内,验证通了再铺)
- 粘贴/拖放入口(只做 ＋ 按钮)
- 任意二进制文件(图片之外的二进制拒收)
- OCR 兜底(非视觉模型直接报错)
- 附件 GC(孤儿文件无害,留将来)

## 背景(DeepSeek Harness 对照)

DSH 附件路线:附件服务只收图片(png/jpeg/webp/gif),内容寻址存储
(`objects/<sha256>`),事件日志只存轻量 ref,消息 content 是 ContentBlock
数组,adapter 请求时才解 bytes 转 base64;任意文件走 @ 引用(路径进
prompt,模型用工具读)。本设计 = DSH lite:同样的 ref+存储+投影分层,
砍掉像素探测/宽高元数据/拖放粘贴。

## 架构

### 1. AttachmentStore(主进程,`src/session/attachments.ts`)

- EventStore 同级的 app 资源(组装根特权,可直接碰 fs——ExecutionWorld
  硬规则管的是工具实现,不管 app 基础设施)
- 图片字节落 `userData/attachments/<sha256>`,文件 0600 目录 0700
- 内容寻址:id = `sha256:<hex>`,同图去重,写后不可变
- API:`save(data: Uint8Array, mediaType, name?) → UserAttachmentRef`、
  `read(id) → Uint8Array`(不存在抛错)
- 入库校验:magic bytes 嗅探真实类型(png/jpeg/webp/gif 四种),与声明
  不符拒;单张 >10MB 拒
- name 只留 basename(剥 `/` 与 `\` 两种分隔符):防本机路径漏进日志

### 2. Schema(向后兼容,只加可选字段)

```ts
export interface UserAttachmentRef {
  id: string;        // "sha256:<hex>"
  mediaType: string; // "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  bytes: number;
  name?: string;     // basename,可选
}

export interface UserMessageEvent extends SessionEventBase {
  type: "user_message";
  content: string;
  attachments?: UserAttachmentRef[]; // 可选 = 旧日志照常重放
}
```

- 图片:事件只存 ref,bytes 在附件库。日志重放依赖附件库(bytes 与 log
  分家)——接受的取舍,换日志永远轻
- 文本文件:不进附件库。发送时全文内联进 content(格式:
  `[用户附上文件「<name>」,内容如下]\n<全文>`,追加在正文后),同
  skill_invoked 快照语义——日志自包含,原文件后续改/删不影响重放
- 文本文件校验:≤100KB/个;头 8KB 含 `\0` 判为二进制,拒收

### 3. IPC 流(ShellBridge)

- ＋ 按钮 → `bridge.pickAttachments()` → 主进程 `dialog.showOpenDialog`
  (multiSelections,过滤图片+文本)→ 逐个分类:
  - 图片:即刻入库,返 `{ kind: "image", ref, previewDataUrl }`
  - 文本:读内容,返 `{ kind: "text", name, content, bytes }`
  - 超限/类型不认:该文件返 `{ kind: "rejected", name, reason }`,UI 提示
- 渲染层暂存(staging)选中项,chips 展示;发送前可 × 移除
- 发送:`sendMessage(sessionId, text, skill?, attachments?)`——主进程拼
  事件:content = 正文 + 文本文件块;attachments = image refs
- 取消发送的已入库图片 = 无害孤儿(内容寻址,重发自动复用)
- 历史回看:`bridge.attachmentDataUrl(id) → string`,渲染层懒取 + 内存缓存
- 限额:图片 ≤4 张/条(选择器多选后超出部分拒并提示)

### 4. 投影(deriveMessages,保持纯函数)

```ts
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_ref"; id: string; mediaType: string };

export interface UserChatMessage {
  role: "user";
  content: string | UserContentPart[];
}
```

- user_message 无 attachments → content 照旧 string:老日志投影逐字节
  不变(测试钉住)
- 有 attachments → parts:[text part(事件 content 全文), ...image_ref parts]
- 投影不碰磁盘:ref 解 bytes 是 adapter 的事(纯函数守住)
- 压缩层:image_ref part 本身轻,不参与截断;text part 沿用现有规则不变
  (压缩只处理 string content 的老逻辑对 parts 数组消息:跳过截断,原样
  放行——附件消息进老区暂不瘦身,量小可接受)

### 5. Adapter(openaiCompatible)

- 构造参数加可选 `readAttachment?: (id: string) => Uint8Array`
  (agent.ts 注入 `store.read`)
- 请求组装:content 为 string 照旧;为 parts 时:
  - text part → `{ type: "text", text }`
  - image_ref part → `{ type: "image_url", image_url: { url:
    "data:<mediaType>;base64,<base64>" } }`(OpenAI vision 方言)
- 未注入 readAttachment 却遇到 image_ref → 抛错(配置缺口早暴露)
- 非视觉模型:API 自己报 400,走既有 turn 失败管线,UI 显示
  「turn 失败」——不维护模型能力表

### 6. UI(App.tsx + styles)

- ComposerBar:模式切换 select 右边加 ＋ 按钮(仅图标,title「添加文件」;
  turn running 时禁用)
- textarea 上方附件 chips 行:图片=缩略图(previewDataUrl),文本=文件名
  +大小 chip;每个 chip 带 × 移除;发送成功后清空 staging
- 时间线:user_message 事件带 attachments → 正文下方渲染缩略图
  (attachmentDataUrl 懒取,点击不放大——lightbox 留将来)
- 被拒文件:composer 内一行红字提示(reason),下次选择时清除

## 安全条款

- 附件库 0600/0700,只存图片字节;事件日志不含 base64
- name 剥路径,日志不漏本机目录结构
- previewDataUrl / attachmentDataUrl 只回渲染层展示用,不进日志

## 测试

- attachmentStore(vitest,tmp 目录):save/read 往返、sha256 id 形状、
  同内容去重、类型嗅探不符拒、>10MB 拒、name 剥路径
- deriveMessages:带 attachments 投影出 parts 形状;无 attachments 老日志
  逐字节回归;压缩对 parts 消息放行不截
- adapter:注入假 readAttachment,验 image_url data URL 组装;string
  content 请求体不变;未注入遇 image_ref 抛错
- 文本内联/二进制嗅探/限额:主进程 pick 逻辑单测(dialog 注入假实现)
- 不打真 API;不依赖真视觉模型

## 已否决的备选

- **base64 直接进日志**:零新组件、日志全自包含,但几 MB 大 row 躺进
  最热路径(store.load 每 turn 全量读),性能债太重
- **文件复制进 workspace + 路径引用**:通吃二进制,但污染用户工程文件夹
- **粘贴/拖放入口**:实现代价小但本期只验证 ＋ 按钮主链路,留下期
