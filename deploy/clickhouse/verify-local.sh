#!/usr/bin/env bash
# Verification gate for deploy/clickhouse (Phase 2 of the cost plan, GBA-213).
# Runs locally (OrbStack/Docker) and in CI (.github/workflows/deploy-clickhouse.yml).
#
# Proves, on the built image and under the same 5 GB memory limit as the Railway
# replica, that every setting we care about is *in effect* and *enforced* — the
# previous image configured a cap that ClickHouse silently discarded — and that
# the boot guard refuses a misconfigured start and cleans an existing volume.
#
# Usage: deploy/clickhouse/verify-local.sh            (from the repo root)
#        KEEP=1 ...                                    leaves the last container running
#        OLD_IMAGE=adrianomai/clickhouse-custom:25.8 ...  also reproduces the old image's bug
# Needs: docker, curl, golang-migrate (`brew install golang-migrate`).
#
# Deliberately no `set -e`: a failing query must reach the FAIL line, not abort
# the script with the container already removed.
set -uo pipefail

cd "$(dirname "$0")/../.."
IMAGE=ch-omai:verify
NAME=ch-omai-verify
VOL=ch-omai-verify-vol
BASE_IMAGE=$(sed -nE 's/^FROM (.*)$/\1/p' deploy/clickhouse/Dockerfile)
LOGS_XML=deploy/clickhouse/config.d/omai-system-logs.xml
HTTP_PORT=${HTTP_PORT:-18123}
TCP_PORT=${TCP_PORT:-19000}
USER_=clickhouse
PASS=verify-only
fail=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=1; }
# q: run a query; prints output (or the error text) and never aborts the script.
q()    { docker exec "$NAME" clickhouse-client --user "$USER_" --password "$PASS" -q "$1" 2>&1; }
check_eq() { # label got want
  [ "$2" = "$3" ] && ok "$1 = $2" || bad "$1 = '$2' (want '$3')"
}
# logs_have: true if the container log contains the pattern. Reads the whole
# stream (grep -c) on purpose: `grep -q` on a pipe trips pipefail via SIGPIPE.
logs_have() { docker logs "$NAME" 2>&1 | grep -cE "$1" >/dev/null; }

start() { # image [extra docker args...]
  local image=$1; shift
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -p "127.0.0.1:${HTTP_PORT}:8123" -p "127.0.0.1:${TCP_PORT}:9000" \
    -e CLICKHOUSE_USER="$USER_" -e CLICKHOUSE_PASSWORD="$PASS" -e CLICKHOUSE_DB=default \
    "$@" "$image" >/dev/null || { bad "docker run failed for $image"; return 1; }
  # Ready = /ping answers AND, for our image, the boot guard has finished (the
  # entrypoint's init server is localhost-only, but some port forwarders still
  # reach it, so /ping alone can answer before the guard has run).
  for _ in $(seq 1 120); do
    if curl -fs "localhost:${HTTP_PORT}/ping" >/dev/null 2>&1; then
      [ "$image" != "$IMAGE" ] && return 0
      logs_have "omai-guard: (ok|REFUSING)" && return 0
    fi
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = false ] && break
    sleep 1
  done
  bad "container did not become healthy"; docker logs "$NAME" 2>&1 | tail -20; return 1
}
cleanup() {
  [ "${KEEP:-0}" = 1 ] || docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Lists derived from the config — the config is the single source of truth.
KEPT=$(sed -nE 's/^[[:space:]]*<([a-z_]+_log)>[[:space:]]*$/\1/p' "$LOGS_XML" | sort -u | tr '\n' ' ')
REMOVED=$(grep -oE '<[a-z_]+_log remove="1"' "$LOGS_XML" | sed -E 's/<([a-z_]+) .*/\1/' | sort -u | tr '\n' ' ')
# Enabled by the base config, harmless (only written on backups / crashes / S3 queues ...).
ALLOWED_EMPTY="backup_log crash_log blob_storage_log s3queue_log azure_queue_log iceberg_metadata_log dead_letter_queue"

# ---------------------------------------------------------------------------
if [ -n "${OLD_IMAGE:-}" ]; then
  say "Reproducing the old image's missing cap ($OLD_IMAGE)"
  docker pull -q "$OLD_IMAGE" >/dev/null
  if start "$OLD_IMAGE" --memory 5g; then
    v=$(q "SELECT value FROM system.server_settings WHERE name = 'max_server_memory_usage'")
    [ "$v" = 0 ] && ok "old image: effective max_server_memory_usage = 0 (unlimited) — the production bug" \
                 || bad "old image: expected 0, got $v"
  fi
fi

# ---------------------------------------------------------------------------
say "Building $IMAGE from deploy/clickhouse (base $BASE_IMAGE)"
if docker build -q -t "$IMAGE" deploy/clickhouse >/dev/null; then ok "built"; else bad "docker build failed"; echo "SOME CHECKS FAILED"; exit 1; fi

# ---------------------------------------------------------------------------
say "Boot guard refuses to start when the cap cannot be honoured (3 GB limit -> cap lowered)"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --memory 3g -e CLICKHOUSE_USER="$USER_" -e CLICKHOUSE_PASSWORD="$PASS" "$IMAGE" >/dev/null
for _ in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false ] && break; sleep 1; done
if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false ] && [ "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" != 0 ]; then
  ok "container exited non-zero (exit $(docker inspect -f '{{.State.ExitCode}}' "$NAME"))"
