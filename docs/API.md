# Developer API

## Authentication and sessions

Use `Authorization: Bearer <access-token-or-api-key>`. Registration/login return a 15-minute access JWT and a 30-day refresh secret. Refresh rotates the database session and rejects old token reuse. Logout revokes all sessions for that user. The web client currently requires another login when its access token expires; automatic refresh is a planned improvement.

| Method | Path                     | Body / purpose                                                    |
| ------ | ------------------------ | ----------------------------------------------------------------- |
| POST   | /v1/auth/register        | email, password (12–128 characters); creates organization/project |
| POST   | /v1/auth/login           | email, password                                                   |
| POST   | /v1/auth/refresh         | refreshToken                                                      |
| POST   | /v1/auth/logout          | revoke user sessions                                              |
| POST   | /v1/auth/forgot-password | email; generic response regardless of existence                   |
| POST   | /v1/auth/reset-password  | token, password; revokes existing sessions                        |
| POST   | /v1/auth/verify-email    | one-use token                                                     |

Verification/reset messages use the transactional encrypted mail outbox. Configure SMTP on the scheduler. Mailpit captures local messages.

## Runtimes

`GET /v1/runtimes` lists configured enabled status. A worker separately advertises installed images; an enabled runtime without an available worker leaves submissions queued.

| Language ID | Version | Source    |
| ----------- | ------- | --------- |
| python      | 3.13    | main.py   |
| javascript  | 22      | main.js   |
| typescript  | 5.8     | main.ts   |
| java        | 21      | Main.java |
| c           | 14      | main.c    |
| cpp         | 14      | main.cpp  |
| go          | 1.24    | main.go   |
| rust        | 1.85    | main.rs   |

Java must supply `public class Main`. User package downloads are unavailable; all runtime networking is disabled. Additional versions must be added centrally, built, seeded, and qualified. TypeScript means the compiler version; its execution image uses Node 22.

## Submission endpoints

`POST /v1/submissions` requires projectId, language, version, source. Optional stdin, mode (`run` or `challenge`), challengeId, limits, priority (`low`, `normal`, `high`, `system`). Project plans cap priority; normal is the initial maximum. Source/stdin strings cap at 65,536 characters and the API body caps at 160 KiB.

`GET /v1/submissions?projectId=UUID&before=ISO_DATE` lists at most 50 results. `GET /v1/submissions/:id` returns source, result, event timeline, and protected test summaries. `POST /v1/submissions/:id/cancel` is idempotent; running jobs settle asynchronously. `POST /v1/submissions/batch` takes an array of 1–10 ordinary submission bodies and returns individual outcomes.

`GET /v1/submissions/:id/events` is SSE with authorization and Last-Event-ID support. Event kinds: snapshot, state, output. Output records contain kind and text. Final output resides in the submission result; retained Redis output is bounded and expires after one hour. A snapshot allows terminal status recovery, and callers fetch the final result upon any terminal state.

Limits are validated server-side. Invalid/excessive values are rejected rather than silently allowing unlimited execution. Project daily/outstanding quota violations return 429.

## Challenges, drafts and projects

Public challenge list/detail: `GET /v1/challenges` and `/v1/challenges/:slug`. Detail returns public samples only.

`POST /v1/challenges` requires `challenges:write`: projectId, title, slug, description, difficulty, visibility, judge, tests. Tests contain stdin, expected, hidden, weight, optional wallTimeMs/memoryMb/group. Publishing is atomic and audited. Maximum 100 tests, each input/output at most 65,536 characters, subject to total request size. Hidden fields are not included in the creation response.

Judges: exact, whitespace, case_insensitive, float. Float uses finite numeric tokens with combined absolute/relative tolerance of 1e-6. Each challenge runs both sample and hidden tests. Every test gets a new isolated workspace; output is suppressed for all challenge tests to prevent malicious solutions echoing private data.

