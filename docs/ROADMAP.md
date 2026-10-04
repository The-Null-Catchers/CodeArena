# Roadmap

The execution foundation now has real eight-language and two-worker failure-injection evidence in VERIFICATION.md. Remaining release gates and product work are explicit below.

1. Qualify the deployment host and extended Redis outages/data loss and load behavior; strengthen measured resource accounting and browser reconnect/backoff behavior. Durable SSE terminal reconciliation and structured sandbox cleanup-failure logging are implemented; they still require target-host qualification.
2. Broaden load qualification for control-plane operations. Structured cross-service submission correlation, replayable live fleet/queue SSE streams, dedicated mail/webhook delivery, per-user/API-key/project submission budgets, and scheduler-enforced tenant concurrency plans are implemented.
3. Extend the implemented immutable compilation cache/object-storage foundation with generated-file capture policies, file-count and MIME inspection. Runtime content-ID snapshots, SHA-256 cache verification, compile-log artifacts, bounded authorized downloads, authenticated artifact browsing, Java multi-output caching, retention/garbage collection, and MinIO/S3-compatible storage are implemented.
4. Complete challenge authoring UI and richer per-test/group scoring. Revision-aware editing/publishing APIs, draft publication boundaries, language restriction editing, tags, reusable project templates, revision history, and runtime-aware leaderboards are implemented.
5. Add full platform administrator operations, role/member management, runtime toggles, session UI, password login protection, and advanced percentile/throughput analytics.
6. Implement authenticated interview rooms with WebSocket collaboration and server-separated private notes; design the collaboration adapter for eventual CRDT replacement.
7. Add isolated education module: courses, assignments, deadlines, attempt limits, automatic grades, audited overrides, CSV export.
8. Add SQL/interactive judge backends, gVisor or Firecracker isolation, Kubernetes/Nomad/remote pools, and optional reviewed network policies.
