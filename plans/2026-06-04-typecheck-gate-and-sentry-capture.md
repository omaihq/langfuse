# Plan: Type-check deploy gate + Sentry error capture

**Repo:** `omaihq/langfuse` (our fork) · **Status:** ready to implement · **Do not commit until reviewed**

## Why

On 2026-06-04 we found that conversation per-turn scoring had been silently broken since **Nov 16 2025** (~6.5 months). Root cause: upstream PR #10323 renamed the shared const `ScoreSource` → `ScoreSourceEnum`; our fork-only router `web/src/features/conversations/conversation-view/conversation-view.router.ts` still imported `ScoreSource`, which became `undefined` at runtime → `ScoreSource.ANNOTATION` threw.

Two safety nets that should have caught/surfaced this did not:
1. **Type-checking is not a deploy gate.** `web/next.config.mjs` sets `typescript.ignoreBuildErrors: true` and `eslint.ignoreDuringBuilds: true`, and the Railway build (Nixpacks, from source on push to `main`) never runs the separate `typecheck` step. A missing/renamed export (`TS2305`) would have failed `pnpm typecheck` but nothing ran it.
2. **Errors never reach Sentry.** The tRPC error layer (`web/src/server/api/trpc.ts`) only `logger.error`s and reshapes the message — no `captureException`/`traceException`. And the browser SDK (`web/instrumentation-client.ts`) reads `NEXT_PUBLIC_SENTRY_DSN`, which is **not set** on the Railway web service, so client-side Sentry is disabled entirely.

## Goal

A. Make a type error fail before it can reach production.
B. Make server `INTERNAL_SERVER_ERROR`s appear in Sentry with their real cause.
C. Make client-side errors actually report to Sentry.

---

## Part A — Type-check gate

The repo already has the command: `web/package.json` → `typecheck` (`tsgo -p tsconfig.build.json --noEmit`), root `turbo run typecheck`. We just need to run it in a place that blocks deploys.

**A1. CI workflow (required).** Add `.github/workflows/typecheck.yml` that runs on `pull_request` and `push` to `main`:
- checkout, setup node (v24, matching the Dockerfile base), corepack/pnpm
- `pnpm install --frozen-lockfile`
- `pnpm turbo run typecheck` (and optionally `pnpm turbo run lint`)
- Follow patterns in existing `.github/workflows/` (`pipeline.yml`, `ci.yml.template`) for the runner/cache setup; keep this workflow lightweight and fast.

**A2. Gate the deploy on it (required).** Railway auto-deploys `main` on push regardless of GitHub checks. In the Railway dashboard, for **both** `langfuse-web` and `langfuse-worker` services → Settings → enable **"Wait for CI"** (deploy only after required checks pass). *(Dashboard setting — document it here; cannot be done in code. Coordinate with repo owner; requires the typecheck workflow to be a required check.)*

**A3. Belt-and-suspenders (recommended, especially once on the Dockerfile builder — see the Docker plan).** Add a hard type-check step inside the image build so it fails even outside CI. In `web/Dockerfile` builder stage, before `next build`:
```dockerfile
RUN pnpm turbo run typecheck --filter=web...
```
(and the analogous line in `worker/Dockerfile`). This makes the build itself fail on a type error.

