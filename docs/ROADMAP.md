# Roadmap

The execution foundation now has real eight-language and two-worker failure-injection evidence in VERIFICATION.md. Remaining release gates and product work are explicit below.

1. Qualify the deployment host and extended Redis outages/data loss and load behavior; strengthen measured resource accounting and browser reconnect/backoff behavior. Durable SSE terminal reconciliation and structured sandbox cleanup-failure logging are implemented; they still require target-host qualification.
2. Add structured service log correlation and live fleet/queue event streams. Mail/webhook delivery is separated into a dedicated health-checked/metrics-enabled delivery worker; per-user/API-key/project submission budgets and scheduler-enforced tenant concurrency plans are implemented and require broader load qualification.
3. Extend the implemented immutable compilation cache/object-storage foundation with generated-file capture policies, file-count and MIME inspection, retention/garbage collection, Java multi-output caching, and broader artifact UI. Runtime content-ID snapshots, SHA-256 cache verification, compile-log artifacts, bounded authorized downloads, and MinIO/S3-compatible storage are implemented.
4. Add challenge editing/publishing UI, language restriction UI, tags/templates, richer per-test/group scoring, challenge revision management and runtime-aware leaderboards.
5. Add full platform administrator operations, role/member management, runtime toggles, session UI, password login protection, and advanced percentile/throughput analytics.
6. Implement authenticated interview rooms with WebSocket collaboration and server-separated private notes; design the collaboration adapter for eventual CRDT replacement.
7. Add isolated education module: courses, assignments, deadlines, attempt limits, automatic grades, audited overrides, CSV export.
8. Add SQL/interactive judge backends, gVisor or Firecracker isolation, Kubernetes/Nomad/remote pools, and optional reviewed network policies.
