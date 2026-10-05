# Platform administrator operations

CodeArena separates tenant administration from platform administration.

Organization `owner` and `admin` roles can manage their own organization, but they cannot change global runtime availability or platform-wide user state. Global controls require `users.platform_admin = true`.

## Bootstrap a platform administrator

There is intentionally no HTTP endpoint that grants platform-administrator privileges. Bootstrap the first administrator from a trusted database session:

```sql
UPDATE users
SET platform_admin = true
WHERE email = 'operator@example.com';
```

Revoke the capability the same way:

```sql
UPDATE users
SET platform_admin = false
WHERE email = 'operator@example.com';
```

After changing the flag, the user's existing authenticated session may continue to be used; platform-admin authorization is checked against the database on every administrative request.

## Runtime controls

Platform administrators can use the Runtime Registry in the console or:

- `GET /v1/admin/runtimes` to inspect runtime state and change metadata.
- `PATCH /v1/admin/runtimes/:id` with `{ "enabled": false }` or `{ "enabled": true }` to change admission state.

Every runtime change records an audit event and the user that last changed the runtime.

Disabling a runtime prevents **new submissions** from being admitted through the existing runtime-enabled check. It does not terminate submissions that are already running, compiling, queued with an immutable runtime snapshot, or otherwise in flight.

## Platform execution analytics

The Platform analytics console and `GET /v1/admin/analytics?hours=<1-168>` expose platform-wide execution evidence from persisted submissions, results, and usage records. This includes throughput, accepted/failure rates, CPU and wall-time percentiles, hourly volume, runtime hotspots, and project hotspots.

The analytics endpoint is intentionally restricted to platform administrators because it crosses tenant boundaries.

## Platform user controls

The Platform users console supports account search and status filtering. Equivalent API operations are:

- `GET /v1/admin/users?q=<email>&status=all|active|disabled&limit=<n>&offset=<n>`
- `PATCH /v1/admin/users/:id` with `{ "disabled": true }` or `{ "disabled": false }`

Disabling an account is transactional with revocation of all active sessions and an audit event. Re-enabling the account does **not** restore revoked sessions; the user must authenticate again.

A platform administrator cannot disable its own current account through the API. CodeArena also rejects attempts that would disable the last active platform administrator.

API keys and organization roles alone cannot access global administration endpoints.
