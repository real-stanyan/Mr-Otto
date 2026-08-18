#!/usr/bin/env bash
# 把 supabase/checks/*.sql 依次对真库跑一遍。每个脚本自己包事务并 rollback，不留痕。
#
# 用法：
#   scripts/db-checks.sh                    # 全跑
#   scripts/db-checks.sh 0004               # 只跑文件名含 0004 的
#   DB_SSH="stan@1.2.3.4" scripts/db-checks.sh
#
# 为什么要有这么个东西：0004 的 check 在 0005 加外键之后失效了整整一条 lane
# 没人发现（issue #69），因为重跑它意味着现拼一条 ssh + docker exec 咒语。
# 一条命令跑全部，重跑的成本才低到会真的去跑。
set -uo pipefail

DB_SSH="${DB_SSH:-stan@65.109.113.168}"
DB_SSH_PORT="${DB_SSH_PORT:-2222}"
DB_CONTAINER="${DB_CONTAINER:-otto-db-1}"
filter="${1:-}"

cd "$(git rev-parse --show-toplevel)"
failed=0
for f in supabase/checks/*.check.sql; do
  [ -n "$filter" ] && [[ "$f" != *"$filter"* ]] && continue
  echo "=== $f"
  out=$(ssh -p "$DB_SSH_PORT" "$DB_SSH" \
        "docker exec -i $DB_CONTAINER psql -U postgres -v ON_ERROR_STOP=1" < "$f" 2>&1)
  echo "$out" | grep -E "NOTICE:|ERROR:" | sed 's/^NOTICE:  //'
  if ! echo "$out" | grep -q "=== 全部通过 ==="; then
    echo "!! $f 没跑到「全部通过」"
    failed=1
  fi
done
[ "$failed" -eq 0 ] && echo "全部 check 通过" || echo "有 check 未通过"
exit "$failed"
