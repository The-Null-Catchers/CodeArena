# Self-hosting and operations

## Development stack

Build language images before starting worker services. Compose starts PostgreSQL, Redis, migration/seed, API, scheduler, worker, web, MinIO, Mailpit, Caddy, Prometheus, and Grafana. Persistent named volumes preserve database, Redis, monitoring, and future object-storage data. Redis uses noeviction so BullMQ state is not silently evicted. Redis capacity/exhaustion requires monitoring.

Database/Redis/web/API/monitoring ports bind to localhost by default; only Caddy :8080 is exposed. Set exact WEB_ORIGIN/NEXT_PUBLIC_API_URL for the actual browser origin; changing a Next public environment value requires a rebuild. Development Caddy serves HTTP. For production use a real hostname and TLS, restrict /metrics and admin dependencies, and close direct service ports.

`.env.example` contains development-only values. Generate independent random secrets. WEBHOOK_ENCRYPTION_KEY must be 64 hex characters. Back up this key securely; losing it prevents stored webhook/mail secrets from decrypting. Changing it requires an explicit re-encryption migration.

## Worker pools

A worker identity is unique and stable for its host. Do not `docker compose --scale worker=2` with the hardcoded worker-01 identity. Use a second service or host with unique WORKER_ID and its own Docker daemon/runtime images:

```bash
docker compose -f docker-compose.yml -f docker-compose.workers.yml up -d --build
pnpm test:fleet
```

The included override uses worker-01 and worker-02 with one slot each. The fleet test requires this override, real PostgreSQL/Redis, and a Docker host; it kills a trusted worker and verifies lease recovery and abandoned-container cleanup. Never run destructive failure injection against a production fleet.

Worker slots reserve 512 MiB per slot plus 512 MiB headroom; WORKER_MEMORY_MB must reflect host capacity, not merely an advertised number. Multiple workers on one Docker host require accounting for their combined reservations. Host operators are responsible for aggregate host limits.

Workers detect installed images and register supported runtime IDs. Disable unavailable versions operationally rather than leaving jobs waiting forever. Map RUNTIME_IMAGE_* to reviewed immutable image digests in production. Submitter-selected images are not accepted.

## Drain and shutdown

Drain via platform admin API or SIGTERM. Scheduler skips draining/offline/stale workers. Claims recheck worker status. Workers finish active jobs, then abort after a 20-second grace deadline and remove containers. Compose allows 35 seconds for shutdown. Heartbeat loss interrupts assignments, bounded retries requeue them, and attempt fencing rejects stale final writes.

After a host crash, runtime container leftovers are reaped at next worker startup under the same identity. If a host remains unreachable, stop/reconcile its daemon before recycling its identity. Do not delete arbitrary containers: managed cleanup filters platform and worker labels.

## Monitoring

Prometheus scrapes API, scheduler, and worker metrics. Grafana provisioning supplies execution/API/queue/worker dashboards. Current measurements cover API route latency/status, active slots, execution duration and pending queue depth, plus process defaults. Fine-grained DB/Redis latency, launch failure counters, host CPU/RAM, and full p50/p95/p99 analytics are roadmap work.

Inspect readiness for dependencies, worker runtime availability, queue backlog, stale heartbeats, dead-letter webhooks, and mail outbox. Do not interpret a live HTTP process as a ready execution fleet.

## Backups

Back up PostgreSQL, encrypted-secret key material, and configuration. Test restore on an isolated environment. Migrations use an advisory lock and schema_migrations table. No destructive automatic migration rollback is supplied. Preserve audit logs and minimize access to source and private tests. Apply retention policies explicitly rather than deleting active submissions.

## Release process

Run all gates in VERIFICATION.md, build immutable images, review dependencies, configure main branch protection, and stage a real multi-worker deployment. The repository runs real execution CI on GitHub. Current qualified runs are recorded in VERIFICATION.md; no production deployment or branch protection is claimed.

## Object-store image provenance

MinIO is built locally from upstream commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a` (RELEASE.2025-10-15T17-29-55Z), with source identity verified during the build. Its upstream AGPL license is included in the image. This removes reliance on unavailable Docker Hub images. Review upstream licensing before redistribution. Core execution CI starts the services required for execution. A separate infrastructure-smoke job builds this image and starts the full Compose stack, checking API readiness through Caddy, Prometheus, Grafana and MinIO. Object storage remains unused by application artifacts until an artifact API is implemented.
