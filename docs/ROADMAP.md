# Roadmap

The execution foundation now has real eight-language and two-worker failure-injection evidence in VERIFICATION.md. Remaining release gates and product work are explicit below.

1. Qualify the deployment host and extended Redis outages/data loss and load behavior; strengthen measured resource accounting and browser reconnect/backoff behavior. Durable SSE terminal reconciliation and structured sandbox cleanup-failure logging are implemented; they still require target-host qualification.
2. Broaden load qualification for control-plane operations. Structured cross-service submission correlation, replayable live fleet/queue SSE streams, dedicated mail/webhook delivery, per-user/API-key/project submission budgets, and scheduler-enforced tenant concurrency plans are implemented.
3. The immutable compilation cache/object-storage foundation is implemented: runtime content-ID snapshots, SHA-256 cache verification, compile-log artifacts, bounded authorized downloads, authenticated artifact browsing, Java multi-output caching, generated-file capture policies, file-count/size enforcement, content-based MIME inspection, retention/garbage collection, usage accounting, and MinIO/S3-compatible storage.
4. Add challenge editing/publishing UI, language restriction UI, tags/templates, richer per-test/group scoring, challenge revision management and runtime-aware leaderboards.
5. Add full platform administrator operations, role/member management, runtime toggles, session UI, password login protection, and advanced percentile/throughput analytics.
6. Implement authenticated interview rooms with WebSocket collaboration and server-separated private notes; design the collaboration adapter for eventual CRDT replacement.
7. Add isolated education module: courses, assignments, deadlines, attempt limits, automatic grades, audited overrides, CSV export.
8. Add SQL/interactive judge backends, gVisor or Firecracker isolation, Kubernetes/Nomad/remote pools, and optional reviewed network policies.