**Note on `ignoreBuildErrors: true`:** leave it as-is (it's inherited from upstream, which type-checks separately in CI). The separate `typecheck` step is the gate. Flipping it to `false` is optional and out of scope.

**A0 — PREREQUISITE: get the codebase type-clean first.** The gate can only be turned on once `pnpm turbo run typecheck` passes. Because `ignoreBuildErrors` has masked types for a long time, there are likely pre-existing latent type errors to triage first. Run the real type-check in a clean CI environment (no local rvm `dotenv` shadow; `@langfuse/shared` built) to get the true baseline, then fix or baseline them. **One such latent error was already found and fixed (2026-06-04):** the create branch of `upsertScore` passed `value: input.value ?? null` (`number | null`) where the shared `upsertScore` expects `value: number` — `TS2345`. Fixed to `value: input.value ?? 0` (also closes the latent null-vs-non-nullable issue; ClickHouse was coercing it). If the full repo isn't realistically clean, consider a ratchet (type-check only changed files in PRs, or commit a baseline) so new errors are blocked without requiring a big-bang cleanup.

### Part A acceptance
- **Verified 2026-06-04:** reverting to `import { ScoreSource }` makes the local type-check report **`conversation-view.router.ts(18,10): error TS2305: Module '"@langfuse/shared"' has no exported member 'ScoreSource'`** — i.e., this exact gate catches the exact bug that caused the 6.5-month outage. With `ScoreSourceEnum`, that error is gone. (The full local run also has unrelated module-resolution noise from an imperfect local build graph — the authoritative run is CI, where `@langfuse/shared` is built normally.)
- A PR with a type error cannot be merged/auto-deployed.

---

## Part B — Forward server tRPC errors to Sentry

Server Sentry is initialized (`web/sentry.server.config.ts`, `dsn: process.env.SENTRY_DSN`, which **is** set on Railway) but the tRPC layer never calls it.

**File:** `web/src/server/api/trpc.ts`
- Import `* as Sentry from "@sentry/nextjs"`.
- In the central error handler — `logErrorByCode(...)` (around line 147) and/or the `withErrorHandling` middleware (around line 160) — call `Sentry.captureException(error.cause ?? error, { tags: { trpcPath, code: errorCode } })` **only for server-fault codes** (`INTERNAL_SERVER_ERROR`, `SERVICE_UNAVAILABLE`). **Do not** capture expected client errors (`NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `BAD_REQUEST`, `TOO_MANY_REQUESTS`, `CONFLICT`, `PRECONDITION_FAILED`).
- Capture `error.cause` (the original thrown error) when present, since procedures may wrap it in a generic `TRPCError`.
- Capture in exactly one place (the central middleware) to avoid duplicate Sentry events.

### Part B acceptance
- Temporarily add a `throw new Error("sentry test")` to a protected procedure → a Sentry issue appears for the **server** project with the real stack and a `trpcPath` tag. Remove the test throw.

---

## Part C — Make the browser report to Sentry

**C1. Set the client DSN (env, build-time).** On the Railway `langfuse-web` service, set `NEXT_PUBLIC_SENTRY_DSN` (and optionally `NEXT_PUBLIC_SENTRY_ENVIRONMENT=production`, `NEXT_PUBLIC_BUILD_ID`). These are **inlined at build time** by Next.js — a rebuild is required for them to take effect. Use the same Sentry project/DSN as the server or a dedicated frontend project.

**C2. Stop swallowing mutation errors.** In `web/src/features/conversations/conversation-view/MessageScores.tsx`, the catches at ~line 184/215/274 do `console.error(...)` only. Add `Sentry.captureException(error)` (keep the console for local dev) so a failed save/delete is reported. Scope this to the conversation feature's mutation handlers; a broader audit of swallowed `console.error` catches is a follow-up.

### Part C acceptance
- With `NEXT_PUBLIC_SENTRY_DSN` set and deployed, force a client-side failure → a Sentry issue appears for the **browser** with a stack. (There's an existing helper page `web/src/pages/test-sentry-client.tsx` that reports whether the client DSN is configured — use it to verify.)

---

## Files to touch
- `.github/workflows/typecheck.yml` (new)
- `web/Dockerfile`, `worker/Dockerfile` (optional A3; coordinate with the Docker-builder plan)
- `web/src/server/api/trpc.ts` (Part B)
- `web/src/features/conversations/conversation-view/MessageScores.tsx` (Part C2)
- Railway dashboard: "Wait for CI" on web+worker (A2); `NEXT_PUBLIC_SENTRY_DSN` on web (C1) — document, not code

## Out of scope
- Flipping `ignoreBuildErrors`/`ignoreDuringBuilds` to `false`.
- Repo-wide audit of swallowed `console.error` catches (separate follow-up).
- Adding tests for the conversations feature (separate plan/follow-up — but highly recommended).

## Priority
A1+A2 first (prevents this exact class of bug from shipping). Then B. Then C.
