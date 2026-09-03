// tests/main/taskWorkspace.test.ts
import { describe, expect, it } from "vitest";
import { allocateSessionWorkspace } from "../../src/main/taskWorkspace.js";

const BUILTIN = "/docs/Mr Otto/Default";
const builtinInfo = { defaultWorkspace: BUILTIN, builtin: true, builtinWorkspace: BUILTIN };
const customInfo = { defaultWorkspace: "/me/work", builtin: false, builtinWorkspace: BUILTIN };

function deps() {
  const made: string[] = [];
  return { made, mint: () => "s-20260903111128-a1b2c3d4", mkdir: (abs: string) => made.push(abs) };
}

describe("allocateSessionWorkspace（#851）", () => {
  it("内置 Default：铸 id、子目录、mkdir 子目录", () => {
    const d = deps();
    const r = allocateSessionWorkspace(BUILTIN, builtinInfo, d);
    expect(r).toEqual({ workspace: `${BUILTIN}/s-20260903111128-a1b2c3d4`, sessionId: "s-20260903111128-a1b2c3d4" });
    expect(d.made).toEqual([`${BUILTIN}/s-20260903111128-a1b2c3d4`]);
  });
  it("自定义兜底：不分格，只 mkdir 本身，不铸 id", () => {
    const d = deps();
    const r = allocateSessionWorkspace("/me/work", customInfo, d);
    expect(r).toEqual({ workspace: "/me/work", sessionId: null });
    expect(d.made).toEqual(["/me/work"]);
  });
  it("别的路径：原样回、不 mkdir（别替渲染层传来的任意路径建目录）", () => {
    const d = deps();
    expect(allocateSessionWorkspace("/p/x", builtinInfo, d)).toEqual({ workspace: "/p/x", sessionId: null });
    expect(d.made).toEqual([]);
  });
  it("自定义兜底生效时递来内置 Default 路径也不分格（它此刻不是兜底）", () => {
    const d = deps();
    expect(allocateSessionWorkspace(BUILTIN, customInfo, d)).toEqual({ workspace: BUILTIN, sessionId: null });
    expect(d.made).toEqual([]);
  });
});
