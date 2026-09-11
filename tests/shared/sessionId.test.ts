import { describe, expect, it } from "vitest";
import { newSessionId } from "../../src/shared/sessionId.js";
import { SESSION_FOLDER_RE } from "../../src/shared/defaultWorkspace.js";

describe("newSessionId（搬进 shared，#1223）", () => {
  it("形状与 Default 子目录名的正则一致：s-<14 位>-<8 hex>", () => {
    const id = newSessionId();
    expect(id).toMatch(SESSION_FOLDER_RE);
  });
  it("随机段承重：连铸 200 个不重复", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
    expect(ids.size).toBe(200);
  });
});
