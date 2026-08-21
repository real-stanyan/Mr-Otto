import { describe, expect, it } from "vitest";

import {
  blankRow,
  hasStrayMaskedValue,
  mcpConfigsEqual,
  mcpDisplayStatus,
  mcpServerIdError,
  recordFromRows,
  restoredValueOnKeyUndo,
  rowsFromRecord,
  shouldClearValueOnKeyRename,
  splitArgs,
  type KeyValueRow,
} from "../../src/renderer/src/lib/mcpForm.js";
import type { McpHttpConfig, McpStdioConfig } from "../../src/shared/mcp.js";

function stdio(overrides: Partial<McpStdioConfig> = {}): McpStdioConfig {
  return {
    kind: "stdio",
    command: "npx",
    args: [],
    env: {},
    enabled: true,
    ...overrides,
  };
}

function http(overrides: Partial<McpHttpConfig> = {}): McpHttpConfig {
  return {
    kind: "http",
    url: "https://example.com/mcp",
    headers: {},
    enabled: true,
    ...overrides,
  };
}

describe("mcpDisplayStatus", () => {
  it("关掉的 server 永远显示 disabled,不管后端记的是哪一档 status", () => {
    expect(mcpDisplayStatus(stdio({ enabled: false }), "connecting")).toBe("disabled");
    expect(mcpDisplayStatus(stdio({ enabled: false }), "failed")).toBe("disabled");
    expect(mcpDisplayStatus(http({ enabled: false }), "connected")).toBe("disabled");
  });

  it("开着的 server 原样透传后端的 status", () => {
    expect(mcpDisplayStatus(stdio(), "connecting")).toBe("connecting");
    expect(mcpDisplayStatus(stdio(), "connected")).toBe("connected");
    expect(mcpDisplayStatus(stdio(), "needs-auth")).toBe("needs-auth");
    expect(mcpDisplayStatus(stdio(), "failed")).toBe("failed");
  });
});

describe("rowsFromRecord / recordFromRows", () => {
  it("往返：Record 转行再转回去，内容不变", () => {
    const record = { DEEPSEEK_API_KEY: "sk-31cf5*****828c", DEBUG: "true" };
    const rows = rowsFromRecord(record);
    expect(rows).toHaveLength(2);
    expect(recordFromRows(rows)).toEqual(record);
  });

  it("每一行的 rowId 互不相同——改键名不该让这一行被当成新行", () => {
    const rows = rowsFromRecord({ A: "1", B: "2" });
    const ids = new Set(rows.map((r) => r.rowId));
    expect(ids.size).toBe(rows.length);
  });

  it("rowsFromRecord 给每一行记下 originalKey，与 key 起初相同", () => {
    const rows = rowsFromRecord({ A: "1" });
    expect(rows[0]?.originalKey).toBe("A");
    expect(rows[0]?.key).toBe("A");
  });

  it("键名为空的行提交时整行丢弃", () => {
    const rows: KeyValueRow[] = [
      { rowId: "1", originalKey: null, key: "REAL_KEY", value: "v" },
      { rowId: "2", originalKey: null, key: "", value: "还没打完键名" },
      { rowId: "3", originalKey: null, key: "   ", value: "只有空白也算空" },
    ];
    expect(recordFromRows(rows)).toEqual({ REAL_KEY: "v" });
  });

  it("同名键撞了，后写的赢", () => {
    const rows: KeyValueRow[] = [
      { rowId: "1", originalKey: null, key: "DUP", value: "old" },
      { rowId: "2", originalKey: null, key: "DUP", value: "new" },
    ];
    expect(recordFromRows(rows)).toEqual({ DUP: "new" });
  });

  it("blankRow 起手是空键空值、originalKey 为 null，且每次调用 id 不同", () => {
    const a = blankRow();
    const b = blankRow();
    expect(a.key).toBe("");
    expect(a.value).toBe("");
    expect(a.originalKey).toBeNull();
    expect(a.rowId).not.toBe(b.rowId);
  });

  it("键被用户实际改过（或新建的行）——两端空白照常裁掉", () => {
    const edited: KeyValueRow = { rowId: "1", originalKey: "OLD", key: "  SPACED  ", value: "v" };
    const fresh: KeyValueRow = { rowId: "2", originalKey: null, key: "  NEW  ", value: "v2" };
    expect(recordFromRows([edited, fresh])).toEqual({ SPACED: "v", NEW: "v2" });
  });

  // Critical review finding：磁盘上键名带首尾空白、用户完全没碰这一行，
  // 第一次保存不该把它当成"改名"——那会让 mergeMaskedCreds 按（裁剪后的）
  // 新键名去磁盘上找旧值，找不到，就把遮罩字符串原样当真凭据写盘。
  it("没碰过键名的行，即便原键名带首尾空白，提交时原样保留、不裁剪", () => {
    const untouched: KeyValueRow = {
      rowId: "1",
      originalKey: " GITHUB_TOKEN",
      key: " GITHUB_TOKEN",
      value: "ghp_ABCD*****MNOP",
    };
    expect(recordFromRows([untouched])).toEqual({ " GITHUB_TOKEN": "ghp_ABCD*****MNOP" });
  });

  it("端到端：rowsFromRecord 直接加载的行，未经任何编辑就提交，键名与原 Record 一字不差", () => {
    const record = { " GITHUB_TOKEN": "ghp_ABCD*****MNOP" };
    const rows = rowsFromRecord(record);
    expect(recordFromRows(rows)).toEqual(record);
  });
});

