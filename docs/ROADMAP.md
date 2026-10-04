# Roadmap

The execution foundation now has real eight-language and two-worker failure-injection evidence in VERIFICATION.md. Remaining release gates and product work are explicit below.

1. Qualify the deployment host and extended Redis outages/data loss and load behavior; strengthen measured resource accounting and browser reconnect/backoff behavior. Durable SSE terminal reconciliation and structured sandbox cleanup-failure logging are implemented; they still require target-host qualification.
2. Broaden load qualification for control-plane operations. Structured cross-service submission correlation, replayable live fleet/queue SSE streams, dedicated mail/webhook delivery, per-user/API-key/project submission budgets, and scheduler-enforced tenant concurrency plans are implemented.
3. The immutable compilation cache/object-storage foundation is implemented: generated-file capture policies, file-count limits, MIME inspection, runtime content-ID snapshots, SHA-256 cache verification, compile-log artifacts, bounded authorized downloads, authenticated artifact browsing, Java multi-output caching, retention/garbage collection, and MinIO/S3-compatible storage.
4. Challenge authoring and scoring are implemented: authenticated create/edit flows, draft publication boundaries, language restrictions, tags, protected test editing, reusable project templates, revision history, publish/archive actions, runtime-aware leaderboards, weighted per-test scoring, immutable scoring strategy snapshots, and all-or-nothing grouped scoring with integration evidence.
5. Platform administration is in progress. Session metadata, active-session UI, per-session revocation, current-session logout, logout-all, refresh rotation, password-failure lockout, generic login errors, and integration evidence are implemented. Remaining work: full administrator operations, role/member management, runtime toggles, and advanced percentile/throughput analytics.
6. Implement authenticated interview rooms with WebSocket collaboration and server-separated private notes; design the collaboration adapter for eventual CRDT replacement.
7. Add isolated education module: courses, assignments, deadlines, attempt limits, automatic grades, audited overrides, CSV export.
8. Add SQL/interactive judge backends, gVisor or Firecracker isolation, Kubernetes/Nomad/remote pools, and optional reviewed network policies.
