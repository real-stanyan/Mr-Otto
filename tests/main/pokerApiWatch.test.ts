// watchTable 的断流重连。SSE 会被反代闲置超时掐、被睡眠断网切开;
// 服务端每次连接建立都先推当前视图,所以"重连"本身就是视图自愈。
import { describe, expect, it, vi } from "vitest";
import { watchTable } from "../../src/main/pokerApi.js";

function sseResponse(events: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const e of events) c.enqueue(enc.encode(e));
      c.close(); // 流自然结束 = 被掐断的形状
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("watchTable 重连", () => {
  it("流结束后退避重连,新视图接着到;退订后不再连", async () => {
    vi.useFakeTimers();
    try {
      const views: Array<{ pot: number }> = [];
      let calls = 0;
      const fetchImpl = async (): Promise<Response> => {
        calls += 1;
        return sseResponse([`data: {"pot":${calls}}\n\n`]);
      };
      const stop = watchTable(
        async () => "tok",
        "t1",
        (v) => views.push(v as { pot: number }),
        () => {},
        { baseUrl: "http://x/v1", fetchImpl }
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(views.map((v) => v.pot)).toEqual([1]);

      // 断流后 1s 重连;连上一次退避就归零,所以每次都是 1s
      await vi.advanceTimersByTimeAsync(1000);
      expect(views.map((v) => v.pot)).toEqual([1, 2]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(views.map((v) => v.pot)).toEqual([1, 2, 3]);

      stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("心跳注释行不会被当成数据推给渲染层", async () => {
    vi.useFakeTimers();
    try {
      const views: unknown[] = [];
      const errors: unknown[] = [];
      const fetchImpl = async (): Promise<Response> =>
        sseResponse([`: hb\n\n`, `data: {"pot":7}\n\n`, `: hb\n\n`]);
      const stop = watchTable(
        async () => "tok",
        "t1",
        (v) => views.push(v),
        (e) => errors.push(e),
        { baseUrl: "http://x/v1", fetchImpl }
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(views).toEqual([{ pot: 7 }]);
      expect(errors).toEqual([]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
