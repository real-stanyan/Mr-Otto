import { describe, expect, it } from "vitest";
import { decodeAppCard, encodeAppCard, type AppShareCard } from "../../src/shared/appCard.js";
import type { AppRow } from "../../src/shared/apps.js";
import {
  createRateGate, decodeRoomInvite, encodeRoomInvite, familyOf, jsonBytes, myAppForHost, roomEntryOf, roomInvitePreview,
  roomKeyOk, roomMemberOf, roomRowOf, roomSetResultOf, roomSysTopic, roomTopic,
} from "../../src/shared/appRoom.js";

const U1 = "2819d0bb-933b-499d-be44-2bb51b5a8391";
const APP = "0ffc3e43-153d-4a2b-a4e6-9e6ddcecee7b";
const ROOM = "11111111-2222-4333-8444-555555555555";
const card: AppShareCard = { appId: APP, version: 2, name: "五子棋", icon: "⚫", slug: "gomoku", description: "", from: { uid: U1, name: "Stan" } };
const app = (o: Partial<AppRow>): AppRow => ({ id: APP, workspaceId: "w", ownerUid: U1, slug: "gomoku", name: "五子棋", icon: "⚫", description: "", currentVersion: 1, createdByAgent: "a_x", updatedTs: 0, ...o });

describe("appRoom", () => {
  it("邀请信封：应用卡多一格 room；老解码器仍当应用卡认", () => {
    const body = encodeRoomInvite(card, { id: ROOM, title: "第 3 局" });
    expect(decodeRoomInvite(body)).toEqual({ card, room: { id: ROOM, title: "第 3 局" } });
    expect(decodeAppCard(body)).toEqual(card); // 老手机 / 老 runtime 的路
    expect(decodeRoomInvite(encodeAppCard(card))).toBeNull(); // 普通应用卡不是邀请
    expect(decodeRoomInvite(body.replace(ROOM, "nope"))).toBeNull();
    expect(roomInvitePreview(card)).toBe("[邀请] ⚫ 五子棋");
  });
  it("行解析：形状不对回 null", () => {
    expect(roomRowOf({ id: ROOM, host_uid: U1, host_app_id: APP, host_version: 2, family_id: APP, title: "局", closed: false, updated_at: "2026-10-05T00:00:00Z" }))
      .toEqual({ id: ROOM, hostUid: U1, hostAppId: APP, hostVersion: 2, familyId: APP, title: "局", closed: false, updatedTs: Date.parse("2026-10-05T00:00:00Z") });
    expect(roomRowOf({ id: ROOM })).toBeNull();
    expect(roomMemberOf({ uid: U1, status: "joined" })).toEqual({ uid: U1, status: "joined" });
    expect(roomMemberOf({ uid: U1, status: "boss" })).toBeNull();
    expect(roomEntryOf({ key: "board", value: { x: 1 }, rev: "3", updated_by: U1 })).toEqual({ key: "board", value: { x: 1 }, rev: 3, by: U1 });
    expect(roomSetResultOf({ ok: true, rev: 2 })).toEqual({ ok: true, rev: 2 });
    expect(roomSetResultOf({ ok: false, rev: 1, value: { x: 1 } })).toEqual({ ok: false, rev: 1, value: { x: 1 } });
    expect(roomSetResultOf("nope")).toBeNull();
  });
  it("一家子：副本的源 / 原版自己；找我名下对应房主应用的那一份", () => {
    expect(familyOf(app({}))).toBe(APP);
    const mine = app({ id: "c0000000-0000-4000-8000-000000000000", createdByAgent: `share:${APP}` });
    expect(familyOf(mine)).toBe(APP);
    expect(myAppForHost([mine], APP)).toBe(mine);
    expect(myAppForHost([app({})], APP)?.id).toBe(APP);
    expect(myAppForHost([], APP)).toBeNull();
  });
  it("频道名、键、字节数、速率闸", () => {
    expect(roomTopic(ROOM)).toBe(`room:${ROOM}`);
    expect(roomSysTopic(ROOM)).toBe(`room-sys:${ROOM}`);
    expect(roomKeyOk("a")).toBe(true);
    expect(roomKeyOk("")).toBe(false);
    expect(roomKeyOk("x".repeat(201))).toBe(false);
    expect(jsonBytes({ a: "中" })).toBe(new TextEncoder().encode(JSON.stringify({ a: "中" })).length);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonBytes(cyclic)).toBe(Infinity);
    let t = 0;
    const gate = createRateGate(2, () => t);
    expect([gate(), gate(), gate()]).toEqual([true, true, false]);
    t = 1001;
    expect(gate()).toBe(true);
  });
});
