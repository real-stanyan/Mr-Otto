// accountScope —— 本机数据按登录账号分抽屉（issue #749，ADR-0186）。
//
// 这里钉的是四件事：抽屉选得对、换号判得准、存量搬得安全、以及**未登录那一格
// 绝不会盖掉真抽屉**（后者是这套设计里唯一会丢数据的失败模式）。

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  ACCOUNTS_DIR,
  SIGNED_OUT_DIR,
  WHO_FILE,
  accountConfigDir,
  accountDataDir,
  accountDirName,
  adoptLegacyData,
  needsRelaunch,
  writeWho,
  LEGACY_CONFIG_ENTRIES,
  LEGACY_USER_DATA_ENTRIES,
  type AdoptFs,
} from "../../src/main/accountScope.js";
import { tempDir } from "../helpers/tempDir.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const UID_A = "11111111-1111-1111-1111-111111111111";
const UID_B = "22222222-2222-2222-2222-222222222222";

describe("accountDirName", () => {
  it("同一个 uid 恒得同一个抽屉名（不然重启就换一间，数据等于丢了）", () => {
    expect(accountDirName(UID_A)).toBe(accountDirName(UID_A));
  });

  it("不同 uid 不同抽屉 —— 这条不成立整个隔离就是假的", () => {
    expect(accountDirName(UID_A)).not.toBe(accountDirName(UID_B));
  });

  it("抽屉名是 16 位十六进制：拼进文件系统路径，字符集和长度都得可控", () => {
    expect(accountDirName(UID_A)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("没有登录记录 → _signed-out 那一格；下划线开头，和真抽屉永远撞不上", () => {
    expect(accountDirName(null)).toBe(SIGNED_OUT_DIR);
    expect(SIGNED_OUT_DIR).not.toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("抽屉路径", () => {
  it("userData 下多一层 accounts/<抽屉>", () => {
    expect(accountDataDir("/data", UID_A)).toBe(join("/data", ACCOUNTS_DIR, accountDirName(UID_A)));
  });

  it("配置目录先过 configDir（`.otter` 的改名仍发生在外层），再进 accounts/", () => {
    const fs = { exists: () => false, rename: () => {} };
    expect(accountConfigDir("/home/u", UID_A, fs)).toBe(
      join("/home/u", ".mr-otto", ACCOUNTS_DIR, accountDirName(UID_A))
    );
  });

  it("两个账号的抽屉互不包含 —— 隔离不是靠前缀，是靠兄弟目录", () => {
    const a = accountDataDir("/data", UID_A);
    const b = accountDataDir("/data", UID_B);
    expect(a.startsWith(b)).toBe(false);
    expect(b.startsWith(a)).toBe(false);
  });
});

describe("needsRelaunch", () => {
  it("换了账号 → 要重启（抽屉在装配时钉死，只能靠重启换）", () => {
    expect(needsRelaunch(UID_A, UID_B)).toBe(true);
  });

  it("还是同一个人 → 不重启（冷启动 restore 走的就是这一支，用户感知不到）", () => {
    expect(needsRelaunch(UID_A, UID_A)).toBe(false);
  });

  it("从「没登录记录」到登录 → 要重启（_signed-out 那一格换成他自己的）", () => {
    expect(needsRelaunch(null, UID_A)).toBe(true);
  });

  it("登出不重启：进门闸自己会挡，同号登出再登入不必空转一趟", () => {
    expect(needsRelaunch(UID_A, null)).toBe(false);
    expect(needsRelaunch(null, null)).toBe(false);
  });
});

/** 内存假 fs：只记录「有什么」和「谁搬去了哪」 */
function fakeFs(existing: string[]): { fs: AdoptFs; moves: [string, string][]; has: Set<string> } {
  const has = new Set(existing);
  const moves: [string, string][] = [];
  return {
    has,
    moves,
    fs: {
      exists: (p) => has.has(p),
      rename: (a, b) => {
        moves.push([a, b]);
        has.delete(a);
        has.add(b);
      },
    },
  };
}

describe("adoptLegacyData", () => {
  it("散在根下的存量整体搬进抽屉（「存量归给当前登录的账号」，issue #749）", () => {
    const { fs, moves } = fakeFs(["/d/sessions.db", "/d/keys.json"]);
    const moved = adoptLegacyData("/d", "/d/accounts/aa", ["sessions.db", "keys.json"], fs);
    expect(moved).toEqual(["sessions.db", "keys.json"]);
    expect(moves).toEqual([
      ["/d/sessions.db", "/d/accounts/aa/sessions.db"],
      ["/d/keys.json", "/d/accounts/aa/keys.json"],
    ]);
  });

  it("目标已存在就不搬 —— 这条是唯一挡住「空壳盖掉真数据」的东西", () => {
    const { fs, moves } = fakeFs(["/d/sessions.db", "/d/accounts/aa/sessions.db"]);
    expect(adoptLegacyData("/d", "/d/accounts/aa", ["sessions.db"], fs)).toEqual([]);
    expect(moves).toEqual([]);
  });

  it("源不存在 = 没什么可搬，不是故障", () => {
    const { fs } = fakeFs([]);
    expect(adoptLegacyData("/d", "/d/accounts/aa", ["sessions.db"], fs)).toEqual([]);
  });

  it("单条搬不动（权限/跨设备）吞掉，继续搬下一条 —— 不该因此拦着启动", () => {
    const has = new Set(["/d/sessions.db", "/d/keys.json"]);
    const fs: AdoptFs = {
      exists: (p) => has.has(p),
      rename: (a, b) => {
        if (a.endsWith("sessions.db")) throw new Error("EXDEV");
        has.delete(a);
        has.add(b);
      },
    };
    expect(adoptLegacyData("/d", "/d/accounts/aa", ["sessions.db", "keys.json"], fs)).toEqual([
      "keys.json",
    ]);
  });

  it("sqlite 的 WAL 三兄弟一起搬 —— 只搬 .db 会把未 checkpoint 的事件留在原地", () => {
    for (const f of ["sessions.db", "sessions.db-wal", "sessions.db-shm"]) {
      expect(LEGACY_USER_DATA_ENTRIES).toContain(f);
    }
  });

  it("auth.json 不在搬家名单里 —— 它是 uid 的来源，必须留在 userData 根", () => {
    expect(LEGACY_USER_DATA_ENTRIES as readonly string[]).not.toContain("auth.json");
  });

  it("名单不含 accounts 自己 —— 否则抽屉会被搬进它自己里面", () => {
    expect(LEGACY_USER_DATA_ENTRIES as readonly string[]).not.toContain(ACCOUNTS_DIR);
    expect(LEGACY_CONFIG_ENTRIES as readonly string[]).not.toContain(ACCOUNTS_DIR);
  });

  it("凭据类的三样都在名单里：keys.json / mcp-auth.json / mcp.json（#749 的实际泄漏面）", () => {
    expect(LEGACY_USER_DATA_ENTRIES as readonly string[]).toContain("keys.json");
    expect(LEGACY_CONFIG_ENTRIES as readonly string[]).toContain("mcp-auth.json");
    expect(LEGACY_CONFIG_ENTRIES as readonly string[]).toContain("mcp.json");
  });

  it("真盘上跑一遍：文件搬走了、原处没了", () => {
    const dir = tempDir("adopt");
    mkdirSync(join(dir, "accounts", "aa"), { recursive: true });
    writeFileSync(join(dir, "keys.json"), "{}");
    adoptLegacyData(dir, join(dir, "accounts", "aa"), ["keys.json"]);
    expect(existsSync(join(dir, "keys.json"))).toBe(false);
    expect(existsSync(join(dir, "accounts", "aa", "keys.json"))).toBe(true);
  });
});

describe("writeWho", () => {
  it("抽屉里放张名片：目录名是哈希，人得能认出哪间是自己的", () => {
    const dir = join(tempDir("who"), "aa");
    writeWho(dir, { uid: UID_A, email: "a@example.com" });
    const text = readFileSync(join(dir, WHO_FILE), "utf8");
    expect(text).toContain("a@example.com");
    expect(text).toContain(UID_A);
  });

  it("写不出来不算错 —— 名片是给人看的便利，不是正确性的一环", () => {
    expect(() => writeWho("/proc/nope/nowhere", { uid: null, email: "" })).not.toThrow();
  });
});