else
  bad "container is still running / exited 0 under a 3 GB limit"
fi
logs_have "omai-guard: REFUSING TO START: server setting max_server_memory_usage" \
  && ok "log names the setting that failed" || bad "guard message missing from logs"

# ---------------------------------------------------------------------------
say "Boot guard cleans an existing volume (base image wrote the old log tables first)"
docker volume rm "$VOL" >/dev/null 2>&1 || true
if start "$BASE_IMAGE" --memory 5g -v "$VOL:/var/lib/clickhouse"; then
  q "SELECT count() FROM numbers(1000000)" >/dev/null; q "SYSTEM FLUSH LOGS" >/dev/null; sleep 2; q "SYSTEM FLUSH LOGS" >/dev/null
  before=$(q "SELECT count() FROM system.tables WHERE database = 'system' AND name LIKE '%\\_log'")
  ok "base image created $before system log tables on the volume"
  docker stop "$NAME" >/dev/null 2>&1
  if start "$IMAGE" --memory 5g -v "$VOL:/var/lib/clickhouse"; then
    logs_have "omai-guard: dropped system.text_log" && ok "guard dropped system.text_log" || bad "guard did not report dropping text_log"
    for t in $REMOVED; do
      n=$(q "SELECT count() FROM system.tables WHERE database = 'system' AND name = '$t'")
      [ "$n" = 0 ] || bad "system.$t still present after boot on the old volume"
    done
    n=$(q "SELECT count() FROM system.tables WHERE database = 'system' AND match(name, '^[a-z_]+_log_[0-9]+$')")
    check_eq "renamed *_log_N tables after boot" "$n" 0
    ok "removed tables absent after boot"
  fi
fi
docker volume rm "$VOL" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
say "Fresh start under the Railway 5 GB limit"
start "$IMAGE" --memory 5g || { echo "SOME CHECKS FAILED"; exit 1; }
ok "$(docker exec "$NAME" clickhouse-server --version)"
logs_have "omai-guard: ok" && ok "boot guard passed" || bad "boot guard did not report ok"

say "Server settings are in effect"
for s in max_server_memory_usage:3221225472 max_server_memory_usage_to_ram_ratio:0.9 \
         merges_mutations_memory_usage_soft_limit:1073741824 \
         mark_cache_size:268435456 uncompressed_cache_size:134217728 max_table_size_to_drop:0; do
  n=${s%%:*}; want=${s##*:}
  check_eq "$n" "$(q "SELECT value FROM system.server_settings WHERE name = '$n'")" "$want"
done
c=$(q "SELECT changed FROM system.server_settings WHERE name = 'max_server_memory_usage'"); check_eq "max_server_memory_usage.changed" "$c" 1
docker exec "$NAME" sh -c 'grep -q "Lowered setting .max_server_memory_usage." /var/log/clickhouse-server/clickhouse-server.log' \
  && bad "server log says the cap was lowered" || ok "server log has no 'Lowered setting' line"

say "Per-query profile applies to the CLICKHOUSE_USER user"
for s in max_memory_usage:1610612736 max_bytes_ratio_before_external_group_by:0.3 max_bytes_ratio_before_external_sort:0.3; do
  n=${s%%:*}; want=${s##*:}
  check_eq "$n" "$(q "SELECT value FROM system.settings WHERE name = '$n'")" "$want"
done

say "Timezone (Langfuse requires UTC)"
check_eq "timezone()" "$(q "SELECT timezone()")" UTC

say "Console logging reaches docker logs (what Railway keeps across a restart)"
q "SELECT throwIf(1, 'omai-verify-marker')" >/dev/null
logs_have "omai-verify-marker" && ok "failed query visible in container logs" || bad "container logs do not show server log lines"

say "System log tables: exactly the kept ones, each with a TTL; nothing unbounded"
q "SYSTEM FLUSH LOGS" >/dev/null
for t in $KEPT; do
  e=$(q "SELECT engine_full FROM system.tables WHERE database = 'system' AND name = '$t'")
  case "$e" in *"TTL "*) ok "system.$t has TTL" ;; *) bad "system.$t: no TTL (${e:-table missing})" ;; esac
