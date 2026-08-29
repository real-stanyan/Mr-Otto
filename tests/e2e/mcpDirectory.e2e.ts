// 连接器目录页的真机验收（issue #699；功能本体 #661 / ADR-0171）。
//
// 这一层验的是三条**只有真渲染 + 真 IPC 才成立**的行为，单元测试用假 bridge
// 顶掉了 window.otter，验不到它们：
//
// ① 首屏零网络。「精选层是仓内常量、注册表只在敲字时打」是 ADR-0171 第一节
//    的设计前提，而这件事发生在主进程（main/mcpRegistry.ts 直接用 global fetch），
//    渲染层的测试根本看不见有没有出网。这里在**主进程**上记账。
// ② 慢的旧响应不许盖掉新结果。searchMcpRegistry 走 ipcRenderer.invoke，
//    AbortSignal 过不了 IPC——「取消上一次查询」根本不存在（ADR-0171 第二节的
//    已知限制），组件端按请求序号丢弃过期响应是唯一一道闸。要验它就必须能
//    控制两次响应谁先谁后，那只能在主进程里插桩。
// ③ 搜不动显示原因，不吞成"没有结果"。吞了的话用户会以为这台 server 不存在。
//
// 打桩只打 registry.modelcontextprotocol.io 这一个 host，其余请求原样放行——
// 顺带保证这条用例不真的出网（注册表是第三方服务，CI 上打它等于给别人添堵，
// 而且它挂了不该让本仓红）。

import { expect, test } from "@playwright/test";

import { expectNoRendererErrors, launchOtto, openSettings, type Otto } from "./harness.js";

const HOST = "registry.modelcontextprotocol.io";

/** 在主进程里换掉 global fetch：只接管注册表，别的原样走。
    返回之后可以用 registryHits() 读打了几次网 */
async function stubRegistry(otto: Otto): Promise<void> {
  await otto.app.evaluate(async (_electron, host: string) => {
    const g = globalThis as unknown as {
      fetch: typeof fetch;
      __ottoRegistryHits?: string[];
      __ottoRegistryFail?: boolean;
      __ottoRealFetch?: typeof fetch;
    };
    g.__ottoRegistryHits = [];
    g.__ottoRegistryFail = false;
    g.__ottoRealFetch = g.fetch;
    const real = g.fetch;
    g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes(host)) return real(input as never, init);
      g.__ottoRegistryHits!.push(url);
      const q = new URL(url).searchParams.get("search") ?? "";

      // 「搜不动」那条：HTTP 503，主进程会把它抛成 Error。
      // 开关独立于查询词——搜索框同时过滤精选层，用特殊词触发的话就没法验
      // 「长尾挂了精选还在」，而那正是分两层要换来的东西（ADR-0171 第一节）
      if (g.__ottoRegistryFail) {
        return new Response("upstream is down", { status: 503 });
      }

      // 「慢的旧响应」那条：慢查询压后 3 秒回，快查询立刻回
      const body = {
        servers: [
          {
            server: {
              name: `com.example/${q}`,
              title: `${q} 的服务`,
              description: `${q} 的描述`,
              version: "1.0.0",
              remotes: [{ type: "streamable-http", url: `https://${q}.example/mcp` }],
            },
            _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
          },
        ],
      };
      if (q.includes("slow")) await new Promise((r) => setTimeout(r, 3_000));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }, HOST);
}

async function registryHits(otto: Otto): Promise<string[]> {
  return otto.app.evaluate(() => {
    const g = globalThis as unknown as { __ottoRegistryHits?: string[] };
    return g.__ottoRegistryHits ?? [];
  });
}

/** 让注册表从此回 503 */
async function breakRegistry(otto: Otto): Promise<void> {
  await otto.app.evaluate(() => {
    (globalThis as unknown as { __ottoRegistryFail?: boolean }).__ottoRegistryFail = true;
  });
}

test("首屏是仓内精选层，一次网都不打", async () => {
  const otto = await launchOtto();
  try {
    await stubRegistry(otto);
    await openSettings(otto.win, "连接器");

    // 精选层立刻在（零网络，不等任何请求）
    await expect(otto.win.getByRole("button", { name: "添加 Supabase" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(otto.win.getByText("已核验").first()).toBeVisible();
    // 分隔线以下那一段属于长尾层，没搜就不该出现
    await expect(otto.win.getByText("以下来自公开注册表，未经核验")).toHaveCount(0);

    expect(await registryHits(otto), "首屏不该打注册表").toEqual([]);
    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("敲字才打网，长尾结果画出来并标未核验", async () => {
  const otto = await launchOtto();
  try {
    await stubRegistry(otto);
    await openSettings(otto.win, "连接器");
    await otto.win.getByRole("button", { name: "添加 Supabase" }).waitFor({ timeout: 15_000 });

    await otto.win.getByLabel("搜索连接器").fill("widgets");

    await expect(otto.win.getByText("以下来自公开注册表，未经核验")).toBeVisible({
      timeout: 15_000,
    });
    await expect(otto.win.getByRole("button", { name: "添加 widgets 的服务" })).toBeVisible();
    await expect(otto.win.getByText("未核验").first()).toBeVisible();

    const hits = await registryHits(otto);
    expect(hits.length, "敲字之后才该打网").toBeGreaterThan(0);
    expect(hits.at(-1)).toContain("search=widgets");
    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("慢的旧响应不许盖掉新结果——AbortSignal 过不了 IPC，序号判断是唯一一道闸", async () => {
  const otto = await launchOtto();
  try {
    await stubRegistry(otto);
    await openSettings(otto.win, "连接器");
    await otto.win.getByRole("button", { name: "添加 Supabase" }).waitFor({ timeout: 15_000 });

    const box = otto.win.getByLabel("搜索连接器");
    // 先搜慢的，等 debounce 过去、请求确实发出去了
    await box.fill("slowone");
    await expect
      .poll(async () => (await registryHits(otto)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);

    // 慢的还在路上就改搜快的
    await box.fill("fastone");
    await expect(otto.win.getByRole("button", { name: "添加 fastone 的服务" })).toBeVisible({
      timeout: 15_000,
    });

    // 慢的那条这时候才回来。它必须被丢掉，而不是盖掉屏幕上的 fastone
    await otto.win.waitForTimeout(4_000);
    await expect(
      otto.win.getByRole("button", { name: "添加 slowone 的服务" }),
      "旧查询的响应后到，盖掉了新结果"
    ).toHaveCount(0);
    await expect(otto.win.getByRole("button", { name: "添加 fastone 的服务" })).toBeVisible();
    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});

test("注册表搜不动就说原因，不吞成「没有结果」", async () => {
  const otto = await launchOtto();
  try {
    await stubRegistry(otto);
    await openSettings(otto.win, "连接器");
    await otto.win.getByRole("button", { name: "添加 Supabase" }).waitFor({ timeout: 15_000 });

    await breakRegistry(otto);
    // 搜一个精选层也命中的词：注册表死了，仓内那半边必须照常
    await otto.win.getByLabel("搜索连接器").fill("git");

    await expect(otto.win.getByText(/注册表搜不动/)).toBeVisible({ timeout: 15_000 });
    await expect(otto.win.getByText(/503/)).toBeVisible();
    // 分两层要换来的就是这个：长尾挂了，精选层照常可用（ADR-0171 第一节）
    await expect(otto.win.getByRole("button", { name: "添加 GitHub" })).toBeVisible();
    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
  }
});
