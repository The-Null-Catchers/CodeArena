# Verification record

## Local environment

Node 24.19.0; pnpm through Corepack; Linux execution environment. Docker executable/socket unavailable. PostgreSQL binaries were present, but process user/group changes needed to initialize a non-root server were prohibited. No sandbox execution, live database/API integration, or full run/submit browser flow was certified in this environment.

Completed on 2026-09-30:

- 30 unit tests passed: judges, state machine, runtime registry, scheduling, quota/roles/priority, container policy, bounded UTF-8 output, webhook signing/URL/encryption.
- ESLint passed.
- API/worker/scheduler and Next.js TypeScript checks passed.
- Production builds passed for backend services, web, and TypeScript SDK/CLI.
- Compose and GitHub Actions YAML parsed successfully.

Not run: Docker builds/Compose startup, live PostgreSQL/Redis API integration, sandbox security tests, full browser E2E, remote GitHub CI. Chromium was absent, so no screenshots or browser verification are claimed. CI defines actual Docker-based integration, security, and Playwright execution tests; a workflow definition is not evidence that CI has passed.

## Required release gates

1. `pnpm install --frozen-lockfile`, lint, typecheck, unit tests, production build.
2. Build all eight runtime images on a patched dedicated Linux Docker host.
3. Start Compose, migrate/seed, confirm all services ready.
4. Run `pnpm test:security` against real containers: identity/filesystem/secrets/network/PID/memory/output/timeouts/cancellation/cleanup.
5. Run `pnpm test:integration` and `pnpm test:e2e` against the actual stack.
6. Qualify each compiled language, compile errors, UTF-8 output, workspace exhaustion, worker crash/retry, Redis reconnects, worker drain, concurrent tenant quotas, and webhook delivery/replay.
7. Run at least two workers with unique IDs, prove no overbooking and stale-attempt write protection.
8. Configure protected main branch and require green CI in the actual GitHub repository. Branch protection cannot be established by this source archive alone.

## Acceptance mapping

| Requested behavior                        | Implementation                               | Local execution evidence                         |
| ----------------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| Register/login/authentication             | API and UI present                           | Build/typecheck; live integration pending        |
| Monaco playground/runtime selection       | UI present, eight definitions                | Build/typecheck; browser execution pending       |
| Queue/scheduler/worker/container          | Durable DB admission + BullMQ dispatch       | Logic/policy tests; Docker pending               |
| Realtime output and persisted result      | Redis Streams/SSE + DB finalization          | Full stack pending                               |
| Timeout/memory/PIDs/output/network limits | Docker policy + watchdogs                    | Policy tests; hostile-program tests pending      |
| Challenge/hidden tests/verdict/history    | Protected weighted judging and APIs          | Judge tests; full stack pending                  |
| Cancellation                              | Redis signal + persisted flag + kill         | Docker/API pending                               |
| Multiple workers/heartbeat/health/drain   | Capacity/leases/attempt fencing              | Scheduler tests; failure injection pending       |
| Scoped keys/quotas/rate limiting          | Hashes, scopes, project locks, Redis limiter | Typecheck; integration pending                   |
| Signed webhooks/retries                   | Encryption/HMAC/DNS pinning/outbox           | Signature/URL/encryption tests; delivery pending |
| Worker/queue inspection                   | API-backed console                           | Build; live-data pending                         |
| Prometheus/Grafana                        | Endpoints and provisioning                   | Configuration present; stack pending             |
| Compose/CI/docs                           | Files and workflows present                  | Builds pass; Compose/remote CI pending           |

No mocked execution results are presented as completed functionality. Later product modules are listed separately in ROADMAP.md.
