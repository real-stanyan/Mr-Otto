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
  it("broadcast 私有频道：读放行 room: 与 room-sys:，写只放 room:（且没关房）", () => {
    expect(sql).toContain("on realtime.messages for select to authenticated");
    expect(sql).toContain("on realtime.messages for insert to authenticated");
    expect(sql).toMatch(/for select to authenticated using \(\s*realtime\.messages\.extension = 'broadcast' and public\.room_topic_readable\(realtime\.topic\(\)\)/);
    expect(sql).toMatch(/for insert to authenticated with check \(\s*realtime\.messages\.extension = 'broadcast' and public\.room_topic_writable\(realtime\.topic\(\)\)/);
    expect(sql).not.toContain("room_topic_member");
    const writable = sql.match(/function public\.room_topic_writable[\s\S]*?end \$\$;/)?.[0] ?? "";
    expect(writable).toContain("'^room:");
    expect(writable).not.toContain("room-sys");
    expect(writable).toContain("closed");
    const readable = sql.match(/function public\.room_topic_readable[\s\S]*?end \$\$;/)?.[0] ?? "";
    expect(readable).toContain("room-sys");
  });
  it("系统事件走 room-sys:<id>（成员只读、伪造不了）；关房时发 closed", () => {
    expect(sql).not.toMatch(/'room:' \|\| (old|new|v_room)/);
    expect((sql.match(/'room-sys:' \|\| /g) ?? []).length).toBeGreaterThanOrEqual(4);
    // 只在 closed 那一列变、且从没关变成关时才跑（终审 i）；函数里自己的判断留着兜底
    expect(sql).toMatch(/create trigger app_room_closed_notify\s+after update of closed on public\.app_rooms\s+for each row\s+when \(old\.closed is distinct from true and new\.closed\)\s+execute function public\.app_room_closed_notify\(\);/);
    expect(sql).toMatch(/realtime\.send\(\s*jsonb_build_object\('closed', true\),\s*'closed',\s*'room-sys:' \|\| new\.id,\s*true\s*\)/);
    expect(sql).toMatch(/old\.closed[\s\S]*?new\.closed/);
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
    expect(sql).toMatch(/realtime\.send\(\s*jsonb_build_object\('key'[\s\S]*?'change',\s*'room-sys:' \|\| [\s\S]*?true\s*\)/);
    expect(sql).toMatch(/realtime\.send\(\s*jsonb_build_object\('uid'[\s\S]*?'members',\s*'room-sys:' \|\| [\s\S]*?true\s*\)/);
    expect((sql.match(/exception when others then\s+null;/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it("成员判据不带 uid 参数（只问 auth.uid()）", () => {
    expect(sql).toContain("function public.is_room_member(p_room uuid) returns boolean");
    expect(sql).toContain("function public.room_topic_readable(p_topic text) returns boolean");
    expect(sql).toContain("function public.room_topic_writable(p_topic text) returns boolean");
    expect(sql).not.toMatch(/is_room_member\([^)]*,/);
  });
  it("并发：invite / set / remove / ping 先锁房间行再判上限与限速", () => {
    expect((sql.match(/for update/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
  it("app_room_remove 同 app_room_set：锁房间行、判关房、改完顶 app_rooms.updated_at（rooms() 按它排序）", () => {
    const remove = sql.match(/function public\.app_room_remove[\s\S]*?end \$\$;/)?.[0] ?? "";
    expect(remove).toContain("perform 1 from public.app_rooms where id = p_room for update;");
    expect(remove.indexOf("for update")).toBeLessThan(remove.indexOf("closed"));
    expect(remove).toContain("update public.app_rooms set updated_at = now() where id = p_room;");
  });
  it("注释不把 room: 的写说成逐条判关房：授权在加入频道时判一次（ADR-0374 §8）", () => {
    expect(sql).not.toContain("（没关房才能写）");
    expect(sql).not.toContain("（关房后不能再发）");
    expect((sql.match(/加入频道时判/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("限额与 if_rev 在 RPC 里判", () => {
    for (const s of [">= 8", ">= 50", ">= 500", "65536", "interval '10 seconds'", ">= 60", "p_if_rev"]) expect(sql).toContain(s);
  });
});
