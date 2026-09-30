# Verification record

## Verified execution evidence

GitHub Actions run [36731508386](https://github.com/The-Null-Catchers/CodeArena/actions/runs/36731508386), main commit `21a1b79e85b57af8137eef798f6b4f800afd0932`, completed successfully on 2026-09-30:

- 30 unit tests, ESLint, backend/web TypeScript checks, production builds, SDK/CLI build, and backend/web Docker builds.
- All eight runtime images built successfully.
- Core Compose services started: PostgreSQL, Redis, migrations/seed, mail, API, scheduler, worker, and web.
- 10 real Docker security tests passed: non-root identity, filesystem, secret exclusion, network isolation, process/memory/output/time limits, cancellation and cleanup.
- 14 API/integration tests passed, including real Python execution, hidden-test protection, scoped keys and hard-limit validation.
- One Chromium E2E passed: register, challenge, Monaco source, real run/output, submission judging, verdict and submission details. The execution-evidence artifact contains a real playground screenshot.

This run qualifies the Python execution vertical slice. Building the other seven runtime images does not establish that their compilers and programs execute within resource limits. A subsequent runtime matrix is required before claiming those languages qualified.

## Local environment

Node 24.19.0; pnpm through Corepack. Docker executable/socket unavailable locally; live Docker, database/API and browser evidence above comes from GitHub Actions rather than this workspace. Local unit tests, lint, typechecks and production builds passed.

## Limits of this evidence

MinIO's source build, the full monitoring/proxy/object-store Compose stack, multiple-worker crash/retry and Redis reconnect recovery have not yet been qualified. No production deployment or protected-main policy is claimed. Later product modules remain in ROADMAP.md.

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
