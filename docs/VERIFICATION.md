# Verification record

## Verified Redis recovery

Bounded Redis commands, independent BullMQ worker connections, database cancellation polling, atomic stream retention and a dedicated SSE deadline are implemented. New real-Redis probes cover successful publication, an open connection whose server stops responding, and reconnect after offline rejection. A live two-worker fleet scenario stops the Compose broker during execution, checks completion/cancellation and a retained dispatch outbox, then checks resumption without worker restarts, single completion, usage records and sandbox cleanup.

GitHub Actions run [36751926401](https://github.com/The-Null-Catchers/CodeArena/actions/runs/36751926401), commit `1ff4ec421c6eb0856173f93ab8c0474dfd42e9d4`, passed all three jobs, including the live Redis outage scenario and three dedicated Redis probes. Total: **77 tests passed** (30 unit, 12 sandbox security, 28 integration, one Chromium, three fleet, three Redis). Extended outages, Redis data loss and sustained load remain separate release gates.

## Verified execution evidence

GitHub Actions run [36735179122](https://github.com/The-Null-Catchers/CodeArena/actions/runs/36735179122), commit `6e49aae39a3b919c1c9943d2b4f18cc18c45ea3e`, completed successfully on 2026-09-30:

- 30 unit tests, ESLint, backend/web TypeScript checks, production builds, SDK/CLI build, and backend/web Docker builds.
- All eight runtime images built successfully.
- Core Compose services started: PostgreSQL, Redis, migrations/seed, mail, API, scheduler, worker, and web.
- 12 real Docker security tests passed: non-root identity, filesystem read-only/space quota, secret exclusion, network isolation, process/memory/output/time limits, bounded UTF-8 output, cancellation and cleanup.
- 28 API/integration tests passed: real execution of Python, JavaScript, TypeScript, C, C++, Java, Go and Rust under default limits; compilation-error persistence for all six compiled languages; hidden-test protection; scoped keys; concurrent quotas; refresh rotation; cancellation; hard-limit validation.
- One Chromium E2E passed: register, challenge, Monaco source, real run/output, submission judging, verdict and submission details.
- Two live fleet tests passed with separate worker IDs and one slot each: distributed execution without slot overbooking, abrupt worker termination, lease expiry, recovery on the surviving worker, stale-attempt transition rejection while the new attempt is running, one final result, and cleanup of abandoned sandboxes after restart.

Total: **73 tests passed**. This evidence qualifies these concrete cases on the CI Docker host; it does not replace target-host qualification, load testing or a security assessment.

## Local environment

Node 24.19.0; pnpm through Corepack. Docker executable/socket unavailable locally; live Docker, database/API and browser evidence above comes from GitHub Actions rather than this workspace. Local unit tests, lint, typechecks and production builds passed.

## Limits of this evidence

Full Compose infrastructure smoke checks also passed in run [36735179122](https://github.com/The-Null-Catchers/CodeArena/actions/runs/36735179122), commit `6e49aae39a3b919c1c9943d2b4f18cc18c45ea3e`: the pinned MinIO source image built; all Compose services started; API readiness through Caddy, Prometheus readiness, Grafana database health and MinIO readiness returned successfully. This verifies startup/readiness, not an artifact API or monitoring load behavior.

Extended Redis outages/data loss, sustained load and deployment-host qualification remain pending. One earlier matrix run hit a Docker setup timeout on a Rust compilation-error case; a later complete run passed. Sandbox phase/correlation logging was added, and extended soak testing remains a release gate. No production deployment or protected-main policy is claimed. Later product modules remain in ROADMAP.md.

## Required release gates

1. `pnpm install --frozen-lockfile`, lint, typecheck, unit tests, production build.
2. Build all eight runtime images on a patched dedicated Linux Docker host.
3. Start Compose, migrate/seed, confirm all services ready.
4. Run `pnpm test:security` against real containers: identity/filesystem/secrets/network/PID/memory/output/timeouts/cancellation/cleanup.
5. Run `pnpm test:integration` and `pnpm test:e2e` against the actual stack.
6. Qualify each compiled language, compile errors, UTF-8 output, workspace exhaustion, worker crash/retry, Redis reconnects, worker drain, concurrent tenant quotas, and webhook delivery/replay.
7. Run at least two workers with unique IDs, prove no overbooking and stale-attempt write protection.
8. Configure protected main branch and require green CI in the actual GitHub repository. Branch protection cannot be established by this source archive alone.

No mocked execution results are presented as completed functionality. Validation claims above are scoped to actual successful workflow runs, not workflow definitions.
