# Manual Sync Guide: omaihq/langfuse ← langfuse/langfuse

This document outlines the process for syncing the omaihq fork with the upstream langfuse repository.

## Prerequisites

- Upstream remote configured: `git remote add upstream https://github.com/langfuse/langfuse.git`
- Local services running (PostgreSQL, ClickHouse, Redis) or Docker via `pnpm run infra:dev:up`

## Sync Process

### 1. Fetch Upstream Changes

```bash
git fetch upstream
```

### 2. Create Sync Branch

```bash
git checkout main
git checkout -b sync-fork/YYYY-MM-DD
```

### 3. Merge Upstream

```bash
git merge upstream/main
```

### 4. Resolve Conflicts

Common conflict files (check each carefully):

| File | Strategy |
|------|----------|
| `.env.dev.example` | Keep our custom vars (SUPABASE_*, CHAINLIT_*) + accept upstream additions |
| `packages/shared/src/errors/index.ts` | Keep our exports + add upstream exports |
| `packages/shared/src/server/llm/types.ts` | Merge model lists (keep both versions) |
| `web/package.json` | Keep our deps (@supabase/supabase-js) + accept version bumps |
| `web/src/env.mjs` | Keep our custom env vars + accept upstream schema changes |
| `web/src/server/api/root.ts` | Keep our custom routers (accounts, conversations) |
| `web/src/components/layouts/routes.tsx` | Keep OMAI routes and RouteGroup.OMAI |
| `worker/src/features/utils/utilities.ts` | Keep our callLLM functions |
| `pnpm-lock.yaml` | Accept either, will regenerate |

### 5. Handle Deleted/Moved Files

If upstream deletes files we've modified (e.g., `layout.tsx` → `app-layout/`):
- Check if our customizations need to be migrated to new location
- If customizations are UI-only, may need to re-apply to new component structure

### 6. Install Dependencies

```bash
pnpm i
```

### 7. Run Database Migrations

```bash
cd packages/shared
pnpm run db:generate   # Regenerate Prisma client
pnpm run db:migrate    # Run PostgreSQL migrations
```

### 8. Run ClickHouse Migrations

```bash
cd packages/shared
pnpm run ch:up         # Run ClickHouse migrations
```

### 9. Fix Lint Issues

```bash
pnpm --filter=web run lint
# Fix any issues (usually unused variables - prefix with _)
```

### 10. Build and Verify

```bash
pnpm --filter=web run build
pnpm --filter=worker run build
```

### 11. Test Locally

```bash
# Ensure local services are running:
# - PostgreSQL (port 5433 per .env)
# - ClickHouse (port 8123)
# - Redis (port 6379)

pnpm run dev
```

Verify:
- [ ] App starts without errors
- [ ] Custom routes work: `/project/[id]/accounts`, `/project/[id]/conversations`
- [ ] Dashboard loads (ClickHouse queries work)
- [ ] Tracing works

### 12. Commit the Merge

```bash
git add -A
git commit -m "Merge upstream/main (X commits since LAST_SYNC_DATE)

Key changes from upstream:
- [List major changes]

Preserved OMAI customizations:
- Custom Supabase and Chainlit env vars
- Accounts and Conversations features/routes
- Custom tRPC routers
- Sentry instrumentation

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

## OMAI Customizations to Preserve

### Environment Variables (web/src/env.mjs)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CHAINLIT_AUTH_SECRET`

### Custom Features
- `web/src/features/accounts/` - Accounts management
- `web/src/features/conversations/` - Conversation view
- `web/src/pages/project/[projectId]/accounts/`
- `web/src/pages/project/[projectId]/conversations/`

### Custom Routes (web/src/components/layouts/routes.tsx)
- `RouteGroup.OMAI`
- Accounts route
- Conversations route
- `OMAI_ROUTES` array

### Custom tRPC Routers (web/src/server/api/root.ts)
- `accountsRouter`
- `conversationsRouter`

### Worker Utilities (worker/src/features/utils/utilities.ts)
- `callLLM()`
- `callStructuredLLM()`
- `compileHandlebarString` (alias for backward compat)

## Troubleshooting

### Redis Auth Errors
If using Homebrew Redis without password, ensure `.env` has:
```
REDIS_AUTH=""
```
Or remove the line entirely.

### ClickHouse Connection Errors
Ensure ClickHouse is running:
```bash
brew services start clickhouse  # If using Homebrew
# OR
pnpm run infra:dev:up          # If using Docker
```

### Prisma "Response from Engine was empty"
Run migrations:
```bash
cd packages/shared && pnpm run db:migrate
```

### Invalid model prices JSON
Check `worker/src/constants/default-model-prices.json` for:
- Entries with snake_case keys (should be camelCase)
- Missing `pricingTiers` array (old format used `prices` directly)

## Deployment to Railway

### Deployment Order

**Deploy `web` first, then `worker`.**

| Container | Runs Migrations | Entrypoint |
|-----------|-----------------|------------|
| **web** | ✅ PostgreSQL + ClickHouse | `web/entrypoint.sh` |
| **worker** | ❌ None | `worker/entrypoint.sh` |

The **web container** automatically runs migrations on startup:
1. `prisma migrate deploy` - PostgreSQL migrations
2. `./clickhouse/scripts/up.sh` - ClickHouse migrations

The **worker container** does NOT run migrations - it only starts the worker process.

### Migration Environment Variables

To disable automatic migrations (e.g., for debugging):
```bash
LANGFUSE_AUTO_POSTGRES_MIGRATION_DISABLED=true
LANGFUSE_AUTO_CLICKHOUSE_MIGRATION_DISABLED=true
```

### Deployment Steps

1. Push sync branch for testing:
   ```bash
   git push origin sync-fork/YYYY-MM-DD
   ```

2. Create PR to main

3. After merge, Railway will auto-deploy

4. **Deployment sequence:**
   - Web deploys first → runs migrations automatically
   - Wait for web to become healthy (migrations complete)
   - Worker deploys after web is up

5. Post-deployment verification:
   - Check Railway logs for migration success/failure
   - Verify web container started successfully
   - Test custom routes in production: `/project/[id]/accounts`, `/project/[id]/conversations`

### If Migrations Fail

- Web container will exit with non-zero status
- Railway will show the deployment as failed
- Check logs for specific migration errors
- Common issues:
  - Database connection timeouts
  - Schema conflicts (rare with Prisma)
  - ClickHouse connection issues

## Sync History

| Date | Branch | Commits | Notes |
|------|--------|---------|-------|
| 2024-10-31 | sync-fork/oct31 | ~X | Initial documented sync |
| 2025-02-02 | sync-fork/feb2 | 546 | Layout refactor, events table v2, ESLint flat config |
