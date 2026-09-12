# ClickHouse for the `langfuse-selfhost` Railway project.
#
# Replaces the unversioned `adrianomai/clickhouse-custom:25.8` image (source:
# github.com/omaihq/clickhouse-custom). Same ClickHouse version as that image
# reported on 2026-09-11; pinned to the exact patch so Railway rebuilds are
# reproducible. Upgrading past 25.8 is the v4 plan's job, not this file's.
#
# Railway service `clickhouse`: root directory `deploy/clickhouse`, Dockerfile
# builder, volume at /var/lib/clickhouse, health check /ping. The official
# entrypoint reads CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DB from
# the service variables, as before.
#
# Self-check at every boot: with CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS=1 the
# entrypoint starts the server on localhost only, runs
# docker-entrypoint-initdb.d/10-omai-guard.sh, and only then opens the ports.
# The guard aborts the boot if the memory limits are not in effect (Railway
# then keeps the previous deployment live) and drops the system log tables
# this config no longer keeps. See deploy/README.md, Phase 2.
FROM clickhouse/clickhouse-server:25.8.11.66

ENV CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS=1

COPY config.d/ /etc/clickhouse-server/config.d/
COPY users.d/  /etc/clickhouse-server/users.d/
COPY --chmod=0755 docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/
