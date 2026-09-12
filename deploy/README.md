# `langfuse-selfhost` on Railway — operations runbook

Plan: `gba-monorepo/plans/2026-08-27-langfuse-selfhost-cost-reduction.md`
(tracking: GBA-213). This file is the executor's reference: measured baseline,
variable map, cutover order, rollback. **No secret values in this file, ever.**
Variable *names* only; values live in Railway's Variables tab and its history.

Railway project `langfuse-selfhost` (`a38aea65-c86d-4f21-b73d-e49176ade52c`),
environment `production` (`ba450c9d-5f47-4b3e-86f8-732422d7b596`).

| Service          | Service id                             | Source                                   |
|------------------|----------------------------------------|------------------------------------------|
| `langfuse-web`   | `8ef5bf02-2137-4482-befd-82306bdac153` | this repo, `web/Dockerfile` via `RAILWAY_DOCKERFILE_PATH` |
| `langfuse-worker`| `b4d11473-fe44-4b2d-bb4c-5ba8c86c8c74` | this repo, `worker/Dockerfile` via `RAILWAY_DOCKERFILE_PATH` |
| `clickhouse`     | `c679e19e-a266-4a9f-bcae-f1e54f4b7cf6` | image `adrianomai/clickhouse-custom:25.8` (→ `deploy/clickhouse/` in Phase 2) |
| `minio`          | `c6e229e8-c7f2-4822-9069-b31dfeb792c1` | image `minio/minio` (→ removed in Phase 3) |
| `postgres`       | `db691ab5-459d-4a9c-a689-6ac5057a26e4` | Railway template                          |
| `redis`          | `4370e860-8705-4ee5-a349-25acb7030781` | Railway template                          |
| `locomotive`     | `335cdf2f-b9df-411d-a197-5040eac6e61f` | `gba-monorepo/services/locomotive` (log drain) |

`railway ssh` is blocked for agent sessions; a human runs shell steps with
`railway ssh --service <name> -e production -p a38aea65-c86d-4f21-b73d-e49176ade52c`.

---

## Phase 0 — baseline (measured 2026-09-11)

### Resource usage, 7-day averages (Railway API, 2026-09-04 → 2026-09-11)

| Service          | vCPU avg | RAM avg          | Volume used | Volume growth | Replica limit |
|------------------|----------|------------------|-------------|---------------|---------------|
| `minio`          | 3.85 (0.11 at sample time; scanner cycles) | 5.0 GB, pinned | 86.3 GB | +1.3 GB/week | 5 GB RAM |
| `clickhouse`     | 0.22     | 4.2 GB (3.4–4.7) | 84.6 GB     | +1.5 GB/week  | 3 vCPU / 5 GB |
| `langfuse-web`   | 0.003    | 0.61 GB          | —           | —             | —             |
| `langfuse-worker`| 0.014    | 0.73 GB          | —           | —             | —             |
| `postgres`       | 0.0005   | 0.75 GB          | 1.6 GB      | flat          | —             |
| `redis`          | 0.004    | 0.02 GB          | 1.1 GB      | flat          | —             |
| `locomotive`     | 0.0004   | 0.02 GB          | —           | —             | —             |

### Invoice split (Railway → Project Settings → Usage → Cost by Service, ≈ 27 days into the period)

| Service          | CPU    | RAM    | Volume | Backup | Egress | Period total |
|------------------|--------|--------|--------|--------|--------|--------------|
| `minio`          | $68.64 | $44.73 | $11.27 | $1.02  | $0.51  | **$126.18**  |
| `clickhouse`     | $8.07  | $74.83 | $11.49 | $6.01  | —      | **$100.39**  |
| `langfuse-web`   | $0.06  | $12.11 | —      | —      | $0.05  | $12.23       |
| `langfuse-worker`| $0.43  | $10.72 | —      | —      | $0.40  | $11.55       |
| `postgres`       | $0.02  | $7.40  | $0.50  | $0.51  | —      | $8.43        |
| `redis`          | $0.13  | $0.36  | $0.44  | $0.18  | —      | $1.11        |
| `locomotive`     | $0.01  | $0.39  | —      | —      | $0.06  | $0.45        |
| **usage so far** |        |        |        |        |        | **$260.34**  |

