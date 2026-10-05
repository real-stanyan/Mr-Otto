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
  it("broadcast 私有频道按成员放行", () => {
    expect(sql).toContain("on realtime.messages for select to authenticated");
    expect(sql).toContain("on realtime.messages for insert to authenticated");
  });
  it("publication 只放 app_room_pings：postgres_changes 的 DELETE 绕过 RLS，data / members 不能进", () => {
    expect(sql).toMatch(/foreach t in array array\['app_room_pings'\] loop[\s\S]*alter publication supabase_realtime add table/);
    expect(sql).not.toMatch(/array\[[^\]]*'app_room_(data|members)'[^\]]*\]/);
    expect(sql).not.toMatch(/alter publication supabase_realtime add table public\.app_room_(data|members)/);
  });
  it("变更改走触发器 + realtime.send 私有 broadcast，且发不出去不回滚写入", () => {
    for (const t of ["app_room_data", "app_room_members"]) {
      expect(sql).toMatch(new RegExp(`create trigger \\w+\\s+after insert or update or delete on public\\.${t}\\s+for each row execute function`));
    }
    expect(sql).toMatch(/realtime\.send\(\s*jsonb_build_object\('key'[\s\S]*?'change',\s*'room:' \|\| [\s\S]*?true\s*\)/);
    expect(sql).toMatch(/realtime\.send\(\s*jsonb_build_object\('uid'[\s\S]*?'members',\s*'room:' \|\| [\s\S]*?true\s*\)/);
    expect((sql.match(/exception when others then\s+null;/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("成员判据不带 uid 参数（只问 auth.uid()）", () => {
    expect(sql).toContain("function public.is_room_member(p_room uuid) returns boolean");
    expect(sql).toContain("function public.room_topic_member(p_topic text) returns boolean");
    expect(sql).not.toMatch(/is_room_member\([^)]*,/);
  });
  it("并发：invite / set / ping 先锁房间行再判上限与限速", () => {
    expect((sql.match(/for update/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it("限额与 if_rev 在 RPC 里判", () => {
    for (const s of [">= 8", ">= 50", ">= 500", "65536", "interval '10 seconds'", ">= 60", "p_if_rev"]) expect(sql).toContain(s);
  });
});