describe("mcpServerIdError", () => {
  it("空名字被拒", () => {
    expect(mcpServerIdError("", [])).toMatch(/起个名字/);
    expect(mcpServerIdError("   ", [])).toMatch(/起个名字/);
  });

  it("撞了已有的 id 被拒", () => {
    expect(mcpServerIdError("github", ["github", "fs"])).toMatch(/已经有一台/);
  });

  it("合法的新名字通过", () => {
    expect(mcpServerIdError("github", ["fs"])).toBeNull();
  });
});

describe("mcpConfigsEqual", () => {
  it("同一份 stdio 配置视为相等,即便 env 键序不同", () => {
    const a = stdio({ env: { A: "1", B: "2" } });
    const b = stdio({ env: { B: "2", A: "1" } });
    expect(mcpConfigsEqual(a, b)).toBe(true);
  });

  it("kind 不同直接判不等", () => {
    expect(mcpConfigsEqual(stdio(), http())).toBe(false);
  });

  it("command / args / enabled / env 任一项不同就判不等", () => {
    expect(mcpConfigsEqual(stdio(), stdio({ command: "other" }))).toBe(false);
    expect(mcpConfigsEqual(stdio({ args: ["a"] }), stdio({ args: ["b"] }))).toBe(false);
    expect(mcpConfigsEqual(stdio(), stdio({ enabled: false }))).toBe(false);
    expect(mcpConfigsEqual(stdio({ env: { A: "1" } }), stdio({ env: { A: "2" } }))).toBe(false);
  });

  it("http 配置比较 url / headers / enabled", () => {
    expect(mcpConfigsEqual(http(), http({ url: "https://other" }))).toBe(false);
    expect(mcpConfigsEqual(http({ headers: { X: "1" } }), http({ headers: { X: "1" } }))).toBe(true);
  });
});

// Critical review finding：改键名不碰值 = 把遮罩当真凭据存盘（maskKey 幂等，
// 界面上看不出来）。这两组函数是挡住这条路的判据本体。
describe("shouldClearValueOnKeyRename", () => {
  const baseline = { GITHUB_TOKEN: "ghp_ABCD*****MNOP" };

  it("值还是旧键名对应的原始遮罩值——判定为需要清空", () => {
    expect(shouldClearValueOnKeyRename("GITHUB_TOKEN", "ghp_ABCD*****MNOP", baseline)).toBe(true);
  });

  it("值已经被用户改过（不再等于原遮罩）——不需要清空", () => {
    expect(shouldClearValueOnKeyRename("GITHUB_TOKEN", "ghp_new_real_value", baseline)).toBe(false);
  });

  it("oldKey 是空字符串（新建的行改名）——不需要清空，没有原值可言", () => {
    expect(shouldClearValueOnKeyRename("", "ghp_ABCD*****MNOP", baseline)).toBe(false);
  });

  it("oldKey 在 baseline 里压根不存在——不需要清空", () => {
    expect(shouldClearValueOnKeyRename("NOT_A_REAL_KEY", "ghp_ABCD*****MNOP", baseline)).toBe(false);
  });
});

