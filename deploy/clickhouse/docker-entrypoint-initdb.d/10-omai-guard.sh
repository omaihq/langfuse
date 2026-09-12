#!/usr/bin/env bash
# Boot guard for the langfuse-selfhost ClickHouse image.
#
# The official entrypoint runs this on every start (CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS=1
# in the Dockerfile) against a server that listens on 127.0.0.1 only; the public
# ports open after this script returns. A non-zero exit aborts the boot, so a
# deployment whose limits are not in effect never becomes live and Railway keeps
# the previous one.
#
# 1. Assert the memory limits configured in config.d/ and users.d/ are the
#    effective ones. The previous image configured a cap that ClickHouse
#    silently discarded; this is what makes that impossible to repeat.
# 2. Drop the system log tables config.d/omai-system-logs.xml marks remove="1",
#    and any <name>_N generation ClickHouse renamed aside when a log table's
#    definition changed. remove="1" only stops writes; it never deletes data.
#    Best effort: a failed DROP is logged, not fatal.
set -euo pipefail

log() { echo "omai-guard: $*"; }
ch()  { clickhouse-client --host 127.0.0.1 -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -q "$1"; }

expect_server_setting() { # name expected
  local got; got=$(ch "SELECT value FROM system.server_settings WHERE name = '$1'")
  if [ "$got" != "$2" ]; then
    log "REFUSING TO START: server setting $1 is '$got', expected '$2'. Check config.d/omai-limits.xml and the replica memory limit." >&2
    exit 1
  fi
  log "$1 = $got"
}
expect_profile_setting() { # name expected
  local got; got=$(ch "SELECT value FROM system.settings WHERE name = '$1'")
  if [ "$got" != "$2" ]; then
    log "REFUSING TO START: profile setting $1 is '$got', expected '$2'. Check users.d/omai-profile.xml." >&2
    exit 1
  fi
  log "$1 = $got"
}

expect_server_setting max_server_memory_usage 3221225472
expect_server_setting merges_mutations_memory_usage_soft_limit 1073741824
expect_profile_setting max_memory_usage 1610612736

# A kept table whose definition changed (e.g. TTL added) is renamed to <name>_N
# and recreated on its first flush, not at startup. Flush now so those
# generations exist before we look for them.
ch "SYSTEM FLUSH LOGS"

# Tables to drop: remove="1" entries in the config (single source of truth) ...
removed=$(grep -oE '<[a-z_]+_log remove="1"' /etc/clickhouse-server/config.d/omai-system-logs.xml | sed -E 's/<([a-z_]+) .*/\1/' | sort -u)
removed_sql=$(printf "'%s'," $removed); removed_sql=${removed_sql%,}
# ... plus any renamed generation such as query_log_0, text_log_1.
to_drop=$(ch "SELECT name FROM system.tables WHERE database = 'system' AND (name IN ($removed_sql) OR match(name, '^[a-z_]+_log_[0-9]+$')) ORDER BY name")

if [ -z "$to_drop" ]; then
  log "no leftover system log tables"
else
  for t in $to_drop; do
    if ch "DROP TABLE IF EXISTS system.\`$t\` SYNC"; then
      log "dropped system.$t"
    else
      log "WARNING: could not drop system.$t (continuing)" >&2
    fi
  done
fi
log "ok"
