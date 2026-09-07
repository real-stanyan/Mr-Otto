// autoModel —— 「Auto」那一档：便宜模型先判一手，再决定这一 turn 用哪款。
//
// 云会话那一半（#1009，ADR-0237）先落的地，桌面这一半（#1042）跟上。两处**共用这一份**
// 不是为了省行数：分类提示词、「拿不准算 hard」、「认不出来一律 null」这三条是同一个
// 判据，各写一份的话会在某一天分家，而分家不报错——只会让同一句话在两块屏幕上被判成
// 两个难度（同 wire.ts / billing.ts 那条纪律）。
//
// 两边真正不同的只有**怎么向网关证明身份**：runtime 带 `x-runtime-secret` +
// on-behalf 头替所有者调，桌面带用户自己的 `Authorization: Bearer <jwt>`。所以这里
// 收的是一份算好的 headers，不是各自的凭据。
//
// ## 「哪款更强」这个信息今天不存在
//
// `BillingMe.models` 只是一串 id，没有价也没有档位；`model_route` 有价但没有能力字段。
// 这里**拿价当能力的代理**，不给表加 tier 列：价是我们照厂商价目维护的，而厂商本来
// 就按能力定价——这个代理跟着价目自己保鲜，加一列 tier 则是第二份要手工同步的事实。
//
// 落地方式是 edge 的 `routesQuery` 加了次级排序键 `price_out_micro_per_m.asc`，于是
// `me.models` 是**从便宜到贵有序**的。所以这里的 `models[0]` = 最便宜、`at(-1)` = 最贵，
// 判据是那条查询，不是这里的假设——两处要一起改（`tests/edge/billingQueries.test.ts`
// 钉住了排序键）。
//
// ## 判不出来一律回落到「今天的行为」
//
// 网络挂了、解析不出、清单只剩一款、分类器自己被限速——**都回 null**，调用方不改型号。
// 不猜，也不「拿不准就往贵的偏」：Auto 失灵时该有的表现是「跟以前一样」，不是「悄悄
// 开始烧钱」。这条与 ADR-0233「额度用完不改道」同一条纪律——安静地换一条更贵的路，
// 是这套东西最不该有的失败模式。

/** 选单里 Auto 那一项的值，也是 IPC 上「把这一格切成 Auto」的口令。
    不用空串：Radix 的 SelectItem 明确禁止空串 value（它拿空串表示「没选」），
    塞进去会在运行时抛错 */
export const AUTO_MODEL = "__auto__";

/** 分类器的输出。`null` = 没判出来（见文件头：一律回落） */
export type Difficulty = "simple" | "hard";

/** 分类器读到的那段话截多长。判难度不需要读完整篇——开头几百字足以看出「这是闲聊
    还是要写代码」，而截断同时封住了成本（输入价按 token 算）与提示词注入的面积 */
export const CLASSIFY_MAX_CHARS = 1200;

/** 分类用的系统提示。要求只回一个词，且**把「拿不准」这一档也映射成 hard**——
    模棱两可的请求交给强模型，是这两类错误里代价小的那个：判错往便宜了走会让一整轮
    白跑（还要重来），判错往贵了走只是这一轮多花点钱。 */
export const CLASSIFY_SYSTEM = [
  "你是一个模型路由分类器。读用户这一条请求，判断它需要哪一档模型。",
  "只回一个词，不要解释、不要标点：simple 或 hard。",
  "",
  "simple：闲聊、问候、简单问答、改一句话、格式转换、明确且范围很小的改动。",
  "hard：写代码或改代码、多步骤任务、需要推理或规划、数据分析、长文档处理、",
  "      需求本身有歧义要先判断的、以及任何你拿不准的。",
].join("\n");

/** 分类器的回答 → 档位。**认不出来一律 null**（不是「默认 simple」）：认不出来说明
    这次分类没成功，该走回落，而不是拿一个我们自己编的答案继续往下走 */
export function parseDifficulty(raw: string): Difficulty | null {
  const t = raw.trim().toLowerCase();
  if (t.startsWith("simple")) return "simple";
  if (t.startsWith("hard")) return "hard";
  return null;
}

/**
 * 档位 + 有序清单 → 这一 turn 用哪款。
 *
 * `models` 必须是 edge 给的那份**从便宜到贵**的顺序。少于两款时回 null：只有一款
 * 时「挑」这个动作没有意义，两档指向同一个 id，白打一次分类器。
 */
export function modelForDifficulty(d: Difficulty, models: readonly string[]): string | null {
  if (models.length < 2) return null;
  return d === "simple" ? models[0]! : models[models.length - 1]!;
}

export interface AutoModelDeps {
  /** 网关的 `/llm/v1` 前缀（不带尾斜杠）。两边各自拼——runtime 从 env，桌面从 hostedQuota */
  llmBase: string;
  /** 向网关证明身份的那几个头。**这是两条路唯一的差别**，见文件头 */
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** 判不出来时说一声。不抛异常——分类失败不该让 turn 失败 */
  log?: (msg: string) => void;
}

/**
 * 判一手：拿最便宜那款读这段话，回这一 turn 该用的型号 id；判不出来回 null。
 *
 * **走同一条网关、带同样的归因头**，所以这一次调用照样落 `usage_event`、照样扣窗口
 * ——不做暗扣。代价：约 200 输入 / 5 输出，在最便宜那款上约 $0.00005，外加
 * 0.3~0.8 秒延迟。
 */
export async function pickAutoModel(
  deps: AutoModelDeps,
  text: string,
  models: readonly string[]
): Promise<string | null> {
  if (models.length < 2) return null;
  const cheap = models[0]!;
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.llmBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...deps.headers },
      body: JSON.stringify({
        model: cheap,
        messages: [
          { role: "system", content: CLASSIFY_SYSTEM },
          { role: "user", content: text.slice(0, CLASSIFY_MAX_CHARS) },
        ],
        // 8 而不是 1：便宜档大多是推理模型，思考 token 也算在 completion 里，
        // 给 1 的话正文一个字都出不来（真机上 qwen3.8-flash 的 8 个 completion
        // token 里有 7 个是 reasoning）
        max_tokens: 8,
        stream: false,
      }),
    });
    if (!res.ok) {
      deps.log?.(`Auto 选型：网关回 ${res.status}，这一轮按原样走`);
      return null;
    }
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    const d = typeof content === "string" ? parseDifficulty(content) : null;
    if (d === null) {
      deps.log?.("Auto 选型：分类器没给出可识别的答案，这一轮按原样走");
      return null;
    }
    return modelForDifficulty(d, models);
  } catch (e) {
    deps.log?.(`Auto 选型：${(e as Error).message}，这一轮按原样走`);
    return null;
  }
}

/** Auto 此刻开着没有 = 日志投影：最后一条 `model_changed` 说了算，没有就是关着。
    和「当前型号」「当前 lane」同一个取法（main/agent.ts、shared/modelLane.ts 的
    `laneOf`），三者读的是同一条事件——这一格不需要第二种持久化。

    形参写成结构类型而不是 `SessionEvent`：这份文件被 runtime 与渲染层同时 import，
    拉进整棵事件类型只会把依赖面铺开（同 `laneOf` 的写法） */
export function autoModelOf(events: readonly { type: string; auto?: boolean }[]): boolean {
  return events.filter((e) => e.type === "model_changed").at(-1)?.auto === true;
}
