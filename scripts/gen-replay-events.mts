// 生成 replay demo 用的事件日志：真 engine + fake adapter（不烧 API）
// 用法：npx tsx scripts/gen-replay-events.mts
// 输出 JSON 到 stdout；docs/replay-demo.html 里的 DATA 常量就是这么来的，
// 事件 schema 变了之后重跑本脚本，把输出粘回 HTML 的 DATA。
import { LoopEngine } from "../src/loop/engine.js";
import { EventStore } from "../src/session/store.js";
import { writeFileTool } from "../src/tools/writeFile.js";
import type { ModelAdapter, ModelReply } from "../src/model/adapter.js";
import type { ExecutionWorld } from "../src/world/executionWorld.js";
import type { Approver } from "../src/loop/approvalGate.js";

function fakeAdapter(script: ModelReply[]): ModelAdapter {
  let i = 0;
  return {
    model: "deepseek-v4-flash",
    async chat() {
      const r = script[i++];
      if (!r) throw new Error("script exhausted");
      return r;
    },
  };
}

const fakeWorld: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
};

const writeCall: ModelReply = {
  content: "",
  toolCalls: [{ id: "call_1", name: "write_file", args: { path: "/tmp/hello.txt", content: "你好，水獭！" } }],
};

async function run(sessionId: string, approver: Approver, finalReply: string) {
  const store = new EventStore(":memory:");
  const engine = new LoopEngine({
    store,
    adapter: fakeAdapter([writeCall, { content: finalReply }]),
    tools: [writeFileTool],
    world: fakeWorld,
    sessionId,
    approver,
  });
  await engine.runTurn("把「你好，水獭！」写进 /tmp/hello.txt");
  const events = store.load(sessionId);
  store.close();
  return events;
}

const approved = await run(
  "demo-approved",
  { decide: async () => ({ decision: "approved" }) },
  "写好了：/tmp/hello.txt，共 6 个字符。"
);
const denied = await run(
  "demo-denied",
  { decide: async () => ({ decision: "denied", reason: "先别动 /tmp" }) },
  "明白，已取消写入。需要换个路径吗？"
);

console.log(JSON.stringify({ approved, denied }));