Railway's projection for the full period: **$305.81 usage** (+ $20 Pro plan).
ClickHouse's billed RAM ≈ 8 GB average over the period (the project RAM chart
shows ≈ 20 GB total early in the period with a spike to ≈ 50 GB, settling at
≈ 12 GB), i.e. ClickHouse ran well above its current 5 GB limit until the limit
was lowered.

### ClickHouse (`system.parts`, active, 2026-09-11)

Langfuse tables (database `default`) — **≈ 3 GB total**:

| Table                    | Size       | Rows      | Partitions      |
|--------------------------|------------|-----------|-----------------|
| `observations`           | 1.96 GiB   | 2 814 952 | 202507 → 202609 |
| `blob_storage_file_log`  | 616 MiB    | 3 539 315 | unpartitioned   |
| `traces`                 | 300 MiB    | 1 079 868 | 202507 → 202609 |
| `scores`                 | 110 MiB    | 1 150 028 | 202507 → 202609 |
| `dataset_run_items_rmt`  | 191 KiB    | 1 111     |                 |
| `schema_migrations`      | 1 KiB      | 68        |                 |
| `project_environments`   | < 1 KiB    | 5         |                 |

Oldest trace `2025-07-07 12:26:55`; newest `2026-09-12 00:00:43`.
`blob_storage_file_log`: 3 539 315 event files total, **67 332 in the last 7 days**
(≈ 290 k/month), first file 2025-07-07.

ClickHouse's own log tables (database `system`) — **≈ 80 GB, no TTL**:

| Table                        | Size      | Parts |
|------------------------------|-----------|-------|
| `asynchronous_metric_log`    | 22.0 GiB  | 50    |
| `text_log`                   | 18.0 GiB  | 52    |
| `asynchronous_metric_log_0`  | 6.7 GiB   | 18    |
| `metric_log`                 | 5.1 GiB   | 40    |
| `text_log_0`                 | 4.9 GiB   | 22    |
| `trace_log`                  | 4.1 GiB   | 38    |
| `query_log`                  | 2.6 GiB   | 40    |
| `trace_log_0`                | 1.8 GiB   | 20    |
| `metric_log_0`               | 1.7 GiB   | 17    |
| `trace_log_1`                | 1.6 GiB   | 10    |
| `processors_profile_log_0`   | 625 MiB   | 14    |
| `opentelemetry_span_log_0`   | 613 MiB   | 15    |
| `part_log`                   | 578 MiB   | 35    |
| `opentelemetry_span_log`     | 560 MiB   | 27    |
| `query_log_0`                | 538 MiB   | 10    |

The `_0` / `_1` tables are leftovers ClickHouse renames aside when a log table's
definition changes; nothing writes to them.

