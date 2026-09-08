// 出图型号那三样纯逻辑（#1086）：日志投影 / 回落规则 / 人话名字。

import { describe, expect, it } from "vitest";
import {
  IMAGE_MODEL_LABELS, currentImageModel, imageModelLabel, pickImageModel,
} from "../../src/shared/imageModel.js";
import type { SessionEvent } from "../../src/session/events.js";

const ev = (seq: number, model: string): SessionEvent =>
  ({ seq, sessionId: "s", ts: seq, type: "image_model_changed", model, ignorable: true }) as SessionEvent;
const other = (seq: number): SessionEvent =>
  ({ seq, sessionId: "s", ts: seq, type: "model_changed", provider: "zhipu", model: "glm-5.3" }) as SessionEvent;

describe("currentImageModel", () => {
  it("最后一条胜出；一条都没有 = null（照旧走网关最便宜那款）", () => {
    expect(currentImageModel([])).toBeNull();
    expect(currentImageModel([other(1)])).toBeNull();
    expect(currentImageModel([ev(1, "a"), other(2), ev(3, "b")])).toBe("b");
  });

  it("换文字模型不动出图那一格 —— 两条事件分开的全部意义就在这里", () => {
    // 合成一条字段的话，每换一次文字模型都得把出图那格一起带上，否则「这一条里
    // 出图那格缺席」到底是「没变」还是「清空了」说不清；而换文字模型是每天做很多次
    // 的动作，出图型号一年也未必换一次
    expect(currentImageModel([ev(1, "seedream-4.5"), other(2), other(3)])).toBe("seedream-4.5");
  });
});

describe("pickImageModel", () => {
  const list = ["cheap", "mid", "pricey"];

  it("选过就用选的；没选过用最便宜那款（清单是从便宜到贵有序的）", () => {
    expect(pickImageModel(list, "pricey")).toBe("pricey");
    expect(pickImageModel(list, null)).toBe("cheap");
    expect(pickImageModel(list)).toBe("cheap");
  });

  it("选的那款网关下架了 → 回落最便宜那款，**不报错**", () => {
    // 同 visionModelFor / helperModelFor：网关下架一款不该让出图整个不通，
    // 而「你选的那款没了」这件事没有任何用户能据此行动的出路
    expect(pickImageModel(list, "gone")).toBe("cheap");
  });
});

describe("imageModelLabel", () => {
  it("认得的写人话名字", () => {
    expect(imageModelLabel("seedream-5-0-pro")).toBe("Seedream 5.0 Pro");
    expect(imageModelLabel("gemini-3.1-flash-image")).toBe("Nano Banana 2");
  });

  it("认不出的**原样回 id**，不猜也不美化", () => {
    // 网关上了新款而这张表还没跟上时，裸 id 至少是真的；编一个名字则是假的
    expect(imageModelLabel("some-new-image-model")).toBe("some-new-image-model");
  });

  it("表里每一行都是「id → 非空且不等于 id」—— 抄错一行的样子就是「名字没换」", () => {
    for (const [id, label] of Object.entries(IMAGE_MODEL_LABELS)) {
      expect(label.trim()).not.toBe("");
      expect(label).not.toBe(id);
    }
  });
});
