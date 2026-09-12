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
# See deploy/README.md (Phase 2) for the verification queries.
FROM clickhouse/clickhouse-server:25.8.11.66

COPY config.d/ /etc/clickhouse-server/config.d/
COPY users.d/  /etc/clickhouse-server/users.d/