`system.server_settings` (all four `changed = 1`, i.e. set by the image's config):

| Setting                                | Value        | Meaning                     |
|----------------------------------------|--------------|-----------------------------|
| `max_server_memory_usage`              | 0            | **no cap**                  |
| `max_server_memory_usage_to_ram_ratio` | 0            | **ratio cap disabled too**  |
| `max_concurrent_queries`               | 1000         | default is 100              |
| `mark_cache_size`                      | 268 435 456  | 256 MiB                     |

Inodes: `/dev/zd3680` 12 214 272 total, 285 144 used (3 %).

### MinIO inventory (S3 API via the public domain, 2026-09-11)

Buckets: `langfuse`, `exports`.

| Bucket / prefix        | Objects   | Payload  | Notes |
|------------------------|-----------|----------|-------|
| `langfuse/media/`      | 0         | 0        | **empty — nothing to migrate** |
| `langfuse/exports/`    | 1         | 0 B      | stray empty marker from 2026-03-20 |
| `langfuse/events/`     | 3.54 M (from `blob_storage_file_log`) | ≈ 18 GB at ≈ 5 KB avg | never re-read once ingested — not migrated |
| `exports` (bucket)     | 59        | 19.1 GB  | batch-export files 2026-03-20 → 2026-09-09; download links expire after 24 h — not migrated |

Listing `langfuse/events/` through the API returns ≈ 1 000 keys per 12 s (46 000
keys in 9.5 min before the run was stopped). **Do not bulk-list MinIO.**
No TCP proxies exist on any service. MinIO is reachable on the private network
(`minio.railway.internal:9000`) and on a public Railway domain (the worker's
`RAILWAY_SERVICE_MINIO_URL`).

### `LANGFUSE_S3_*` variable names present (values not recorded)

`langfuse-web`:

- `LANGFUSE_S3_EVENT_UPLOAD_{BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY,REGION,ENDPOINT,FORCE_PATH_STYLE,PREFIX}` — bucket `langfuse`, private endpoint, path-style, prefix `events/`
- `LANGFUSE_S3_MEDIA_UPLOAD_{BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY,REGION,ENDPOINT,FORCE_PATH_STYLE,PREFIX}` — bucket `langfuse`, private endpoint, path-style, prefix `media/`
- `LANGFUSE_S3_BATCH_EXPORT_ENABLED`, `LANGFUSE_S3_BATCH_EXPORT_BUCKET` — bucket `exports`; **no export credentials on the web** (the worker runs exports)

`langfuse-worker`:

- the same `EVENT_UPLOAD` and `MEDIA_UPLOAD` groups as the web
- `LANGFUSE_S3_BATCH_EXPORT_{ENABLED,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY,REGION,ENDPOINT,FORCE_PATH_STYLE,PREFIX}` — bucket `exports`, **public** MinIO domain as endpoint (so presigned download links work from a browser), path-style, prefix `exports/`
- `LANGFUSE_EXPORT_USER_ID_SALT` (unrelated to storage; leave alone)

Other findings from the same pass (weak / placeholder secrets, public MinIO
API) are tracked in GBA-214, not here.

---

## Phase 1 — MinIO → Railway Bucket

Filled in when Phase 1 runs. Skeleton:

### Variable map

For `G` ∈ `EVENT_UPLOAD`, `MEDIA_UPLOAD` on the web; `G` ∈ `EVENT_UPLOAD`,
`MEDIA_UPLOAD`, `BATCH_EXPORT` on the worker:

```
LANGFUSE_S3_G_BUCKET=${{langfuse-blobs.BUCKET}}
LANGFUSE_S3_G_ACCESS_KEY_ID=${{langfuse-blobs.ACCESS_KEY_ID}}
LANGFUSE_S3_G_SECRET_ACCESS_KEY=${{langfuse-blobs.SECRET_ACCESS_KEY}}
LANGFUSE_S3_G_REGION=${{langfuse-blobs.REGION}}          # "auto"
LANGFUSE_S3_G_ENDPOINT=${{langfuse-blobs.ENDPOINT}}      # https://t3.storageapi.dev
LANGFUSE_S3_G_FORCE_PATH_STYLE=false                     # true only if the bucket's Credentials tab says path-style
```

Plus `LANGFUSE_S3_BATCH_EXPORT_BUCKET=${{langfuse-blobs.BUCKET}}` on the web.
All `LANGFUSE_S3_G_PREFIX` values stay as they are.

### Cutover order (why: the worker returns *successfully* on an empty S3 listing — no retry)

1. Quietest hour. 2. Remove the worker's active deployment (T₀). 3. Set the web
variables, wait for the deploy, confirm `railway bucket info -b langfuse-blobs`
object count grows on a test turn. 4. Dump waiting/prioritized/delayed
`bull:*ingestion-queue*` jobs from Redis and run `deploy/scripts/copy-gap.cjs`.
5. Set the worker variables, deploy. 6. Grep worker logs for `No events found`
and `NoSuchKey` for 30 min; record counts. 7. After 24 h clean: remove MinIO's
deployment, keep the volume.

### Rollback

Set each group's six variables back to the MinIO values from Railway's variable
history, worker first (remove deployment), then web, then worker deploy; redeploy
MinIO. Never paste the values here.

---

## Phase 2 — versioned ClickHouse image

Image: `deploy/clickhouse/` (Dockerfile pinned to `clickhouse/clickhouse-server:25.8.11.66`,
the version the old image reported). What it sets and why is in the comments of
`config.d/omai-limits.xml`, `config.d/omai-system-logs.xml`, `users.d/omai-profile.xml`.

**Root cause of the missing cap in the old image:** its `memory.xml` set
`max_server_memory_usage` to 3.2 GB *and* `max_server_memory_usage_to_ram_ratio`
to 0. ClickHouse lowers an explicit cap to RAM × ratio when the cap is larger, so
the effective cap became 0 (unlimited). The new config keeps the ratio at 0.9.

### Limits (all verified in effect and enforced by `verify-local.sh`)

| Setting | Value | Where |
|---|---|---|
| `max_server_memory_usage` | 3 GiB (replica limit 5 GB) | config.d |
| `merges_mutations_memory_usage_soft_limit` | 1 GiB (default would be 2.5 GiB) | config.d |
| `max_memory_usage` (per query) | 1.5 GiB | users.d, profile `default` |
| `max_bytes_ratio_before_external_group_by` / `_sort` | 0.3 (spill at ~460 MiB; ratio because the web overrides the byte setting) | users.d |
| `mark_cache_size` / `uncompressed_cache_size` | 256 MiB / 128 MiB (as before) | config.d |
| System log tables kept | `query_log`, `part_log`, `error_log`, 7-day TTL | config.d |
| System log tables removed | `text_log`, `asynchronous_metric_log`, `metric_log`, `query_metric_log`, `asynchronous_insert_log`, `trace_log`, `query_thread_log`, `query_views_log`, `processors_profile_log`, `opentelemetry_span_log` | config.d |
| Server log | level `information`, also to console (Railway keeps it across restarts) | config.d |

### Boot guard (`docker-entrypoint-initdb.d/10-omai-guard.sh`)

Runs at **every** start before the ports open. It refuses to start (Railway then
keeps the previous deployment live) if `max_server_memory_usage`,
`merges_mutations_memory_usage_soft_limit` or the profile's `max_memory_usage`
are not the values above — a resized replica or a config typo can no longer
produce a silently uncapped server. It then drops every system log table marked
`remove="1"` in `omai-system-logs.xml` and every renamed `<name>_N` generation,
so the ~80 GB of leftovers on the production volume disappear on the first boot
without anyone running `DROP TABLE` by hand. Its lines are prefixed `omai-guard:`
in the Railway service logs.

### Gate before touching Railway

`deploy/clickhouse/verify-local.sh` (also run by CI on any change under
`deploy/clickhouse/`): builds the image, proves the guard aborts under a 3 GB
limit, proves it cleans a volume written by the base image, then under the 5 GB
limit checks every setting, that both memory limits refuse oversized queries and
a normal query still fits right after a kill, that the spill survives the web's
32 GB override, that only the kept log tables exist and carry a TTL, that the
console log works, that the timezone is UTC, and that Langfuse's ClickHouse
migrations apply with a trace round-trip. `OLD_IMAGE=adrianomai/clickhouse-custom:25.8`
additionally reproduces the old image's cap = 0.

### Cutover (Railway, human, quiet hour)

1. Service `clickhouse` → Settings → Source: repo `omaihq/langfuse`, branch `main`,
   root directory `deploy/clickhouse`, builder Dockerfile. Watch paths
   `/deploy/clickhouse/**`. Keep the volume, variables and `/ping` health check.
2. Deploy. ClickHouse restarts once (~1 min); ingestion waits in Redis.
3. Railway logs must show `omai-guard: ok` and, on this first boot, a series of
   `omai-guard: dropped system.<table>` lines. If they show `REFUSING TO START`,
   the deployment never went live; the previous one is still serving.
4. Confirm the Langfuse traces page loads, then inside `railway ssh`:
   ```sql
   SELECT name, value FROM system.server_settings
   WHERE name IN ('max_server_memory_usage','merges_mutations_memory_usage_soft_limit');
   SELECT name, engine_full FROM system.tables WHERE database = 'system' AND name LIKE '%_log';
   ```
   and `df -h -i /var/lib/clickhouse` — expect used space to fall from ~85 GB to
   under 10 GB within minutes (drops are `SYNC`).
5. Soak 3 days: RAM avg ≤ 3 GB, volume flat, no `MEMORY_LIMIT_EXCEEDED` in
   web/worker logs. If the dashboards page trips the per-query limit, raise
   `max_memory_usage` in `users.d/omai-profile.xml` (and the guard's expected
   value) rather than removing the server cap.

Optional, on `langfuse-web`: `CLICKHOUSE_MAX_BYTES_BEFORE_EXTERNAL_GROUP_BY=536870912`
so the web's own spill threshold matches the profile instead of 32 GB. Not
required — the ratio setting already holds — but tidier.

Rollback: switch the service source back to `adrianomai/clickhouse-custom:25.8`.
The dropped log tables are not restored; nothing depends on them.

---

## Phase 3 — decommission MinIO, confirm run-rate

Filled in when Phase 3 runs: after ≥ 7 clean days, delete the `minio` service
and volume (human, irreversible); record the new Cost by Service table next to
the Phase 0 one; target ≤ $80 usage.
