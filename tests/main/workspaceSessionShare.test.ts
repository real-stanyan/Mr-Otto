import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionEvent } from "../../src/session/events.js";
import type { PackInput, SessionPackage } from "../../src/shared/sessionPackage.js";
import { encodePackage } from "../../src/shared/sessionPackageCodec.js";
import type { ShareReceiveDeps } from "../../src/main/sessionShareReceive.js";
import {
  publishSessionToWorkspace,
  unpublishSession,
  importWorkspaceSession,
  type WorkspaceShareSendDeps,
} from "../../src/main/workspaceSessionShare.js";

// workspaceSessionShare —— 发布制会话编排测试（Task 9，ADR-0198 切片 3）。
// publish/unpublish/import 与 sessionShare.ts/sessionShareReceive.ts 同款套路：
// 依赖全注入，假 client/假 storage，不碰真 Supabase/SQLite。隐私闸（packSession）
// 本身已经在 shared/sessionPackage 的单测 + sessionShare.test.ts 里钉过闸的行为，
// 这里只断言「流程走到了 packSession」，不重测闸——deps.packSession 可以整个假掉。

let ts = 0;
function ev(e: { type: SessionEvent["type"] } & Record<string, unknown>): SessionEvent {
  return { seq: -1, sessionId: "src", ts: ++ts, ...e } as unknown as SessionEvent;
}

const SOURCE_EVENTS: SessionEvent[] = [
  ev({ type: "session_created", title: "源会话", workspace: "/Users/stan/secret" }),
  ev({ type: "user_message", content: "帮我看下 bug" }),
  ev({ type: "assistant_message", content: "我看看", model: "m" }),
];

function fakePkg(): SessionPackage {
  return {
    manifest: {
      kind: "otto.session-package",
      version: 1,
      exportedTs: 1000,
      message: "",
      source: { sessionId: "src", title: "发布标题", model: null },
      stripped: [],
      eventCount: SOURCE_EVENTS.length,
      attachments: [],
    },
    events: SOURCE_EVENTS,
    attachmentBytes: {},
  };
}

function sendDeps(overrides: Partial<WorkspaceShareSendDeps> = {}): WorkspaceShareSendDeps & {
  uploaded: Map<string, Uint8Array> | null;
  insertedRow: { workspaceId: string; publisherUid: string; pkgId: string; title: string } | null;
  packSessionCalls: number;
} {
  const state = {
    uploaded: null as Map<string, Uint8Array> | null,
    insertedRow: null as { workspaceId: string; publisherUid: string; pkgId: string; title: string } | null,
    packSessionCalls: 0,
  };
  return Object.assign(state, {
    myUid: async () => "sender-uid",
    loadEvents: () => SOURCE_EVENTS,
    readAttachment: () => new Uint8Array(),
    upload: async (files: ReadonlyMap<string, Uint8Array>) => {
      state.uploaded = new Map(files);
    },
    sendDm: async () => {
      throw new Error("publish 不该发 DM——用的是 insertSessionRow");
    },
    newPkgId: () => "pkg-1",
    now: () => 1000,
    client: () => ({ fake: "client" }) as unknown as SupabaseClient,
    insertSessionRow: async (
      _client: SupabaseClient,
      row: { workspaceId: string; publisherUid: string; pkgId: string; title: string },
    ) => {
      state.insertedRow = row;
      return { id: "row-1" };
    },
    packSession: (_input: PackInput): SessionPackage => {
      state.packSessionCalls++;
      return fakePkg();
    },
    ...overrides,
  });
}

describe("publishSessionToWorkspace（Task 9）", () => {
  it("全链路：load → packSession（假）→ upload（前缀 uid/pkgId）→ insertSessionRow，不发 DM", async () => {
    const deps = sendDeps();
    const r = await publishSessionToWorkspace(deps, "ws-1", "src", "发布标题");

    expect(r).toEqual({ ok: true, value: { rowId: "row-1", pkgId: "pkg-1" } });
    expect(deps.packSessionCalls).toBeGreaterThan(0);
    expect(deps.uploaded).not.toBeNull();
    expect(deps.uploaded!.size).toBeGreaterThan(0);
    for (const key of deps.uploaded!.keys()) {
      expect(key.startsWith("sender-uid/pkg-1/")).toBe(true);
    }
    expect(deps.insertedRow).toEqual({
      workspaceId: "ws-1",
      publisherUid: "sender-uid",
      pkgId: "pkg-1",
      title: "发布标题",
    });
  });

  it("未登录：不打包不上传，直接失败", async () => {
    const deps = sendDeps({ myUid: async () => null });
    const r = await publishSessionToWorkspace(deps, "ws-1", "src", "标题");
    expect(r).toEqual({ ok: false, message: "未登录" });
    expect(deps.uploaded).toBeNull();
    expect(deps.packSessionCalls).toBe(0);
  });

  it("会话为空：不打包不上传", async () => {
    const deps = sendDeps({ loadEvents: () => [] });
    const r = await publishSessionToWorkspace(deps, "ws-1", "src", "标题");
    expect(r.ok).toBe(false);
    expect(deps.uploaded).toBeNull();
    expect(deps.packSessionCalls).toBe(0);
  });

  it("insertSessionRow 失败：补偿删除刚上传的包，再把原始错误归一成 FriendsResult（审查 round 1）", async () => {
    // unpublishSession 够不到这个孤儿包——它需要一个从未存在过的 rowId 才能删，
    // 所以补偿删除必须在 publishSessionToWorkspace 自己的 catch 里做，不能指望调用方
    // 事后调 unpublishSession 清理（这条曾经是本文件一句错误的注释，见审查 round 1）
    let removedKeys: string[] | null = null;
    const client = {
      storage: {
        from: () => ({
          list: async () => ({
            data: [{ name: "manifest.json" }, { name: "events.jsonl" }],
            error: null,
          }),
          remove: async (keys: string[]) => {
            removedKeys = keys;
            return { error: null };
          },
        }),
      },
    } as unknown as SupabaseClient;
    const deps = sendDeps({
      client: () => client,
      insertSessionRow: async () => {
        throw new Error("rls");
      },
    });
    const r = await publishSessionToWorkspace(deps, "ws-1", "src", "标题");
    expect(r).toEqual({ ok: false, message: "rls" });
    expect(deps.uploaded).not.toBeNull(); // 已经上传过
    expect(removedKeys).toEqual(["sender-uid/pkg-1/manifest.json", "sender-uid/pkg-1/events.jsonl"]);
  });

  it("insertSessionRow 失败 + 补偿删除也失败：仍然报原始错误，不是补偿失败的错误", async () => {
    const client = {
      storage: {
        from: () => ({
          list: async () => {
            throw new Error("storage boom");
          },
          remove: async () => ({ error: null }),
        }),
      },
    } as unknown as SupabaseClient;
    const deps = sendDeps({
      client: () => client,
      insertSessionRow: async () => {
        throw new Error("rls");
      },
    });
    const r = await publishSessionToWorkspace(deps, "ws-1", "src", "标题");
    expect(r).toEqual({ ok: false, message: "rls" });
  });
});

