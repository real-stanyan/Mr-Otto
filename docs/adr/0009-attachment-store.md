# ADR-0009: 图片附件走内容寻址附件库,日志只存引用

日期:2026-08-17　状态:已接受

## 背景

file-input-v1 要让图片进入模型上下文。事件日志是唯一事实源且只增不减,
图片 base64 直接进日志 = 几 MB 大 row 躺进最热路径(store.load 每 turn
全量读),压缩层也压不动。参考 DeepSeek Harness:附件字节与日志分家。

## 决定

- 图片字节存 `userData/attachments/<sha256>`(0600/0700),内容寻址、
  写后不可变、同图去重;`user_message` 事件只加可选 `attachments` 引用
  数组 `{id, mediaType, bytes, name}`(schema 向后兼容)
- 投影(deriveMessages)保持纯函数:只产出 `image_ref` 分片;
  bytes 在 adapter 请求组装的最后一刻经注入的 `readAttachment` 解出转
  base64——日志与投影里永远没有 base64 大块
- 文本文件不进附件库:发送时全文内联进 content(skill_invoked 同款
  快照语义,日志自包含)
- name 只留 basename:本机路径不进日志

## 代价(接受)

- 日志重放依赖附件库:bytes 与 log 分家,备份/迁移要带上 attachments 目录;
  附件文件丢失时时间线显示占位、模型请求会失败——不隐藏不伪造
- 取消发送的已入库图片成为孤儿文件:无害(内容寻址,重发自动复用),
  GC 留将来
- 非视觉模型收到图片:API 自己报错,走既有 turn 失败管线——不维护
  模型能力表,能力以 API 实际响应为准

## 已否决

- base64 直接进日志:零新组件但性能债进最热路径
- 文件复制进 workspace:污染用户工程文件夹

## 追记(2026-08-17):vision-bridge 与能力表

「非视觉模型收图靠 API 报错、不维护能力表」被推翻:实测现役三款全纯文本,
图片功能没有可用路径。改为目录记 `supportsVision`,无视觉模型发图时由
glm-4.6v-flash 代读(image_described 事件,解析文本落盘——model-visible
means logged)。能力表维护成本 = 每型号一个布尔,换取图片对全部模型可用;
代读质量 ≤ 原图直读,有视觉的模型仍走原图。代读员写死为目录里的免费视觉款
(src/main/visionBridge.ts VISION_BRIDGE_MODEL),换员改一行。
