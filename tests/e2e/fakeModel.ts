// 假模型 —— 一个只讲 OpenAI 方言 `/chat/completions` 的本机 HTTP 服务。
//
// 为什么要它：#142 / #147 清单里最值钱的那几条（派活的 pill、点正在跑的那一下、
// 中断、子会话日志里有没有前置词）都要求「模型真的派了一次活」。对着真厂商跑
// 有三个问题：要 key、要钱、而且**不确定** —— 模型今天愿意调 task、明天改说
// 「我直接帮你看吧」，验收就变成了掷骰子。假模型让「这一轮吐什么」成为用例的
// 输入而不是运气。
//
// 端点靠 provider 的 `*_BASE_URL` 环境变量顶掉（providerCatalog 本来就为自建代理
// 留了这个口子），所以从 routeModel 到 adapter 到 engine 的每一步跑的都是真代码，
// 假的只有对面那台服务器。
//
// 响应器拿到的是**整个请求体**，包括 messages 和 tools —— 用它区分「这是父会话
// 那一轮」还是「子会话那一轮」（两边打的是同一个端点）。

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeToolCall {
  name: string;
  args: unknown;
}

export interface FakeTurn {
  content?: string;
  toolCalls?: FakeToolCall[];
  /** 流式时每个文本碎片之间停多久 —— 给「跑着的时候点那枚 pill」这类用例留出手速 */
  delayMs?: number;
}

export interface FakeRequest {
  model: string;
  messages: { role: string; content: unknown }[];
  tools?: {
    function: {
      name: string;
      /** task 那把工具的 agent 字段是个 enum —— 「此刻派得出谁」就写在这里，
          验作用域/首次可用那几条时读它 */
      parameters?: { properties?: { agent?: { enum?: string[] } } };
    };
  }[];
  stream?: boolean;
}

export type FakeResponder = (req: FakeRequest, index: number) => FakeTurn | Promise<FakeTurn>;

export interface FakeModel {
  /** 塞给 `<PROVIDER>_BASE_URL` 的值（含 /v1 版本段） */
  baseUrl: string;
  /** 收到过的每一个请求体，按到达顺序 */
  requests: FakeRequest[];
  close(): Promise<void>;
}

/** 一个 tool_call 的 SSE 碎片。id/name 在首块，arguments 分两块发 ——
    adapter 那侧按 index 归位、拼完整才 parse，分块发才验得到那条路 */
function toolCallChunks(calls: FakeToolCall[]): unknown[] {
  const out: unknown[] = [];
  calls.forEach((c, index) => {
    const args = JSON.stringify(c.args ?? {});
    const half = Math.ceil(args.length / 2);
    out.push({
      choices: [
        {
          delta: {
            tool_calls: [
              { index, id: `call_${index}_${c.name}`, function: { name: c.name, arguments: args.slice(0, half) } },
            ],
          },
        },
      ],
    });
    out.push({
      choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(half) } }] } }],
    });
  });
  return out;
}

export async function startFakeModel(responder: FakeResponder): Promise<FakeModel> {
  const requests: FakeRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        let body: FakeRequest;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as FakeRequest;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"假模型收到的不是 JSON"}');
          return;
        }
        const index = requests.length;
        requests.push(body);
        const turn = await responder(body, index);
        const usage = { prompt_tokens: 100, completion_tokens: 20 };

        if (!body.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: turn.content ?? "",
                    ...(turn.toolCalls?.length
                      ? {
                          tool_calls: turn.toolCalls.map((c, i) => ({
                            id: `call_${i}_${c.name}`,
                            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
                          })),
                        }
                      : {}),
                  },
                },
              ],
              usage,
            })
          );
          return;
        }

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        // 正文按字符发：验的是「直播尾巴真的在动」，一块吐完看不出流没流
        for (const ch of turn.content ?? "") {
          send({ choices: [{ delta: { content: ch } }] });
          if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
        }
        for (const c of toolCallChunks(turn.toolCalls ?? [])) send(c);
        send({ choices: [{ delta: {} }], usage });
        res.write("data: [DONE]\n\n");
        res.end();
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 把假模型接到 DeepSeek 那一格（默认选中的型号就是它，省一次切型号的点击）。
    key 给一个明显是假的：开发机上可能真配着 DEEPSEEK_API_KEY，而 e2e 继承了
    整个 process.env —— 不顶掉的话，一旦哪天 baseUrl 没生效，真 key 就发出去了 */
export function fakeModelEnv(fake: FakeModel): Record<string, string> {
  return { DEEPSEEK_BASE_URL: fake.baseUrl, DEEPSEEK_API_KEY: "fake-e2e-key-not-a-real-one" };
}
