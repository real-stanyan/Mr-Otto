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

describe("LocalWorld execDetached（issue #389 后台执行）", () => {
  it("跑完返回完整结果，cwd 同 root", async () => {
    const world = createLocalWorld({ root });
    const result = await world.execDetached!("pwd; echo bg-ok");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bg-ok");
  });

  it("起不来按世界反馈返回（exitCode 1），不 reject", async () => {
    const world = createLocalWorld({ root });
    const result = await world.execDetached!("exit 7");
    expect(result.exitCode).toBe(7);
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

describe("LocalWorld exec 内存有界（issue #343 第一层 HeadTail）", () => {
  it("超大输出:进程跑到自然结束,头尾保留、中段丢弃(旧 execAsync maxBuffer 会直接杀进程)", async () => {
    const world = createLocalWorld({ root });
    // ~3.2MB 输出,远超 1M 字符缓冲上限;末尾的 TAIL-END 是"最终结果"的替身
    const script =
      'const s="x".repeat(65536); for (let i=0;i<50;i++) process.stdout.write(s); process.stdout.write("TAIL-END");';
    const result = await world.exec(`node -e '${script}'`);
    expect(result.exitCode).toBe(0); // 自然结束,不是被 maxBuffer 杀掉
    expect(result.stdout.length).toBeLessThan(1_100_000); // 内存有界
    expect(result.stdout).toContain("TAIL-END"); // 尾巴在 —— 旧实现这里什么都拿不到
    expect(result.stdout).toContain("中间省略");
  }, 30_000);
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

describe("http.getJson", () => {
  it("发 GET，不带 body，解析 JSON", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return { ok: true, status: 200, json: async () => ({ servers: [] }), text: async () => "" } as Response;
    }) as typeof fetch;
    const world = createLocalWorld({ fetchImpl });

    const out = await world.http.getJson!("https://x.test/v0/servers?search=a");

    expect(out).toEqual({ servers: [] });
    expect(calls[0]!.url).toBe("https://x.test/v0/servers?search=a");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("非 2xx 抛，错误里带状态码和响应片段", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503, json: async () => ({}), text: async () => "upstream exploded" }) as Response) as typeof fetch;
    const world = createLocalWorld({ fetchImpl });
    await expect(world.http.getJson!("https://x.test/v0/servers")).rejects.toThrow(/503.*upstream exploded/s);
  });

  it("外部中断穿透，报错含「中断」", async () => {
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init!.signal!.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const world = createLocalWorld({ fetchImpl });
    const ac = new AbortController();
    const pending = world.http.getJson!("https://x.test/v0/servers", { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow(/中断/);
  });

  it("withAbortSignal 把 signal 焊进 http.getJson", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const base = createLocalWorld({
      fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
        seen.push(init?.signal ?? undefined);
        return new Promise((_res, rej) => {
          if (init?.signal?.aborted) {
            rej(new DOMException("Aborted", "AbortError"));
          } else {
            init?.signal?.addEventListener("abort", () => {
              rej(new DOMException("Aborted", "AbortError"));
            });
          }
        });
      }) as unknown as typeof fetch,
    });
    const ac = new AbortController();
    const world = withAbortSignal(base, ac.signal);
    const pending = world.http.getJson!("https://x.test/v0/servers");
    ac.abort();
    await expect(pending).rejects.toThrow(/中断/);
    expect(seen[0]).toBeDefined();
    expect(seen[0]?.aborted).toBe(true);
  });
});

describe("装饰器透传 http", () => {
  it("withAbortSignal 把 signal 焊进 http.postJson", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const base = createLocalWorld({
      fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
        seen.push(init?.signal ?? undefined);
        // 让 fetch 在 signal abort 时 reject
        return new Promise((_res, rej) => {
          if (init?.signal?.aborted) {
            rej(new DOMException("Aborted", "AbortError"));
          } else {
            init?.signal?.addEventListener("abort", () => {
              rej(new DOMException("Aborted", "AbortError"));
            });
            // Never resolve normally in this test (测试工具场景中 abort 就是目标)
          }
        });
      }) as unknown as typeof fetch,
    });
    const ac = new AbortController();
    const world = withAbortSignal(base, ac.signal);
    const pending = world.http.postJson("https://x.test/rpc", {});
    ac.abort();
    // 验证外部中断确实穿透：postJson 因 abort 而 reject，报错含「中断」
    await expect(pending).rejects.toThrow(/中断/);
    // 验证 fetchImpl 收到的 signal 确实是中止状态（AbortSignal.any 合成了外部 signal）
    expect(seen[0]).toBeDefined();
    expect(seen[0]?.aborted).toBe(true);
  });

  // issue #395：timeoutMs 是调用方的显式放宽/收紧请求。
  // sleep 2 而不是更长：CI 上 close 事件可能等到管道随子进程自然退出才来
  //（SIGTERM 已发、exitCode 已定，只是 close 迟到）——断言只看结果不掐表，
  // 测试超时给足 15s
  it("exec 尊重 opts.timeoutMs：超限被 SIGTERM 终止，exitCode 124", { timeout: 15_000 }, async () => {
    const world = createLocalWorld();
    const r = await world.exec("sleep 2", { timeoutMs: 300 });
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain("终止");
  });
});
