import { describe, expect, it } from "vitest";

import { humanizeError } from "../../src/renderer/src/lib/modelError.js";

describe("humanizeError —— 报错的人话版", () => {
  it("剥到服务商自己写的那句话就用它 —— 它比我们编的转述准", () => {
    const raw =
      'model API 429: {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}';
    expect(humanizeError(raw).text).toBe("余额不足或无可用资源包,请充值。");
    // 原文一并带回来：日志里存的是它，UI 要能给出"看原文"的入口
    expect(humanizeError(raw).raw).toBe(raw);
  });

  it("Electron 的 IPC 包装先剥掉 —— 远程方法名对读的人没有用", () => {
    const raw =
      'Error invoking remote method \'otter:sendMessage\': Error: model API 429: {"error":{"message":"该模型当前访问量过大，请您稍后再试"}}';
    expect(humanizeError(raw).text).toBe("该模型当前访问量过大，请您稍后再试");
  });

  it("Ollama 那种 error 是字符串的也认", () => {
    expect(humanizeError('model API 404: {"error":"model not found"}').text).toBe(
      "model not found",
    );
  });

  it("没有 message 就按状态码说个大概", () => {
    expect(humanizeError("model API 401: ").text).toBe("API key 无效或已过期");
    expect(humanizeError("model API 503: <html>502 Bad Gateway</html>").text).toBe(
      "服务商暂时不可用（过载或维护中）",
    );
  });

  it("状态码也不认识时，响应体原样带上 —— 那时候它是唯一的信息", () => {
    expect(humanizeError("model API 418: 我是茶壶").text).toBe("服务商返回 418：我是茶壶");
  });

  it("连不上这一类按字面量认（没有状态码可依）", () => {
    expect(humanizeError("TypeError: fetch failed").text).toBe(
      "连不上服务商（网络不通，或 baseUrl 填错了）",
    );
    expect(humanizeError("connect ECONNREFUSED 127.0.0.1:11434").text).toBe(
      "连接被拒（本机服务没起来？检查 Ollama / 自建 endpoint）",
    );
  });

  it("一层都剥不动就原样显示：不认识的东西不假装认识", () => {
    const raw = "工具 write_file 执行失败：路径不在工作区内";
    expect(humanizeError(raw)).toEqual({ text: raw, raw });
  });

  it("网关那条已经是人话（主进程就没裹壳），原样通过", () => {
    const raw = "赠额已用完，去设置里填自己的 key";
    expect(humanizeError(raw).text).toBe(raw);
  });
});

describe("humanizeError —— vision-bridge 的戳", () => {
  it("代读失败点名是哪一款看图模型 —— 不然读起来像用户正在用的模型 key 坏了", () => {
    const raw =
      'Error invoking remote method \'otter:sendMessage\': Error: vision-bridge(glm-4.6v-flash) model API 401: {"error":{"code":"401","message":"令牌已过期或验证不正确"}}';
    expect(humanizeError(raw).text).toBe(
      "看图模型 glm-4.6v-flash 代读失败：令牌已过期或验证不正确",
    );
    expect(humanizeError(raw).raw).toBe(raw);
  });
});
