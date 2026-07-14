# Plan: Migrate Railway build from Nixpacks → Dockerfile builder

**Repo:** `omaihq/langfuse` (our fork) · **Railway project:** `langfuse-selfhost` (`a38aea65-c86d-4f21-b73d-e49176ade52c`), env `production` · **Status:** ready to implement · **Do not commit until reviewed**

## Why

Every push to `main` triggers a full from-scratch rebuild of `langfuse-web` and `langfuse-worker` (~7 min) because the services use the **Nixpacks** builder, which has weak layer caching. The repo already ships optimized multi-stage Dockerfiles (`web/Dockerfile`, `worker/Dockerfile`) with `turbo prune` + a cached `pnpm install --frozen-lockfile` layer, so a source-only change would skip dependency install and rebuild in a fraction of the time. Nixpacks is also **deprecated** by Railway (Railpack is its replacement, but our hand-tuned Dockerfiles are the known-good, tested path for this monorepo — prefer Dockerfile over Railpack).

## Constraint: no lower environment

We run a single `production` environment; there is no staging copy of Langfuse. We therefore validate the Docker build on a **temporary throwaway Railway service** in the same project before touching the live services.

### Is testing with a new service safe? — Yes, with these caveats

A new web service is **mostly stateless**, so running a second instance briefly is low-risk **provided**:
1. **Same backing data.** The test service will share the *production* Postgres, ClickHouse, Redis, and MinIO (no separate datastore exists). Treat anything it writes as production. Do scoring/test actions only in the dev project `cmcxvpji00001os02rmypuvw2` and clean up test rows (as we did with `probe-2`).
2. **Migrations on boot.** Langfuse's web/worker entrypoint runs DB + ClickHouse migrations on startup. **Point the test service at the same commit (`main` tip) that's already live**, so the schema version matches and there are **no pending migrations** (the migration step is a no-op). Do **not** point the test service at a newer/different commit that could apply migrations against prod.
3. **Do not add a second worker.** Only test a web service this way. The worker consumes the shared Redis queue; a second worker would double-process events. Validate the worker image via build logs + a short single-instance cutover, not a parallel test instance.
4. **Build-time public env.** Next.js inlines `NEXT_PUBLIC_*` at **build** time. The Docker build must receive every `NEXT_PUBLIC_*` the app needs, or the browser bundle ships with missing/wrong config. Copy all env vars to the test service **before** building.

## Goal

Move `langfuse-web` and `langfuse-worker` to the **Dockerfile** builder (`web/Dockerfile`, `worker/Dockerfile`), validated via a temporary service, with instant rollback available.

---

## Steps

### Phase 1 — Validate the web Docker build on a throwaway service
1. In the `langfuse-selfhost` project / `production` env, create a new service **`langfuse-web-dockertest`** from the `omaihq/langfuse` repo, branch `main`, root directory empty.
2. Set its builder to **Dockerfile**, dockerfile path **`web/Dockerfile`** (repo-relative — note the existing `RAILWAY_DOCKERFILE_PATH=/web/Dockerfile` variable has a leading slash and should be `web/Dockerfile`).
3. **Copy all 42 env vars** from `langfuse-web` to the test service, including any `NEXT_PUBLIC_*`. If the live web service is missing `NEXT_PUBLIC_SENTRY_DSN` etc., that's fine for this test (tracked in the Sentry plan).
4. Remove any **custom Start Command** on the test service — the Dockerfile has its own `entrypoint.sh` + `CMD`. Confirm port/healthcheck match what the Dockerfile `EXPOSE`s (web: 3000).
5. Generate a **temporary domain** for the test service (do not point any real DNS at it).
6. Deploy. Watch the build — confirm it completes and is **faster** than Nixpacks, and that the cached `pnpm install` layer is reused on a subsequent no-op redeploy.
7. **Validate runtime** on the temp domain: app loads, login works, open a conversation, save a score **in the dev project**, confirm the row in ClickHouse, and check boot logs show migrations as a no-op (same version) and no errors.

### Phase 2 — Cut over the real web service
8. Once the test service is validated: on the **real `langfuse-web`** service, switch builder Nixpacks → **Dockerfile**, dockerfile path `web/Dockerfile`, remove conflicting custom Start Command, fix `RAILWAY_DOCKERFILE_PATH` → `web/Dockerfile`.
9. Redeploy. Keep the **previous (Nixpacks) deployment pinned for rollback**. Watch build + boot + a live score save. If anything is wrong, **roll back to the previous deployment** (one click) and revert the builder setting.

### Phase 3 — Worker
10. On **`langfuse-worker`**, switch builder to **Dockerfile**, dockerfile path **`worker/Dockerfile`**. Worker has no public domain — validate via logs: clean boot, migrations no-op, and it resumes processing the queue (e.g. the periodic "Sending scores … to PostHog" lines reappear). Rollback available as in Phase 2.

### Phase 4 — Cleanup
11. Delete the temporary `langfuse-web-dockertest` service and its domain.
12. (Optional, ties to the type-check plan) add `RUN pnpm turbo run typecheck --filter=web...` to `web/Dockerfile` (and worker) builder stage so the image build fails on type errors.

---

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| Browser bundle missing `NEXT_PUBLIC_*` (build-time) | Copy all env (incl. `NEXT_PUBLIC_*`) to the test service before build; verify in the running app |
| Boot runs migrations against prod DB | Use the **same commit** already live → no pending migrations (no-op). Never test with a newer commit |
| Custom Start Command overrides Dockerfile CMD | Remove custom Start Command; rely on the Dockerfile `entrypoint.sh`/`CMD` |
| Port/healthcheck mismatch | Confirm against Dockerfile `EXPOSE` (web 3000); set healthcheck path/port accordingly |
| Second worker double-processes the queue | Do **not** run a parallel test worker; cut the worker over directly with rollback ready |
| Test writes pollute prod data | Score only in dev project `cmcxvpji00001os02rmypuvw2`; clean up test rows |
| Bad image serves prod | Previous deployment stays pinned → instant rollback; revert builder setting |

## Acceptance criteria
- Test service builds via Dockerfile, boots clean, login + score-save work, migrations are a no-op.
- A subsequent source-only redeploy of the Dockerfile build is **noticeably faster** than the ~7-min Nixpacks build (cached install layer).
- Real `langfuse-web` and `langfuse-worker` run on the Dockerfile builder; scoring works end-to-end; previous deployments remain available for rollback.
- Temporary test service deleted.

## Out of scope
- Railpack (we prefer the maintained Dockerfile for this monorepo).
- Turborepo remote caching (`TURBO_TOKEN`/`TURBO_TEAM`) — a possible follow-up to speed builds further.
- Per-service build path scoping so a web-only change doesn't rebuild worker — follow-up.