describe("hasStrayMaskedValue", () => {
  const baseline = { GITHUB_TOKEN: "ghp_ABCD*****MNOP" };

  it("键名改了、值还留着旧键名的遮罩——命中", () => {
    const rows: KeyValueRow[] = [
      { rowId: "1", originalKey: "GITHUB_TOKEN", key: "GITHUB_PAT", value: "ghp_ABCD*****MNOP" },
    ];
    expect(hasStrayMaskedValue(rows, baseline)).toBe(true);
  });

  it("键名没变——不命中（未改的行本来就该保留原遮罩）", () => {
    const rows: KeyValueRow[] = [
      { rowId: "1", originalKey: "GITHUB_TOKEN", key: "GITHUB_TOKEN", value: "ghp_ABCD*****MNOP" },
    ];
    expect(hasStrayMaskedValue(rows, baseline)).toBe(false);
  });

  it("键名改了、值也真的换成了新值——不命中", () => {
    const rows: KeyValueRow[] = [
      { rowId: "1", originalKey: "GITHUB_TOKEN", key: "GITHUB_PAT", value: "ghp_brand_new_real_value" },
    ];
    expect(hasStrayMaskedValue(rows, baseline)).toBe(false);
  });

  it("全新的行，键名和值都是新的——不命中", () => {
    const rows: KeyValueRow[] = [{ rowId: "1", originalKey: null, key: "NEW_KEY", value: "new value" }];
    expect(hasStrayMaskedValue(rows, baseline)).toBe(false);
  });

  it("baseline 里有把凭据本来就是空字符串——不该让所有空值行都被判成 stray", () => {
    const b = { GITHUB_TOKEN: "ghp_ABCD*****MNOP", DEBUG_FLAG: "" };
    // 一个全新的、还没填值的空行——不该被挡
    const blank: KeyValueRow = { rowId: "1", originalKey: null, key: "NEW_VAR", value: "" };
    expect(hasStrayMaskedValue([blank], b)).toBe(false);
    // 改名清空之后的行（value === ""）——同样不该被挡
    const clearedByRename: KeyValueRow = {
      rowId: "2",
      originalKey: "GITHUB_TOKEN",
      key: "GITHUB_PAT",
      value: "",
    };
    expect(hasStrayMaskedValue([clearedByRename], b)).toBe(false);
  });

  it("端到端：改名清空生效之后，stray 判据不再命中（清空是主防线，这是兜底自检）", () => {
    const before: KeyValueRow = {
      rowId: "1",
      originalKey: "GITHUB_TOKEN",
      key: "GITHUB_TOKEN",
      value: "ghp_ABCD*****MNOP",
    };
    // 组件里改键名的 onChange 处理器会先判 shouldClearValueOnKeyRename 再决定清不清值
    const shouldClear = shouldClearValueOnKeyRename(before.key, before.value, baseline);
    expect(shouldClear).toBe(true);
    const after: KeyValueRow = { ...before, key: "GITHUB_PAT", value: shouldClear ? "" : before.value };
    expect(hasStrayMaskedValue([after], baseline)).toBe(false);
  });

  // N1 review finding：原判据只看"键名在不在 baseline 里"，漏掉了同名覆盖——
  // 把 A 的可见遮罩粘进**已经存在**的键 B 的值框，B 自己在 baseline 里查得到
  // （所以旧判据的 baseline[r.key] === undefined 不成立，放过了），但粘进来的
  // 值根本不是 B 自己的原始遮罩，而是 A 的——这跟"改名后值还留着旧遮罩"是
  // 同一种数据损坏，触发方式不同：值框里显示的就是普通明文，把 A 的遮罩粘到
  // B 里是操作上顺理成章的一步（比如"这两个变量我想填一样的 token"）
  it("键名没变，但值被粘成了另一把凭据的遮罩——命中（N1）", () => {
    const b = { GITHUB_TOKEN: "ghp_ABCD*****MNOP", GH_TOKEN: "sk-31cf5*****828c" };
    const pastedIntoExisting: KeyValueRow[] = [
      { rowId: "1", originalKey: "GH_TOKEN", key: "GH_TOKEN", value: "ghp_ABCD*****MNOP" },
    ];
    expect(hasStrayMaskedValue(pastedIntoExisting, b)).toBe(true);
  });

  it("两个键合法地存着同一份真凭据（两个遮罩碰巧相同）——不该被误判", () => {
    const shared = "ghp_ABCD*****MNOP";
    const b = { KEY_A: shared, KEY_B: shared };
    const rows: KeyValueRow[] = [
      { rowId: "1", originalKey: "KEY_A", key: "KEY_A", value: shared },
      { rowId: "2", originalKey: "KEY_B", key: "KEY_B", value: shared },
    ];
    expect(hasStrayMaskedValue(rows, b)).toBe(false);
  });
});

