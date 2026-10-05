// migration 0067（#1675）的形状钉子：本仓没有本地 Postgres，真验收在生产跑 supabase/checks/0067_*.sql；这里钉住不能漏的几处
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0067_app_rooms.sql", import.meta.url), "utf8");

describe("0067 app rooms", () => {
  it("四张表都开 RLS", () => {
    for (const t of ["app_rooms", "app_room_members", "app_room_data", "app_room_pings"]) {
      expect(sql).toContain(`create table if not exists public.${t}`);
      expect(sql).toContain(`alter table public.${t} enable row level security`);
    }
  });
  it("写只走 RPC：没有给 authenticated 的 insert / update / delete 策略（broadcast 的 realtime.messages 除外）", () => {
    const own = sql.split("\n").filter((l) => /create policy/.test(l) && !/realtime\.messages/.test(l)).join("\n");
    expect(own).not.toMatch(/for (insert|update|delete|all) to authenticated/);
  });
  it("七个 RPC 都是 security definer、都 grant 给 authenticated", () => {
    for (const f of ["app_room_create", "app_room_invite", "app_room_join", "app_room_leave", "app_room_set", "app_room_remove", "app_room_ping"]) {
      expect(sql).toMatch(new RegExp(`create or replace function public\\.${f}\\([^)]*\\)[\\s\\S]*?security definer`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${f}\\(`));
    }
  });
  it("跑房主那一版：app_versions 与 otto-apps 桶各一条按房间成员放行的 select", () => {
    expect(sql).toContain("create policy app_versions_select_room on public.app_versions for select to authenticated");
    expect(sql).toContain(`create policy "otto_apps_select_room" on storage.objects for select to authenticated`);
  });
  it("broadcast 私有频道按成员放行；变更推送进 publication", () => {
    expect(sql).toContain("on realtime.messages for select to authenticated");
    expect(sql).toContain("on realtime.messages for insert to authenticated");
    expect(sql).toMatch(/array\['app_room_data'[^\]]*\][\s\S]*alter publication supabase_realtime add table/);
  });
  it("限额与 if_rev 在 RPC 里判", () => {
    for (const s of [">= 8", ">= 50", ">= 500", "65536", "interval '10 seconds'", ">= 60", "p_if_rev"]) expect(sql).toContain(s);
  });
});
