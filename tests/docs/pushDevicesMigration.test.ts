// 0045_push_devices.sql 的可执行版（#1411，spec §1.1）。migration 是在生产手动执行的，门禁跑不到它；
// 这几条钉的是「客户端只走两个 RPC」「换了账号令牌就归新账号」「注销只删自己的」在 SQL 上的样子。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0045_push_devices.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0045_push_devices", () => {
  it("一行 = 一个设备令牌；人删了跟着删", () => {
    expect(code).toMatch(/create table if not exists public\.push_devices/);
    expect(code).toMatch(/token\s+text primary key/);
    expect(code).toMatch(/user_id\s+uuid not null references auth\.users\(id\) on delete cascade/);
    expect(code).toMatch(/apns_env\s+text,/);
  });
  it("RLS 开着；只有一条读自己的 select 策略；不给 authenticated 任何写策略", () => {
    expect(code).toMatch(/alter table public\.push_devices enable row level security/);
    expect(code).toMatch(/create policy pd_select_self on public\.push_devices for select to authenticated using \(user_id = auth\.uid\(\)\)/);
    expect(code).not.toMatch(/on public\.push_devices for (insert|update|delete|all)/);
  });
  it("register：security definer；先删这个令牌挂在别人名下的那一行，再 upsert 到自己名下", () => {
    const start = code.indexOf("function public.register_push_device");
    const body = code.slice(start, code.indexOf("function public.unregister_push_device"));
    expect(body).toMatch(/security definer set search_path = public/);
    const del = body.indexOf("delete from push_devices where token = p_token and user_id <> auth.uid()");
    const ins = body.indexOf("insert into push_devices");
    expect(del).toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(del);
    // 同一个人重复登记不清环境：同一个令牌的环境不会变
    expect(body).toMatch(/on conflict \(token\) do update set bundle_id = excluded\.bundle_id, updated_at = now\(\)/);
  });
  it("unregister：security definer，只删自己名下的这一行", () => {
    const body = code.slice(code.indexOf("function public.unregister_push_device"));
    expect(body).toMatch(/security definer set search_path = public/);
    expect(body).toMatch(/delete from push_devices where token = p_token and user_id = auth\.uid\(\)/);
  });
  it("0046 重建 register 时（#1418）上面几条不变量一条没丢，令牌长度仍是 16～256", () => {
    const fix = readFileSync(new URL("../../supabase/migrations/0046_push_device_token_check.sql", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(fix).toMatch(/security definer set search_path = public/);
    expect(fix).toMatch(/length\(p_token\) not between 16 and 256/);
    const del = fix.indexOf("delete from push_devices where token = p_token and user_id <> auth.uid()");
    expect(del).toBeGreaterThan(-1);
    expect(fix.indexOf("insert into push_devices")).toBeGreaterThan(del);
    expect(fix).toMatch(/on conflict \(token\) do update set bundle_id = excluded\.bundle_id, updated_at = now\(\)/);
    expect(fix).toMatch(/revoke all on function public\.register_push_device\(text, text\) from public/);
    expect(fix).toMatch(/grant execute on function public\.register_push_device\(text, text\) to authenticated/);
  });
  it("两个 RPC 都只给 authenticated", () => {
    for (const sig of ["register_push_device\\(text, text\\)", "unregister_push_device\\(text\\)"]) {
      expect(code).toMatch(new RegExp(`revoke all on function public\\.${sig} from public`));
      expect(code).toMatch(new RegExp(`grant execute on function public\\.${sig} to authenticated`));
    }
  });
});
