# 提示词面 benchmark（#218）

otto 的提示词面——skill 注入文案、子智能体前置词、compact 摘要指令、微压缩措辞——
改一个字没有任何反馈回路。这里是廉价的三臂对照骨架（照抄 ponytail 的
benchmarks 方法论，见 issue #218）：**无 X / X 版本 A / X 版本 B** × 多模型 ×
重复取中位数。

**不进 gate、不进 CI**：跑一次花真金白银（API 调用），只在改提示词面时手动跑。

## 跑法

需要 Node ≥ 18 和至少一个 key（`.env` 照 `.env.example` 抄）：

```bash
cd benchmarks
cp .env.example .env      # 填 DEEPSEEK_API_KEY（可选 ANTHROPIC_API_KEY）
npx promptfoo@latest eval -c promptfooconfig.yaml --env-file .env --repeat 10
npx promptfoo@latest view
```

metric 的自检（不花钱，纯本地断言）：

```bash
node metrics/compliance.js
```

## 第一个案例：skill 注入手法

三臂对照的是 ADR-0007 的一条现行架构假设——skill 走 **user 消息**注入
（「中途插 system 各家方言兼容性参差」），system 注入是当年被否决的备选：

| 臂 | 内容 |
|---|---|
| `arms/baseline.json` | 只有任务，无 skill——对照底线 |
| `arms/user-inject.json` | 现行手法：skill 全文作为独立 user 消息注入，头文案与投影一致 |
| `arms/system-inject.json` | 被否决的备选：skill 全文进 system 消息 |

玩具 skill「三点式」是一个可机判的行为约束（恰好三条 `- ` 要点，无开场白/结尾），
`metrics/compliance.js` 是门禁档断言：格式不合 = fail。服从率差异 = 注入手法的
效果差异。

> **头文案镜像警告**：`arms/user-inject.json` 里的注入头抄的是
> `src/session/deriveMessages.ts` 的 `skill_invoked` 投影文案。那边改了这边要跟
> ——两处不一致时 benchmark 测的就不是产品里的那句话。

## 怎么加新案例

1. `arms/` 下每臂一个 chat 格式 JSON（`{{task}}` 是变量）
2. `promptfooconfig.yaml` 的 `prompts` 列出臂、`tests` 列出任务
3. 可机判的效果写成 `metrics/` 下的 javascript 断言（带 `node xx.js` 自检）；
   判不了的老实标注「人眼评」，别硬造分数

## 诚实注记（照抄 ponytail 的教训，一字不让）

这里全是**单发对照**（一个 prompt 一个补全）。真实会话里提示词每轮重复出现、
与工具调用交织，单发赢的措辞在 agentic 会话里可能反而增加轮次和成本
（ponytail 自己的 agentic A/B 就翻过车）。这些数字用来**在两句文案之间做选择**，
不是会话成本的承诺。要下产品结论，去真会话里量。
