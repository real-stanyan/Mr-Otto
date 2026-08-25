// issue #438 的端到端守卫：句中的 `$skill` 到底注没注进上下文。
//
// 为什么单测不够：这条 bug 的病灶不在任何一个函数里，而在**两个模块的判定不一致** ——
// ottoDirectives 的 parse 在哪都画 chip，App.tsx 的 submit 只认行首。单测能钉住两头
// 各自的行为，钉不住「用户看到 chip 亮着、模型却什么也没收到」这件事本身。
// 这里从真输入框打字一路验到假模型收到的请求体：skill 正文进没进 messages，
// 是这条链路唯一说了算的证据。

import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectNoRendererErrors, launchOtto, startSession } from "./harness.js";
import { fakeModelEnv, startFakeModel, type FakeRequest } from "./fakeModel.js";

/** skill 正文里放一句只可能来自注入的话 —— 在请求体里搜它，比搜 skill 名可靠：
    名字会因为用户自己打了 `$apple-design` 而出现在 user 消息里，正文不会 */
const MARKER = "圆角要连续曲率，别用普通圆角。";

function bodyOf(req: FakeRequest): string {
  return req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
}

test("#438 句中的 $skill 也注入：「用$apple-design …」发出去时 skill 正文已经在上下文里", async () => {
  const fake = await startFakeModel(() => ({ content: "好的。" }));
  const otto = await launchOtto({
    skills: [{ name: "apple-design", description: "Apple 风格的界面设计", body: MARKER }],
    env: fakeModelEnv(fake),
  });
  const ws = mkdtempSync(join(tmpdir(), "otto-ws-"));
  try {
    const { win } = otto;
    await startSession(otto, ws, "开个会话");
    await expect.poll(() => fake.requests.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const before = fake.requests.length;

    // 病根那句：`$` 前面有个「用」。旧代码在这里整条走的是纯文本路
    const composer = win.getByRole("textbox", { name: /输入消息/ });
    await composer.fill("用$apple-design 重新设计右边的布局");
    await composer.press("Enter");

    await expect.poll(() => fake.requests.length, { timeout: 20_000 }).toBeGreaterThan(before);
    const req = fake.requests[fake.requests.length - 1]!;
    expect(bodyOf(req), "skill 正文没进上下文 = 句中的 $skill 又没生效").toContain(MARKER);

    // 正文那头：token 被摘掉，别的字一个不删 —— 气泡上是「用 重新设计右边的布局」
    await expect(win.getByText("用 重新设计右边的布局", { exact: true })).toBeVisible();

    expectNoRendererErrors(otto);
  } finally {
    await otto.close();
    await fake.close();
  }
});
