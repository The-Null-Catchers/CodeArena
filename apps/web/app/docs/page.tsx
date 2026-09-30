import Link from "next/link";
export default function Page() {
  return (
    <>
      <header className="topnav">
        <Link href="/" className="brand">
          <b className="brand-mark">↳</b>codearena
        </Link>
        <Link className="button" href="/console/playground">
          Open console ↗
        </Link>
      </header>
      <main className="section" style={{ maxWidth: 900 }}>
        <div className="label">Developer documentation</div>
        <h1 style={{ fontSize: 46 }}>Execution, as an API.</h1>
        <p className="muted">
          Create a workspace, generate a scoped API key, and submit source code.
          The API never executes code in its own process.
        </p>
        <h2>Quick start</h2>
        <pre className="panel code">{`curl -X POST http://localhost:4000/v1/submissions \\\n  -H "Authorization: Bearer $CODEARENA_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '{"projectId":"YOUR_PROJECT_UUID",\n       "language":"python","version":"3.13",\n       "source":"print(input())","stdin":"hello"}'`}</pre>
        <h2>Watch an execution</h2>
        <pre className="panel code">{`curl -N -H "Authorization: Bearer $CODEARENA_API_KEY" \\\n  http://localhost:4000/v1/submissions/SUBMISSION_UUID/events`}</pre>
        <p className="muted">
          Events: snapshot, state, output. Redis Streams retain a bounded replay
          window. The final result remains in PostgreSQL. Use GET
          /v1/submissions/:id after a terminal event.
        </p>
        <h2>Limits</h2>
        <table>
          <thead>
            <tr>
              <th>Limit</th>
              <th>Default</th>
              <th>Hard maximum</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["CPU time", "2,000 ms", "10,000 ms"],
              ["Wall time per test", "5,000 ms", "15,000 ms"],
              ["Memory", "256 MB", "512 MB"],
              ["Processes", "32", "64"],
              ["Combined output", "128 KB", "1,024 KB"],
              ["Workspace", "10 MB", "32 MB"],
            ].map((r) => (
              <tr key={r[0]}>
                {r.map((c) => (
                  <td key={c}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <h2>Runtime IDs</h2>
        <pre className="panel code">{`python:3.13    javascript:22    typescript:5.8\njava:21        c:14             cpp:14\ngo:1.24        rust:1.85`}</pre>
        <h2>Authentication &amp; errors</h2>
        <p className="muted">
          Use an Authorization Bearer header. Access tokens expire after 15
          minutes. Refresh tokens rotate on every use. API keys require
          submissions:create and submissions:read scopes. Errors include an
          error code, message and requestId. Validation errors are 400,
          forbidden access is 403, quotas are 429.
        </p>
        <h2>Webhook verification</h2>
        <p className="muted">
          Verify HMAC-SHA256(secret, eventId + &quot;.&quot; + timestamp +
          &quot;.&quot; + rawBody). Compare signatures in constant time, reject
          timestamps older than five minutes, and deduplicate event IDs.
          Delivery uses an allowlisted HTTPS destination with pinned public DNS
          resolution.
        </p>
        <h2>Security boundary</h2>
        <p className="muted">
          Runtime containers use a non-root UID, a read-only root filesystem, no
          network, no host mounts, dropped capabilities, and Docker’s default
          seccomp. Workers require a trusted, dedicated Linux execution host.
          Containers share a kernel: use stronger isolation backends for hostile
          public production workloads.
        </p>
        <h2>Self-hosting</h2>
        <pre className="panel code">{`cp .env.example .env\n# Replace development secrets.\npnpm install\npnpm runtimes:build\ndocker compose up -d --build`}</pre>
        <p className="muted">
          Read README.md, ARCHITECTURE.md and SECURITY.md in the source
          repository before deployment. Docker security regression tests are
          required on each execution host.
        </p>
      </main>
    </>
  );
}
