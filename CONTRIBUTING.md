# Contributing

Use Node 22+ and pinned pnpm, install with the lockfile, and work on a feature branch. Keep domain policy explicit and testable. Do not bypass sandbox limits to make tests pass, accept arbitrary runtime images, log credentials, or add API-process execution fallbacks.

Before review, run lint, typecheck, unit tests, build, and the integration/security/E2E checks relevant to your change. Sandbox changes require actual Docker evidence. Explain the problem, behavior change, testing, and deployment implications in the PR. SQL migrations must be forward-compatible with rolling service updates where feasible.

Do not commit `.env`, source submission data, private tests, API keys, tokens, runtime artifacts, or generated dependency/build directories.
