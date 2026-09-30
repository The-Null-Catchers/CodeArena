# Security model

CodeArena treats all submitted code as hostile. This repository is not a sandbox security certification. Run every execution/security regression on the actual host, review images and dependencies, and isolate worker infrastructure before exposing it to strangers.

## Enforced controls

- API and scheduler never execute submitted programs.
- Runtime UID/GID 65532, dropped capabilities, no-new-privileges, no privileged mode, no host PID/network namespace, no host bind mounts or Docker socket.
- Read-only image filesystem; separately bounded tmpfs workspace (exec for compiled binaries, nosuid/nodev) and /tmp (noexec/nosuid/nodev); bounded shared memory and file descriptors; core dumps disabled.
- No runtime internet access, platform-service networking, user images, injected platform secrets, or user environment overrides.
- Cgroup memory and swap ceilings, PID ceiling, one-CPU scheduling quota, CPU rlimit, sampled aggregate CPU budget, wall deadline, combined output cap.
- Docker default seccomp remains active. Workers fail startup if Docker does not advertise seccomp and critical cgroup constraints. AppArmor may be explicitly configured with SANDBOX_APPARMOR.
- Container removal in finally paths, startup/shutdown reaping, bounded assignment retries, attempt-fenced finalization.
- Project authorization, hashed API/refresh tokens, Argon2id passwords, rotating sessions, bounded inputs, transactional quotas, request rate limiting, append-oriented audit writes.
- Challenge-run stdout/stderr is neither streamed nor returned, and hidden stdin/expected output is excluded from standard responses. Test metadata includes verdict/position/visibility only.
- HTTPS allowlisted webhooks validate public DNS results, pin the selected address, disable redirects, sign exact bytes, and encrypt stored signing secrets.

## Trust boundaries and limitations

The trusted worker's Docker socket grants host-level control. Run it on a dedicated hardened execution VM/host; do not assume the worker service container limits protect the Docker host. Runtime containers share the host kernel. Kernel/runtime vulnerabilities remain possible. Use patched Linux/Docker, reviewed digest-pinned images, a constrained worker pool, least-privilege control-plane database credentials, host firewall rules, and security updates. gVisor/Firecracker backends would strengthen the boundary but are not included.

No custom seccomp profile is included; Docker's maintained default is used. Install and test any requested AppArmor profile yourself. AppArmor absence is not silently claimed as enforcement.

CPU sampling can overshoot by a sampling interval or Docker response delay; CPU rlimits are per-process and rounded to seconds. Reported CPU/peak memory are approximate, especially for short jobs. Container exec OOM classification may return runtime_error rather than memory_limit_exceeded, while the memory cgroup still bounds allocation. Stream reconnection merits further hardening. Output collection caps both raw and UTF-8-normalized bytes and preserves split characters. Go uses trusted, prebuilt standard-library archives in the read-only image; each job compiles and links its own main file inside its bounded private workspace. Only a single source file and the standard library are supported in v1; third-party modules, cgo and embed attachments are not supported. This image cache contains no submitted source or writable shared build directory. Qualify every runtime on the target host; typechecking and image builds alone are insufficient.

The public playground UI requires authentication to create jobs; anonymous execution admission is deliberately not implemented. Email verification links exist, but verification is not currently an execution gate. Session tokens are stored in sessionStorage by the web client; switch to appropriately secured HttpOnly-cookie sessions for a hardened public browser deployment. Webhooks are at least once; recipient deduplication and replay checks are required.

MinIO is provisioned for future artifacts. No artifact upload/download implementation or compilation cache should be inferred. Do not change registry images or runtime versions without requalifying their security and compatibility.

## Reporting

Report vulnerabilities privately to the repository maintainer via a private security advisory where available. Include version, host/runtime details, reproduction, and impact. Do not include live keys, passwords, sensitive test data, or attacks against production users.

Primary references: https://docs.docker.com/engine/security/ , https://docs.docker.com/engine/security/seccomp/ , https://docs.docker.com/engine/containers/resource_constraints/ .