describe("unpublishSession（Task 9）：删行 + deletePackage", () => {
  function fakeClient() {
    let deletedTable: string | null = null;
    let deletedRowId: string | null = null;
    let removedKeys: string[] | null = null;
    const client = {
      from: (table: string) => {
        deletedTable = table;
        return {
          delete: () => ({
            eq: async (_col: string, val: string) => {
              deletedRowId = val;
              return { data: null, error: null };
            },
          }),
        };
      },
      storage: {
        from: () => ({
          list: async () => ({
            data: [{ name: "manifest.json" }, { name: "events.jsonl" }],
            error: null,
          }),
          remove: async (keys: string[]) => {
            removedKeys = keys;
            return { error: null };
          },
        }),
      },
    } as unknown as SupabaseClient;
    return {
      client,
      getDeletedTable: () => deletedTable,
      getDeletedRowId: () => deletedRowId,
      getRemovedKeys: () => removedKeys,
    };
  }

  it("删 workspace_sessions 那一行，再删 Storage 里的包文件", async () => {
    const { client, getDeletedTable, getDeletedRowId, getRemovedKeys } = fakeClient();
    const r = await unpublishSession(client, "row-1", "pub-uid/pkg-1");
    expect(r).toEqual({ ok: true, value: null });
    expect(getDeletedTable()).toBe("workspace_sessions");
    expect(getDeletedRowId()).toBe("row-1");
    expect(getRemovedKeys()).toEqual(["pub-uid/pkg-1/manifest.json", "pub-uid/pkg-1/events.jsonl"]);
  });

  it("删行失败：归一成 FriendsResult，不抛，也不再往下删包", async () => {
    let removeCalled = false;
    const client = {
      from: () => ({
        delete: () => ({
          eq: async () => ({ data: null, error: { message: "rls", code: "42501" } }),
        }),
      }),
      storage: {
        from: () => ({
          list: async () => ({ data: [], error: null }),
          remove: async () => {
            removeCalled = true;
            return { error: null };
          },
        }),
      },
    } as unknown as SupabaseClient;
    const r = await unpublishSession(client, "row-1", "pub-uid/pkg-1");
    expect(r).toEqual({ ok: false, message: "rls" });
    expect(removeCalled).toBe(false);
  });

  it("行删成功但删包失败：仍然报 ok:true——行已经删了，撤回对用户来说已经生效（审查 round 1）", async () => {
    let deletedRowId: string | null = null;
    const client = {
      from: () => ({
        delete: () => ({
          eq: async (_col: string, val: string) => {
            deletedRowId = val;
            return { data: null, error: null };
          },
        }),
      }),
      storage: {
        from: () => ({
          list: async () => {
            throw new Error("storage boom");
          },
          remove: async () => ({ error: null }),
        }),
      },
    } as unknown as SupabaseClient;
    const r = await unpublishSession(client, "row-1", "pub-uid/pkg-1");
    expect(r).toEqual({ ok: true, value: null });
    expect(deletedRowId).toBe("row-1");
  });
});

describe("importWorkspaceSession（Task 9）：包路径来自行，不来自 DM 信封", () => {
  it("prefix = publisherUid/pkgId，其余走 importSharedSession 既有路径", async () => {
    let seenPrefix: string | null = null;
    const deps: ShareReceiveDeps = {
      download: async (prefix) => {
        seenPrefix = prefix;
        return encodePackage(fakePkg());
      },
      saveAttachment: () => ({ id: "att-1" }),
      append: () => {},
      newSessionId: () => "new-sess",
    };
    const r = await importWorkspaceSession(deps, "publisher-uid", "pkg-9", "/Users/me/project");
    expect(seenPrefix).toBe("publisher-uid/pkg-9");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sessionId).toBe("new-sess");
      expect(r.value.eventCount).toBe(SOURCE_EVENTS.length);
    }
  });

  it("包不存在（撤回了）：归一成既有的失效提示，不抛", async () => {
    const deps: ShareReceiveDeps = {
      download: async () => null,
      saveAttachment: () => ({ id: "x" }),
      append: () => {},
      newSessionId: () => "new-sess",
    };
    const r = await importWorkspaceSession(deps, "publisher-uid", "pkg-9", "/Users/me/project");
    expect(r).toEqual({ ok: false, message: "分享不存在或已被对方撤回" });
  });
});
