# 0013. Git Graph 只读可视化:git CLI 直调 + 自绘 SVG 泳道

日期:2026-08-18
状态:已接受

## 背景

Mr Otto 需要可视化当前会话 workspace 的 git 分支拓扑(参考 gitgraphui.com 形态)。
规格:docs/superpowers/specs/2026-08-18-git-graph-design.md。

## 决策

1. **git CLI 直调**(execFile,DI 模式镜像 protocolService),不引 nodegit /
   isomorphic-git——零原生依赖,复用用户已装的 git,凭证/配置全继承。
2. **自绘 SVG + 自写泳道算法**,不引 @gitgraph/react 等图形库——现存库停更且是
   "编程造图" API,不合"读仓库画图"场景;算法为纯函数(src/shared/gitGraph.ts),
   vitest 全覆盖。
3. **只读第一刀**(与 ADR-0012 同哲学):只跑 log / rev-parse / show,写操作
   (checkout/merge)与完整 diff 查看明确不做,留后续刀。

## 后果

- 泳道算法自维护:拓扑边角(八爪 merge、300 条截断处的悬空父)靠测试兜底
- 截断悬空父:第 300 条之外的父 hash 无行可落,线画到表尾自然消失,接受
- git 输出格式依赖 --format 稳定字段(%H/%P/%D/%an/%at/%s/%B),跨版本稳定
