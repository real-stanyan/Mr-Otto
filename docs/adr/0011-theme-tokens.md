# ADR-0011: 颜色令牌全盘 shadcn 语义化,点缀色与 accent 分离

日期:2026-08-18　状态:已接受　issue:#13

## 背景

file-input-v1 之后 UI 面积持续扩张(chips/缩略图/审批卡/设置页),
裸 CSS 手搓配色的命名税(ADR-0010 已诊断)在颜色令牌上更明显:旧变量
名跟着具体用途起(比如某个背景色只服务一处),shadcn 组件进场后要么
对不上号、要么得逐组件重写一套配色。同时项目原有一枚品牌点缀色
(dark 橙/light 蓝),它跟 shadcn 语义色系(primary/accent/muted…)不是
一回事——accent 是 shadcn 组件的悬停/选中面,点缀色是产品识别色,
混用会让点缀色的"这是可点的/这是重点"信号被组件悬停态盖掉,或者反过来
点缀色铺得到处都是,盖过 ok/deny 这类状态色本该有的语义。

## 决定

- **令牌全盘改用 shadcn 语义命名**(`background`/`foreground`/`primary`/
  `secondary`/`muted`/`accent`/`border`/`input`/`ring`…),不保留旧名。
  裸变量定义在 `:root`(light 板)和 `.dark`(dark 板),Tailwind v4 用
  `@theme inline` 把这批变量接进 utility 类,组件写 `bg-background`
  `text-muted-foreground` 这类语义类名,不再对着色值调色。
- **`--brand` 独立于 `--accent`**:`--accent` 留给 shadcn 组件自己的
  悬停/选中面(跟着组件走,不承载产品含义);`--brand` 是产品点缀色
  (dark `#FE7F2D` 橙 / light `#4A70A9` 蓝),只上链接、光标、焦点环、
  活跃态这几个"指示可交互/当前所在"的点位。
- **点缀色禁止铺主面积**:按钮背景、卡片背景、大块状态条这类主面积
  不用 `--brand`——一是避免跟 ok/deny(红绿)这类状态色抢注意力,
  二是点缀色本该稀缺才有指向性,铺开就退化成普通装饰色。

## 后果

- 保留区(md 渲染/hljs 代码高亮/hl 语法着色/replay 回放画布/自定义
  滚动条)原本硬编码 dark 配色,现在全部改走变量,双主题下都可读;
  新增颜色一律双主题定义(`:root` + `.dark` 各一份),不允许只写一套
  就上线。
- 主题偏好(`system|light|dark`)存 `localStorage` 键 `otter-theme`,
  不是会话事实,不进事件日志(AGENTS.md 的"model-visible means
  logged"管的是模型看到的东西,纯本地 UI 偏好不在此列)。
- shadcn 组件迁移成本降到零对色:组件源码自带语义类名,接上本 ADR
  的变量表即可双主题,不用逐组件调色板。

## 已否决的备选

- **方案 B:保留旧令牌名,新旧两套变量桥接**——短期改动量小,但长期
  背两套词汇(旧名给存量代码,新名给新组件),每次读代码都要先辨认
  在哪套体系里,增量维护税比一次性改名更贵,否决。
