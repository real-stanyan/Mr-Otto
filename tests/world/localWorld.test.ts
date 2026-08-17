import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorld } from "../../src/world/localWorld.js";
import { withAbortSignal } from "../../src/world/executionWorld.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "otter-world-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalWorld 围栏（root 圈地）", () => {
  it("相对路径落在 root 下", async () => {
    const world = createLocalWorld({ root });
    await world.fs.write("a.txt", "hi");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("hi");
    expect(await world.fs.read("a.txt")).toBe("hi");
  });

  it("root 内的绝对路径放行", async () => {
    const world = createLocalWorld({ root });
    await world.fs.write(join(root, "b.txt"), "in");
    expect(await world.fs.read(join(root, "b.txt"))).toBe("in");
  });

  it("../ 逃逸 → 抛错，文件系统没被碰", async () => {
    const world = createLocalWorld({ root });
    await expect(world.fs.write("../evil.txt", "x")).rejects.toThrow(/越出工程文件夹/);
  });

  it("外部绝对路径 → 抛错", async () => {
    const world = createLocalWorld({ root });
    await expect(world.fs.read("/etc/hosts")).rejects.toThrow(/越出工程文件夹/);
  });

  it("变体逃逸：root 前缀相同的兄弟目录也拦（/root-evil 不算 /root 里面）", async () => {
    const world = createLocalWorld({ root });
    await expect(world.fs.write(`${root}-evil/x.txt`, "x")).rejects.toThrow(/越出工程文件夹/);
  });

  it("exec 的 cwd = root", async () => {
    const world = createLocalWorld({ root });
    const result = await world.exec("pwd");
    // macOS 的 /tmp 是 /private/tmp 的符号链接，比对真实路径结尾即可
    expect(result.stdout.trim().endsWith(root.split("/").pop()!)).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("不配 root = 不设防（旧行为不变）", async () => {
    const world = createLocalWorld();
    const path = join(root, "free.txt");
    await world.fs.write(path, "free");
    expect(await world.fs.read(path)).toBe("free");
  });
});

describe("LocalWorld exec 中断（ADR-0006）", () => {
  it("signal 翻转 → 杀死子进程并抛'命令被中断'，不伪装成命令失败", async () => {
    const world = createLocalWorld({ root });
    const ctrl = new AbortController();
    const running = world.exec("sleep 30", { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    await expect(running).rejects.toThrow(/命令被中断/);
  });

  it("不带 signal 照旧：接口向后兼容", async () => {
    const world = createLocalWorld({ root });
    const result = await world.exec("echo ok");
    expect(result.stdout.trim()).toBe("ok");
  });
});

describe("LocalWorld exec 输出直播", () => {
  it("onOutput 收到碎片（stdout/stderr 分流标注），完整结果不受直播影响", async () => {
    const world = createLocalWorld({ root });
    const chunks: Array<{ chunk: string; stream: string }> = [];
    const result = await world.exec("printf out; printf err 1>&2", {
      onOutput: (chunk, stream) => chunks.push({ chunk, stream }),
    });
    // 事实层：完整输出照旧从返回值拿，一个字不少
    expect(result).toEqual({ stdout: "out", stderr: "err", exitCode: 0 });
    // 直播层：碎片拼起来 = 完整输出（分段边界不承诺，只承诺不丢字）
    const joined = (s: string) =>
      chunks.filter((c) => c.stream === s).map((c) => c.chunk).join("");
    expect(joined("stdout")).toBe("out");
    expect(joined("stderr")).toBe("err");
  });

  it("非零退出码同样直播——失败过程也是人要看的进展", async () => {
    const world = createLocalWorld({ root });
    const chunks: string[] = [];
    const result = await world.exec("printf boom 1>&2; exit 3", {
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result.exitCode).toBe(3);
    expect(chunks.join("")).toBe("boom");
  });
});

describe("http.postJson", () => {
  const okResponse = (json: unknown) =>
    ({ ok: true, status: 200, json: async () => json, text: async () => "" }) as Response;

  it("POST JSON body,带 Content-Type 与自定义 header,返回解析后的 JSON", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return okResponse({ hello: "world" });
    }) as typeof fetch;
    const world = createLocalWorld({ fetchImpl });

    const out = await world.http.postJson("https://x.test/rpc", { a: 1 }, { headers: { Authorization: "Bearer k" } });

    expect(out).toEqual({ hello: "world" });
    expect(calls[0]!.url).toBe("https://x.test/rpc");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ a: 1 }));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer k");
  });

  it("非 2xx 抛错并带状态码与响应片段", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 429, json: async () => ({}), text: async () => "rate limited" }) as Response) as typeof fetch;
    const world = createLocalWorld({ fetchImpl });
    await expect(world.http.postJson("https://x.test/rpc", {})).rejects.toThrow(/429.*rate limited/s);
  });

  it("中断:signal abort 时 reject,不伪装成正常失败", async () => {
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init!.signal!.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const world = createLocalWorld({ fetchImpl });
    const ac = new AbortController();
    const pending = world.http.postJson("https://x.test/rpc", {}, { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow(/中断/);
  });
});

describe("装饰器透传 http", () => {
  it("withAbortSignal 把 signal 焊进 http.postJson", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const base = createLocalWorld({
      fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
        seen.push(init?.signal ?? undefined);
        return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
      }) as typeof fetch,
    });
    const ac = new AbortController();
    const world = withAbortSignal(base, ac.signal);
    await world.http.postJson("https://x.test/rpc", {});
    expect(seen[0]).toBeDefined(); // signal 已注入(实现里可能是 AbortSignal.any 的合成信号)
  });
});
