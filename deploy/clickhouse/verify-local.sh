#!/usr/bin/env bash
# Local verification gate for deploy/clickhouse (Phase 2 of the cost plan, GBA-213).
#
# Builds the image, runs it under the same 5 GB memory limit as the Railway
# replica, and checks that every setting we care about is *in effect*, not
# just configured — the previous image configured a cap that ClickHouse
# silently discarded. Also applies Langfuse's ClickHouse migrations and does
# a round-trip insert, so the image is proven against the real schema.
#
# Usage: deploy/clickhouse/verify-local.sh            (from the repo root)
#        KEEP=1 deploy/clickhouse/verify-local.sh     leaves the container running
#        OLD_IMAGE=adrianomai/clickhouse-custom:25.8 deploy/clickhouse/verify-local.sh
#                                                     also reproduces the old image's bug
# Needs: docker (OrbStack is fine), curl, golang-migrate (`brew install golang-migrate`).
set -euo pipefail

cd "$(dirname "$0")/../.."
IMAGE=ch-omai:verify
NAME=ch-omai-verify
HTTP_PORT=${HTTP_PORT:-18123}
TCP_PORT=${TCP_PORT:-19000}
USER_=clickhouse
PASS=verify-only
fail=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=1; }
q()    { docker exec "$NAME" clickhouse-client --user "$USER_" --password "$PASS" -q "$1" 2>&1; }
qerr() { docker exec "$NAME" clickhouse-client --user "$USER_" --password "$PASS" -q "$1" 2>&1 || true; }

start() { # $1 image
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --memory 5g \
    -p "127.0.0.1:${HTTP_PORT}:8123" -p "127.0.0.1:${TCP_PORT}:9000" \
    -e CLICKHOUSE_USER="$USER_" -e CLICKHOUSE_PASSWORD="$PASS" -e CLICKHOUSE_DB=default \
    "$1" >/dev/null
  for _ in $(seq 1 60); do curl -fs "localhost:${HTTP_PORT}/ping" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "container did not become healthy"; docker logs "$NAME" | tail -20; exit 1
}
cleanup() { [ "${KEEP:-0}" = 1 ] || docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ -n "${OLD_IMAGE:-}" ]; then
  say "Reproducing the old image's missing cap ($OLD_IMAGE)"
  docker pull -q "$OLD_IMAGE" >/dev/null
  start "$OLD_IMAGE"
  v=$(q "SELECT value FROM system.server_settings WHERE name = 'max_server_memory_usage'")
  [ "$v" = 0 ] && ok "old image: effective max_server_memory_usage = 0 (unlimited) — this is the production bug" \
               || bad "old image: expected 0, got $v"
fi

say "Building $IMAGE from deploy/clickhouse"
docker build -q -t "$IMAGE" deploy/clickhouse >/dev/null
start "$IMAGE"
ok "started; $(docker exec "$NAME" clickhouse-server --version)"

say "Server memory cap is in effect"
v=$(q "SELECT value FROM system.server_settings WHERE name = 'max_server_memory_usage'")
c=$(q "SELECT changed FROM system.server_settings WHERE name = 'max_server_memory_usage'")
[ "$v" = 3221225472 ] && [ "$c" = 1 ] && ok "max_server_memory_usage = 3 GiB (changed=1)" || bad "max_server_memory_usage = $v changed=$c"
r=$(q "SELECT value FROM system.server_settings WHERE name = 'max_server_memory_usage_to_ram_ratio'")
[ "$r" = 0.9 ] && ok "max_server_memory_usage_to_ram_ratio = 0.9" || bad "ratio = $r"
if docker exec "$NAME" sh -c 'grep -q "Lowered setting .max_server_memory_usage." /var/log/clickhouse-server/clickhouse-server.log'; then
  bad "server log says the cap was lowered — ratio x RAM is below 3 GiB"
else
  ok "server log has no 'Lowered setting' line"
