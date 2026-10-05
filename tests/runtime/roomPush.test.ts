import { describe, expect, it } from "vitest";
import { createRoomPush, roomPingOf } from "../../services/runtime/src/roomPush.js";

const ROOM = "11111111-2222-4333-8444-555555555555";
const A = "2819d0bb-933b-499d-be44-2bb51b5a8391";
const B = "32c6716a-0000-4000-8000-000000000000";
const APP = "0ffc3e43-153d-4a2b-a4e6-9e6ddcecee7b";

describe("roomPush", () => {
  it("行解析：缺格 / 类型不对回 null", () => {
    expect(roomPingOf({ id: "7", room_id: ROOM, from_uid: A, text: "轮到你了" })).toEqual({ id: 7, roomId: ROOM, fromUid: A, text: "轮到你了" });
    expect(roomPingOf({ id: 7, room_id: ROOM })).toBeNull();
  });
  it("推给其他成员：标题「发的人·应用名」，正文 = text，目标 room；kind 走 friend 那个开关", async () => {
    const sent: unknown[] = [];
    const push = createRoomPush({
      notifier: { send: async (uid: string, kind: string, p: unknown) => { sent.push([uid, kind, p]); } } as never,
      nameOf: async () => "Stan",
      audience: async (room, except) => (room === ROOM && except === A ? { uids: [B], appName: "五子棋", hostAppId: APP } : null),
      log: () => {},
    });
    await push.onInsert({ id: 1, room_id: ROOM, from_uid: A, text: "轮到你了" });
    expect(sent).toEqual([[B, "friend", { title: "Stan·五子棋", body: "轮到你了", target: { kind: "room", roomId: ROOM, hostAppId: APP } }]]);
  });
  it("房间没了 / 没别人：不推不抛", async () => {
    const sent: unknown[] = [];
    const push = createRoomPush({ notifier: { send: async () => { sent.push(1); } } as never, nameOf: async () => "S", audience: async () => null, log: () => {} });
    await push.onInsert({ id: 1, room_id: ROOM, from_uid: A, text: "x" });
    expect(sent).toEqual([]);
  });
});
