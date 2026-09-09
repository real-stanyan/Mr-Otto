# ADR-0279：弹窗溢出兜底收进 DialogContent——grid 换 flex，内层那层才缩得动

- 状态：已采纳（2026-09-09）
- Issue：#998（承 #563 / #997 两处各自修过的现场）

## 背景

`DialogContent` 上游默认既没有 `max-h` 也没有 `overflow`：内容高过视口，弹窗朝上下两头等量溢出，
两头都够不着，页面也不滚。失败模式是**静默的**——写弹窗的人只有在自己那处内容碰巧变长的那天
才会发现，而那天用户已经先看见了。#563（记忆设置）和 #997（智能体编辑）是两处各自修过的现场，
剩下十几处消费方各凭记忆。#1120 把三处最重的编辑器从弹窗搬成推入页之后，这个病还在所有留下的
弹窗头上。

维护者在 #998 评论里实测钉死了一条关键事实：**`grid` + `max-height` + 内层 `overflow-y-auto`
不生效**。auto 行在被 `max-height` 夹住的 grid 里按 max-content 把轨道定死，然后容器才夹自己的
高度——轨道已经定死，内容照样溢出，内层一格都不滚。`flex flex-col` 下同一个结构是对的。

## 决策

### 1. 兜底收进 `DialogContent`（与 `[&>*]:min-w-0` 同一条原则）

`dialog.tsx` 的 `DialogContent`：`grid` → `flex flex-col`，加
`max-h-[calc(100dvh-2rem)] overflow-y-auto`。`AlertDialogContent`（`alert-dialog.tsx`）同一条兜底
——同一个病，消费方更少，没有关闭 X，代价更小。2rem 与横向的 `max-w-[calc(100%-2rem)]`
同一把尺：上下各 1rem。

### 2. 三层分工，滚动放哪一层由消费方的结构说了算

- **什么都不写的消费方**：整张卡滚。关闭 X 是 `absolute`，包含块是滚动容器，会跟着内容滚出
  视野——这是兜底已知的代价，至少内容够得着、卡不会顶出屏幕。
- **想固定头/尾的消费方**：把会长的那截包一层 `min-h-0 overflow-y-auto`。flex 子项缩得动，
  头尾与 X 都钉住（#997 的写法，现在它从「碰巧对的个例」变成「有兜底支撑的标准写法」）。
- **自己另有安排的**：className 照写。`cn` 走 twMerge，后写的赢——TrajectoryView 的
  `max-h-[85vh]`、MemorySettings 的 `max-h-[calc(100dvh-4rem)]` 照旧生效，一个字不用改。

「滚动放 `DialogContent` 自己」还是「放中间那层」的取舍：前者消费方零成本但 X 跟滚；后者要每个
消费方恰好是 header/body/footer 三段，现在十几处结构不一。答案是**两层都给**：整窗滚是兜底线，
内层滚是升级路径，消费方按需上楼，不上楼也不会摔。

### 3. `overflow` 的裁剪风险排查过：没有

`overflow` 会裁掉内联（非 portal）的绝对定位子元素。全仓消费方逐个扫过：弹层全部走 Radix
portal，唯一一处内联 `absolute inset-0` 在头像钮自己的 `overflow-hidden` 圈里（ProfileEditor），
贴的是头像自己，不受影响。

### 4. 保鲜期是断言不是注释

jsdom 量不出布局，所以 `tests/renderer/dialogOverflow.test.tsx` 钉的是契约的字面量：兜底类在、
`grid` 不在、`[&>*]:min-w-0` 没被挤掉、**消费方自己的 max-h 必须赢**（最后这条是 TrajectoryView /
MemorySettings 赖以活的那条，被 twMerge 行为变更打断时当场红，不是等某个弹窗哪天 silently 顶出
屏幕）。几何本身（2rem 这个数）刻意不写死——同 ADR-0236 第 1 条的账。

## 否决过的做法

- **`grid-rows-[auto_1fr_auto]` 当兜底**：同样有效，但要求消费方结构恰好三段；现在十几处结构
  不一，强推等于让每个弹窗先重排一次结构。
- **只加 `max-h` 不加 `overflow`**：内容照样画出卡片外（overflow 默认 visible），是把 #563 的
  「弹窗变透明」从宽度方向搬到高度方向。
- **把十几个弹窗都改成内层滚**：收敛的目的是兜底不是重排；有真实超长记录的弹窗（ProxyDialog
  「已授权」tab 等）先吃整窗滚的兜底，哪天体验上嫌 X 跟滚再单独上楼。
- **`VoiceCallOverlay` 不进射程**：它直接用 `DialogPrimitive.Content` 铺全屏，不是居中卡片，
  病不一样（内部挤，不是顶出视口），要修也是另一张票。

## 代价

- 什么都不写的长弹窗，关闭 X 与标题会跟着内容滚走（兜底线，不是推荐态）。
- grid → flex 对现存消费方排版等价（单列、align/justify 都 stretch、gap 不变），但这是一个
  共享组件的排版基座变更，真机回归值得过一遍各弹窗——本仓门禁与 CI 只能保住类名字面量。
- TrajectoryView 的 `grid-rows-[auto_minmax(0,1fr)]` 在 flex 下失效，已删；它内层的
  `min-h-0 overflow-y-auto` 在 flex 下反而直接成立，行为不变。