fi
for s in mark_cache_size:268435456 uncompressed_cache_size:134217728; do
  n=${s%%:*}; want=${s##*:}; got=$(q "SELECT value FROM system.server_settings WHERE name = '$n'")
  [ "$got" = "$want" ] && ok "$n = $got" || bad "$n = $got (want $want)"
done

say "Per-query profile applies to the CLICKHOUSE_USER user"
for s in max_memory_usage:2147483648 max_bytes_before_external_group_by:1073741824 max_bytes_before_external_sort:1073741824; do
  n=${s%%:*}; want=${s##*:}; got=$(q "SELECT value FROM system.settings WHERE name = '$n'")
  [ "$got" = "$want" ] && ok "$n = $got" || bad "$n = $got (want $want)"
done

say "Timezone (Langfuse requires UTC)"
tz=$(q "SELECT timezone()"); [ "$tz" = UTC ] && ok "timezone = UTC" || bad "timezone = $tz"

say "System log tables: kept ones carry a TTL, removed ones do not exist"
q "SYSTEM FLUSH LOGS" >/dev/null
for t in query_log part_log metric_log; do
  e=$(q "SELECT engine_full FROM system.tables WHERE database = 'system' AND name = '$t'")
  case "$e" in *"TTL "*) ok "system.$t has TTL" ;; *) bad "system.$t: no TTL (engine_full: ${e:-table missing})" ;; esac
done
for t in text_log asynchronous_metric_log trace_log query_thread_log query_views_log processors_profile_log opentelemetry_span_log latency_log session_log; do
  n=$(q "SELECT count() FROM system.tables WHERE database = 'system' AND name = '$t'")
  [ "$n" = 0 ] && ok "system.$t absent" || bad "system.$t exists"
done

say "Limits are enforced, not just reported"
# Error wording differs across versions: 25.8 says "Query memory limit exceeded"
# / "(total) memory limit exceeded"; older builds say "Memory limit (for query)
# exceeded" / "Memory limit (total) exceeded". Both carry "maximum: <limit>".
out=$(qerr "SELECT length(groupArray(number)) FROM numbers(400000000)")
case "$out" in
  *"Code: 241"*"uery"*"maximum: 2.00 GiB"*) ok "a 3.2 GB query is refused by the 2 GiB per-query limit" ;;
  *) bad "per-query limit not enforced: ${out:0:300}" ;;
esac
out=$(qerr "SELECT length(groupArray(number)) FROM numbers(700000000) SETTINGS max_memory_usage = 0, max_bytes_before_external_group_by = 0")
case "$out" in
  *"Code: 241"*"total"*"maximum: 3.00 GiB"*) ok "a 5.6 GB query with the per-query limit disabled is refused by the 3 GiB server cap" ;;
  *) bad "server cap not enforced: ${out:0:300}" ;;
esac

say "Langfuse ClickHouse migrations apply and a trace round-trips"
if command -v migrate >/dev/null; then
  if migrate -source file://packages/shared/clickhouse/migrations/unclustered \
       -database "clickhouse://localhost:${TCP_PORT}?username=${USER_}&password=${PASS}&database=default&x-multi-statement=true&x-migrations-table-engine=MergeTree" up >/tmp/ch-migrate.log 2>&1; then
    ok "$(q "SELECT count() FROM system.tables WHERE database = 'default'") tables created by migrations"
  else
    bad "migrations failed: $(tail -3 /tmp/ch-migrate.log)"
  fi
  q "INSERT INTO traces (id, timestamp, name, project_id, created_at, updated_at, event_ts) VALUES ('verify-1', now64(3), 'verify', 'p1', now64(3), now64(3), now64(3))" >/dev/null
  n=$(q "SELECT count() FROM traces WHERE id = 'verify-1'")
  [ "$n" = 1 ] && ok "insert + select on traces" || bad "trace round-trip returned $n rows"
else
  bad "golang-migrate not installed (brew install golang-migrate) — migrations not verified"
fi

say "Result"
[ $fail = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
