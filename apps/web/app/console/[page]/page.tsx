"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../../../lib/api";
const titles: Record<string, [string, string]> = {
  dashboard: [
    "Execution overview",
    "Live data from your project. Every result is traceable.",
  ],
  challenges: [
    "Challenge library",
    "Original problems, public examples, and protected judging.",
  ],
  submissions: [
    "Submission history",
    "Inspect source, resource usage, and the execution timeline.",
  ],
  projects: ["Projects", "Your organization’s execution boundaries."],
  "api-keys": [
    "API keys",
    "Scoped credentials. Secrets are shown exactly once.",
  ],
  webhooks: [
    "Webhooks",
    "Signed delivery, bounded retries, and an inspectable history.",
  ],
  usage: ["Project usage", "Measured execution costs over the last 30 days."],
  workers: ["Worker fleet", "Capacity, runtime support, and heartbeat health."],
  queue: ["Execution queue", "Submission states for your selected project."],
  runtimes: [
    "Runtime registry",
    "Versioned language environments, configured centrally.",
  ],
};
export default function Page({
  params,
}: {
  params: Promise<{ page: string }>;
}) {
  const { page } = use(params),
    [project, setProject] = useState(""),
    [projects, setProjects] = useState<any[]>([]),
    [items, setItems] = useState<any[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [name, setName] = useState(""),
    [secret, setSecret] = useState(""),
    [revision, setRevision] = useState(0),
    [selected, setSelected] = useState<any>(null);
  const title = titles[page];
  useEffect(() => {
    api("/v1/projects")
      .then((r) => {
        setProjects(r.items);
        setProject(r.items[0]?.id || "");
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!project && !["runtimes", "challenges"].includes(page)) return;
    setLoading(true);
    setError("");
    const path = page === "dashboard" ? "/v1/submissions" : `/v1/${page}`;
    api(
      path +
        (["runtimes", "challenges", "projects"].includes(page)
          ? ""
          : `?projectId=${project}`),
    )
      .then((r) => setItems(r.items))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [page, project, revision]);
  if (!title) return <p>Page not found.</p>;
  const create = async () => {
    setError("");
    setSecret("");
    try {
      if (page === "api-keys") {
        const r = await api("/v1/api-keys", {
          method: "POST",
          body: JSON.stringify({
            projectId: project,
            name,
            scopes: ["submissions:create", "submissions:read"],
          }),
        });
        setSecret(r.secret);
      } else if (page === "webhooks") {
        const r = await api("/v1/webhooks", {
          method: "POST",
          body: JSON.stringify({ projectId: project, url: name }),
        });
        setSecret(r.secret);
      }
      setName("");
      setRevision((x) => x + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{title[0]}</h1>
          <p>{title[1]}</p>
        </div>
        <button
          className="button small"
          onClick={() => setRevision((x) => x + 1)}
        >
          Refresh
        </button>
      </div>
      {projects.length > 0 && (
        <div className="form-row">
          <label htmlFor="project" className="muted">
            Project
          </label>
          <select
            id="project"
            style={{ width: 240 }}
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error} <Link href="/login">Sign in</Link>
        </div>
      )}
      {page === "dashboard" && (
        <div className="cards">
          {[
            ["Recent submissions", items.length],
            ["Accepted", items.filter((s) => s.verdict === "accepted").length],
            [
              "In progress",
              items.filter((s) =>
                [
                  "queued",
                  "scheduled",
                  "preparing",
                  "compiling",
                  "running",
                  "judging",
                ].includes(s.state),
              ).length,
            ],
            [
              "Failed / timed out",
              items.filter((s) => ["failed", "timed_out"].includes(s.state))
                .length,
            ],
          ].map(([k, v]) => (
            <div className="panel stat" key={k}>
              <div className="label">{k}</div>
              <div className="value">{v}</div>
              <span className="eyebrow">Latest 50 submissions</span>
            </div>
          ))}
        </div>
      )}
      {["api-keys", "webhooks"].includes(page) && (
        <>
          <div className="form-row">
            <input
              className="field"
              aria-label={page === "api-keys" ? "Key name" : "Webhook URL"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                page === "api-keys" ? "Key name" : "https://allowed-host/events"
              }
            />
            <button
              className="button primary"
              disabled={!name || !project}
              onClick={create}
            >
              Create {page === "api-keys" ? "key" : "endpoint"}
            </button>
          </div>
          {secret && (
            <div className="panel code">
              <strong>Copy this secret now. It will not be shown again.</strong>
              <p style={{ overflowWrap: "anywhere" }}>{secret}</p>
              <button
                className="button small"
                onClick={() => {
                  navigator.clipboard.writeText(secret);
                }}
              >
                Copy
              </button>
            </div>
          )}
        </>
      )}
      {loading ? (
        <p className="muted">Loading live data…</p>
      ) : page === "challenges" ? (
        <div className="challenge-grid">
          {items.map((c) => (
            <Link
              className="panel challenge-card"
              key={c.id}
              href={`/console/challenges/${c.slug}`}
            >
              <span className="pill">{c.difficulty}</span>
              <h3>{c.title}</h3>
              <p>{c.description.slice(0, 140)}</p>
              <span className="mono muted">Open workspace ↗</span>
            </Link>
          ))}
        </div>
      ) : (
        <section className="panel">
          <div className="panel-head">
            <span>
              {page === "dashboard"
                ? "RECENT EXECUTIONS"
                : title[0].toUpperCase()}
            </span>
            <span>{items.length} records</span>
          </div>
          {items.length === 0 ? (
            <div className="code muted">
              No records yet.{" "}
              {page === "dashboard" || page === "submissions" ? (
                <Link href="/console/playground">
                  Run your first execution ↗
                </Link>
              ) : (
                ""
              )}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {columns(page).map((c) => (
                      <th key={c}>{c.replaceAll("_", " ")}</th>
                    ))}
                    {["api-keys", "webhooks", "workers"].includes(page) && (
                      <th>Action</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {items.map((row, i) => (
                    <tr key={row.id || i}>
                      {columns(page).map((c) => (
                        <td key={c}>
                          {c === "id" &&
                          ["dashboard", "submissions"].includes(page) ? (
                            <Link href={`/console/submissions/${row.id}`}>
                              <code>{String(row.id).slice(0, 8)} ↗</code>
                            </Link>
                          ) : c === "state" || c === "verdict" ? (
                            <span className={`state ${row[c]}`}>
                              {row[c] || "—"}
                            </span>
                          ) : Array.isArray(row[c]) ? (
                            row[c].join(", ")
                          ) : (
                            String(row[c] ?? "—")
                          )}
                        </td>
                      ))}
                      {page === "api-keys" && (
                        <td>
                          <button
                            className="button small danger"
                            disabled={!!row.revoked_at}
                            onClick={async () => {
                              try {
                                await api(`/v1/api-keys/${row.id}`, {
                                  method: "DELETE",
                                });
                                setRevision((x) => x + 1);
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            }}
                          >
                            Revoke
                          </button>
                        </td>
                      )}
                      {page === "webhooks" && (
                        <td>
                          <button
                            className="button small"
                            onClick={() =>
                              api(`/v1/webhooks/${row.id}/deliveries`)
                                .then((r) => setSelected(r.items))
                                .catch((e) => setError(e.message))
                            }
                          >
                            Deliveries
                          </button>
                        </td>
                      )}
                      {page === "workers" && (
                        <td>
                          <button
                            className="button small"
                            onClick={() =>
                              api(`/v1/workers/${row.id}/drain`, {
                                method: "POST",
                                body: JSON.stringify({ projectId: project }),
                              })
                                .then(() => setRevision((x) => x + 1))
                                .catch((e) => setError(e.message))
                            }
                          >
                            Drain
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {selected && (
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="panel-head">DELIVERY HISTORY</div>
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>HTTP</th>
              </tr>
            </thead>
            <tbody>
              {selected.map((d: any) => (
                <tr key={d.id}>
                  <td>{d.event}</td>
                  <td>{d.status}</td>
                  <td>{d.attempts}</td>
                  <td>{d.response_code || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!selected.length && <p className="code muted">No deliveries yet.</p>}
        </section>
      )}
    </>
  );
}
function columns(page: string) {
  return (
    (
      {
        dashboard: [
          "id",
          "runtime_id",
          "state",
          "verdict",
          "wall_ms",
          "created_at",
        ],
        submissions: [
          "id",
          "runtime_id",
          "state",
          "verdict",
          "wall_ms",
          "created_at",
        ],
        projects: ["name", "role", "max_outstanding", "max_daily"],
        "api-keys": ["name", "prefix", "scopes", "last_used_at", "revoked_at"],
        webhooks: ["url", "enabled", "created_at"],
        usage: ["day", "executions", "cpu_ms", "wall_ms"],
        workers: [
          "id",
          "status",
          "active",
          "slots",
          "runtimes",
          "last_heartbeat",
        ],
        queue: ["state", "count"],
        runtimes: ["language", "version", "enabled"],
      } as Record<string, string[]>
    )[page] || []
  );
}