// M1 review finding：改名清空之后又把键名改回 originalKey（典型触发：打个
// 尾随空格再退格），值还是空的，但 renamedAndCleared 要求键名 !== originalKey、
// stray 显式排除空值——两道警示的判据缝隙里漏掉了这个状态，Save 照常可点，
// 一存就把真凭据覆盖成空字符串
describe("restoredValueOnKeyUndo", () => {
  const baseline = { GITHUB_TOKEN: "ghp_ABCD*****MNOP" };

  it("键名改回 originalKey、值是空的、baseline 里查得到——找回原遮罩", () => {
    expect(restoredValueOnKeyUndo("GITHUB_TOKEN", "GITHUB_TOKEN", "", baseline)).toBe(
      "ghp_ABCD*****MNOP"
    );
  });

  it("键名还没改回 originalKey——不该找回（还在改名途中）", () => {
    expect(restoredValueOnKeyUndo("GITHUB_TOKEN2", "GITHUB_TOKEN", "", baseline)).toBeNull();
  });

  it("值不是空的（用户已经填了新值）——不该覆盖用户刚打的东西", () => {
    expect(restoredValueOnKeyUndo("GITHUB_TOKEN", "GITHUB_TOKEN", "user typed this", baseline)).toBeNull();
  });

  it("originalKey 是 null（全新的行）——没有原值可找回", () => {
    expect(restoredValueOnKeyUndo("ANYTHING", null, "", baseline)).toBeNull();
  });

  it("baseline 里已经没有这个键了（比如同时被删除）——没有可找回的原值", () => {
    expect(restoredValueOnKeyUndo("GONE_KEY", "GONE_KEY", "", {})).toBeNull();
  });

  it("端到端：改名清空再改回去，跟组件里 onChange 的顺序一致", () => {
    const original: KeyValueRow = {
      rowId: "1",
      originalKey: "GITHUB_TOKEN",
      key: "GITHUB_TOKEN",
      value: "ghp_ABCD*****MNOP",
    };
    // 第一步：改名（打一个字符），值按 shouldClearValueOnKeyRename 被清空
    const renamedKey = "GITHUB_TOKEN2";
    const undo1 = restoredValueOnKeyUndo(renamedKey, original.originalKey, original.value, baseline);
    expect(undo1).toBeNull(); // 还没改回去，不该找回
    const clear = shouldClearValueOnKeyRename(original.key, original.value, baseline);
    const afterRename: KeyValueRow = { ...original, key: renamedKey, value: clear ? "" : original.value };
    expect(afterRename.value).toBe("");
    // 第二步：退格改回原键名——这时候该找回原值
    const undo2 = restoredValueOnKeyUndo(original.originalKey as string, afterRename.originalKey, afterRename.value, baseline);
    expect(undo2).toBe("ghp_ABCD*****MNOP");
    const afterUndo: KeyValueRow = {
      ...afterRename,
      key: original.originalKey as string,
      value: undo2 as string,
    };
    // 回到了跟最初一模一样的状态——包括"未改"判据会重新认出它
    expect(afterUndo).toEqual(original);
  });
});

describe("splitArgs", () => {
  it("按空白切分，过滤空段", () => {
    expect(splitArgs("-y  @modelcontextprotocol/server-filesystem  /Users/x")).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/Users/x",
    ]);
  });

  it("空字符串给出空数组", () => {
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("   ")).toEqual([]);
  });
});
