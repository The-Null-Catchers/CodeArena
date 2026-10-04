# Platform administrator operations

CodeArena separates tenant administration from platform administration.

Organization `owner` and `admin` roles can manage their own organization, but they cannot change global runtime availability. Global runtime controls require `users.platform_admin = true`.

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

API keys and organization roles alone cannot access these global administration endpoints.
