#!/usr/bin/env bash
# 把 supabase/checks/*.sql 依次对真库跑一遍。每个脚本自己包事务并 rollback，不留痕。
#
# 用法：
#   OTTO_DB_URL='postgresql://...' scripts/db-checks.sh          # 全跑
#   OTTO_DB_URL='postgresql://...' scripts/db-checks.sh 0008     # 只跑文件名含 0008 的
#
# OTTO_DB_URL 是 Supabase Dashboard → Project Settings → Database 里的连接串，
# 由调用方临时传进来，**永远不写进仓库**：它带库密码，和写死在 authConfig.ts 里的
# anon key 不是一个性质的东西。
#
# 为什么要有这么个东西：0004 的 check 在 0005 加外键之后失效了整整一条 lane
# 没人发现（issue #69），因为重跑它当年意味着现拼一条远程咒语。
# 一条命令跑全部，重跑的成本才低到会真的去跑。
set -uo pipefail

if [ -z "${OTTO_DB_URL:-}" ]; then
  echo "OTTO_DB_URL 没设——没有连接串就没有真库，这个脚本没有可跑的对象。" >&2
  echo "去 Supabase Dashboard → Project Settings → Database 取连接串，临时传进来：" >&2
  echo "  OTTO_DB_URL='postgresql://...' scripts/db-checks.sh" >&2
  exit 2
fi

filter="${1:-}"

cd "$(git rev-parse --show-toplevel)"
failed=0
for f in supabase/checks/*.check.sql; do
  [ -n "$filter" ] && [[ "$f" != *"$filter"* ]] && continue
  echo "=== $f"
  out=$(psql "$OTTO_DB_URL" -v ON_ERROR_STOP=1 -f "$f" 2>&1)
  echo "$out" | grep -E "NOTICE:|ERROR:" | sed 's/^NOTICE:  //'
  if ! echo "$out" | grep -q "=== 全部通过 ==="; then
    echo "!! $f 没跑到「全部通过」"
    failed=1
  fi
done
[ "$failed" -eq 0 ] && echo "全部 check 通过" || echo "有 check 未通过"
exit "$failed"