done
for t in $(q "SELECT name FROM system.tables WHERE database = 'system' AND name LIKE '%\\_log' ORDER BY name"); do
  case " $KEPT " in *" $t "*) continue ;; esac
  case " $ALLOWED_EMPTY " in
    *" $t "*) rows=$(q "SELECT count() FROM system.\`$t\`"); [ "$rows" = 0 ] && ok "system.$t present but empty (allowed)" || bad "system.$t has $rows rows and no TTL" ;;
    *) bad "unexpected system log table without TTL: system.$t — add <ttl> or remove=\"1\" in $LOGS_XML" ;;
  esac
done
for t in $REMOVED; do
  n=$(q "SELECT count() FROM system.tables WHERE database = 'system' AND name = '$t'"); [ "$n" = 0 ] || bad "removed table system.$t exists"
done
ok "no removed table exists"

say "Limits are enforced, not just reported"
out=$(q "SELECT length(groupArray(number)) FROM numbers(300000000)")
case "$out" in
  *"Code: 241"*"maximum: 1.50 GiB"*) ok "a 2.4 GB query is refused by the 1.5 GiB per-query limit" ;;
  *) bad "per-query limit not enforced: ${out:0:300}" ;;
esac
# Right after a per-query kill the allocator still holds that query's pages
# (they count against the server cap via RSS); a normal query must still fit.
# uniqExact over 20M keys: a ~0.6 GB hash set, no output copy (groupArray doubles on output).
out=$(q "SELECT uniqExact(number) FROM numbers(20000000)")
[ "$out" = 20000000 ] && ok "a ~0.6 GB query succeeds immediately after that refusal (headroom for retained pages)" || bad "follow-up query failed: ${out:0:300}"
# Server cap: disable the per-query limit and ask for 5.6 GB. Last, because it
# leaves up to 3 GiB of retained pages behind for a few seconds.
out=$(q "SELECT length(groupArray(number)) FROM numbers(700000000) SETTINGS max_memory_usage = 0")
case "$out" in
  *"Code: 241"*"maximum: 3.00 GiB"*) ok "a 5.6 GB query with its own limit disabled is refused by the 3 GiB server cap" ;;
  *) bad "server cap not enforced: ${out:0:300}" ;;
esac
sleep 5

say "Spill to disk holds even with the web's max_bytes_before_external_group_by override"
out=$(q "SELECT count() FROM (SELECT toString(number) AS k, count() AS c FROM numbers(20000000) GROUP BY k) SETTINGS max_bytes_before_external_group_by = 32000000000")
[ "$out" = 20000000 ] && ok "20M-key GROUP BY completes under the 1.5 GiB limit with the 32 GB override" || bad "GROUP BY with web override failed: ${out:0:300}"

say "Langfuse ClickHouse migrations apply and a trace round-trips"
# Same URL shape as packages/shared/clickhouse/scripts/up.sh (not reused: it sources ../../.env unconditionally).
if command -v migrate >/dev/null; then
  if migrate -source file://packages/shared/clickhouse/migrations/unclustered \
       -database "clickhouse://localhost:${TCP_PORT}?username=${USER_}&password=${PASS}&database=default&x-multi-statement=true&x-migrations-table-engine=MergeTree" up >/tmp/ch-migrate.log 2>&1; then
    ok "$(q "SELECT count() FROM system.tables WHERE database = 'default'") tables created by migrations"
    out=$(q "INSERT INTO traces (id, timestamp, name, project_id, created_at, updated_at, event_ts) VALUES ('verify-1', now64(3), 'verify', 'p1', now64(3), now64(3), now64(3))")
    n=$(q "SELECT count() FROM traces WHERE id = 'verify-1'")
    [ "$n" = 1 ] && ok "insert + select on traces" || bad "trace round-trip returned '$n' (insert said: ${out:0:200})"
  else
    bad "migrations failed: $(tail -3 /tmp/ch-migrate.log)"
  fi
else
  bad "golang-migrate not installed (brew install golang-migrate) — migrations not verified"
fi

say "Result"
if [ $fail = 0 ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; exit 1; fi
