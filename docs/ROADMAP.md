# Roadmap

The first release gate is real end-to-end execution qualification, not additional dashboard pages.

1. Run the real-host release gates; fix runtime compilation budgets and cache layout; strengthen exact output decoding, measured resource accounting, SSE terminal reconciliation/reconnect, and cleanup failure observability.
2. Separate mail/webhook workers; add structured service log correlation, per-user/key/project rate budgets, tenant concurrency plans, and live fleet/queue event streams.
3. Add digest/version snapshots at admission, safe immutable compilation artifacts, object-storage artifacts with file-count/MIME/size/download policies.
4. Add challenge editing/publishing UI, language restrictions, tags/templates, richer per-test/group scoring, versioned immutable test snapshots, and runtime-aware leaderboards.
5. Add full platform administrator operations, role/member management, runtime toggles, session UI, password login protection, and advanced percentile/throughput analytics.
6. Implement authenticated interview rooms with WebSocket collaboration and server-separated private notes; design the collaboration adapter for eventual CRDT replacement.
7. Add isolated education module: courses, assignments, deadlines, attempt limits, automatic grades, audited overrides, CSV export.
8. Add SQL/interactive judge backends, gVisor or Firecracker isolation, Kubernetes/Nomad/remote pools, and optional reviewed network policies.
