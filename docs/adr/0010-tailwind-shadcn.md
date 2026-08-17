# ADR-0010: 前端样式钉死 Tailwind CSS,组件库钉死 shadcn/ui

日期:2026-08-17　状态:已接受　issue:#9

## 背景

渲染层样式一直是手写 `app.css`(约 900 行自定义类),无组件库、无设计
系统。每个新 UI 需求都在裸 CSS 上手搓:类名自造、间距/配色逐处硬编码、
无障碍(焦点管理、ARIA)全靠自觉。file-input-v1 的 chips/缩略图/文件
卡片再次验证:每块新 UI 都在重新发明按钮和卡片。

用户(stanyan)会话内直接定规矩:CSS 用 Tailwind,UI 库用 shadcn/ui。
属 Tech stack 变更 = L1,会话内同意有效(单人仓库,ADR-0034/0042 边界),
本 ADR + issue #9 + PR 补全三件套。

## 决定

- **CSS 方案:Tailwind CSS**。utility-first,样式与标记同处,消灭
  自造类名的命名税和 app.css 的单文件膨胀。
- **UI 组件库:shadcn/ui**。复制式组件(源码进仓库,非运行时依赖),
  Radix UI 无障碍底座,Tailwind 原生。Electron 渲染进程就是 Chromium
  里的 React,零兼容问题;portal 类组件(dialog/popover)挂渲染进程
  DOM,与 ShellBridge 架构无冲突。

## 生效边界(规矩 ≠ 立即迁移)

- **新增 UI**:从本 ADR 合入起,新组件用 Tailwind + shadcn/ui 写。
- **存量 app.css**:不立即重写。整体迁移排在 harness 完工后的 UI
  翻新期,一次性切换,不零敲碎打双轨混写。
- 迁移期内允许两套并存;改到哪个存量组件,顺手迁到 Tailwind,
  但不为迁移而迁移。

## 已否决的备选

- **继续裸 CSS**:零依赖,但命名税 + 无设计系统 + 无障碍手工,
  UI 面积越大债越重。
- **CSS-in-JS(styled-components 等)**:运行时开销,与 React 19/
  RSC 生态走向相悖,shadcn 也不基于它。
- **完整组件库(MUI/Antd)**:重、样式定制对抗框架;shadcn 复制式
  源码可改,和"仓库是唯一共享记忆"的协议气质一致。

## 何时推翻

- Tailwind 大版本破坏性变更导致维护成本高于收益;
- shadcn/ui 停止维护且 Radix 底座失修;
- 出现明显更优的复制式组件方案且迁移成本可接受。
