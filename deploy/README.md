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

Filled in when Phase 2 runs. Verification queries (run inside `clickhouse-client`):

```sql
SELECT name, value, changed FROM system.server_settings
WHERE name IN ('max_server_memory_usage','max_server_memory_usage_to_ram_ratio','mark_cache_size','max_concurrent_queries');
-- expect max_server_memory_usage = 3221225472, changed = 1

SELECT name, engine_full FROM system.tables
WHERE database = 'system' AND name LIKE '%_log' AND engine_full LIKE '%TTL%';

SELECT name FROM system.tables WHERE database = 'system' AND match(name, '_log_[0-9]+$');
-- drop each of these, plus the disabled live tables (text_log, asynchronous_metric_log,
-- trace_log, query_thread_log, query_views_log, processors_profile_log,
-- opentelemetry_span_log, latency_log); then: df -h -i /var/lib/clickhouse
```

Rollback: switch the service source back to `adrianomai/clickhouse-custom:25.8`.

---

## Phase 3 — decommission MinIO, confirm run-rate

Filled in when Phase 3 runs: after ≥ 7 clean days, delete the `minio` service
and volume (human, irreversible); record the new Cost by Service table next to
the Phase 0 one; target ≤ $80 usage.