`PUT /v1/drafts/:challengeId` takes runtimeId/source and upserts an authenticated user's draft. `GET` returns that user's drafts. The browser also autosaves locally.

`GET /v1/projects` resolves memberships. `POST /v1/projects` accepts organizationId/name and requires owner/admin membership.

## API keys

Create with `POST /v1/api-keys`: projectId, name, scopes, optional expiresAt. Owner/admin user sessions are required for creation/list/revoke. The secret is returned once as `ca_live_...`; only its hash is stored. Revoke with `DELETE /v1/api-keys/:id`; rotation currently means create replacement, migrate callers, revoke old key.

Scopes: submissions:create, submissions:read, challenges:read, challenges:write, analytics:read, workers:read. Public challenge reads need no key. Global worker inspection currently requires organization owner/admin; API-key worker inspection is not yet supported.

## Observability and operations

`GET /v1/usage?projectId=UUID`, `/v1/queue?projectId=UUID`, `/v1/workers?projectId=UUID` return real project usage or authorized operational views. Worker drain is `POST /v1/workers/:id/drain` and additionally requires a PLATFORM_ADMIN_IDS user. `/health`, `/health/live`, `/health/ready`, `/metrics` expose service health/metrics. Keep metrics private through proxy/firewall policy.

## Webhooks

Create/list endpoints at `/v1/webhooks`. Creation body: projectId, HTTPS url. Only WEBHOOK_ALLOWED_HOSTS hostnames are accepted. The signing secret is returned once. Delivery history: `/v1/webhooks/:id/deliveries`; manual retry: `POST /v1/webhook-deliveries/:id/redeliver`.

Events include submission.queued, submission.started, submission.completed, submission.failed, submission.cancelled, submission.timed_out. Signature headers:

- x-codearena-event-id
- x-codearena-timestamp (Unix seconds)
- x-codearena-signature: v1=HEX

Verify the **raw request body bytes**, before JSON reserialization. Reject timestamps older than five minutes or unreasonably far in the future; deduplicate IDs using durable storage, then perform business work. Compare signatures in constant time:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(
  secret: string,
  id: string,
  timestamp: string,
  raw: Buffer,
  header: string,
) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300)
    return false;
  const expected = createHmac("sha256", secret)
    .update(`${id}.${timestamp}.`)
    .update(raw)
    .digest();
  if (!/^v1=[0-9a-f]{64}$/.test(header)) return false;
  const supplied = Buffer.from(header.slice(3), "hex");
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
```

Eight bounded exponential attempts end in dead_letter. Deliveries are at least once; a timeout after recipient acceptance can lead to another POST. No redirect following or private-network delivery is supported.

## Error model

```json
{
  "error": {
    "code": "SUBMISSION_LIMIT_EXCEEDED",
    "message": "Submission limit exceeded",
    "requestId": "UUID"
  }
}
```

400 validation/runtime errors; 401 authentication; 403 permission/plan; 404 absent or unavailable resource; 409 conflict; 429 rate/quota; 500 generic internal failure. Production responses do not return stack traces.

## SDK and CLI

The TypeScript SDK supports create/get/cancel/wait and runtime list. Wait uses SSE with a timeout; no database polling. It currently returns loosely typed API envelopes; richer generated response typing is planned.

CLI examples:

```bash
export CODEARENA_API_KEY='ca_live_...'
export CODEARENA_PROJECT_ID='PROJECT_UUID'
node packages/execution-sdk/dist/cli.js login
node packages/execution-sdk/dist/cli.js run main.py
node packages/execution-sdk/dist/cli.js submit reverse-string main.cpp
node packages/execution-sdk/dist/cli.js runtimes list
node packages/execution-sdk/dist/cli.js submissions get SUBMISSION_UUID
```

CODEARENA_API_URL and CODEARENA_STDIN are optional. Login saves local config with restricted permissions. Do not include credentials in command history or commit the configuration.
