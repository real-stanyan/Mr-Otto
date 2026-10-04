# MiniMax T2A v2：Otto 用的音色 × emotion 兼容矩阵

- 来源：#1515；方法与表的形状照 ai-podcast `docs/voice-emotion-compat.md`
- 型号：`speech-2.8-turbo`（国内站 `api.minimaxi.com`）
- 方法：`npx tsx scripts/tts-emotion-matrix.mjs`，每个 voice × emotion 各发一次 `text:"测"`，`status_code == 0` 且回了 `data.audio` = 接受

## 矩阵

**待真机**：2026-10-04 想用 ai-podcast 的 key 探，回 `1008 insufficient balance`；本机没有 Otto 的 key（只在 Worker secret）。
部署 edge 之后由维护者跑一遍，把脚本输出贴到这里。

## 怎么用这张表

- 「✗」的格子：运行时由 `serveTts` 的降级路兜（去掉 emotion 重试一次），那一句平读不出错；表上记下来是为了知道哪几档在哪个音色上从来没生效过。
- 全 ✓ 则 `TTS_EMOTION_INTENSITY` 可以考虑往播客的 2.0 拉（人耳决定）。
