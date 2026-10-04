"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../../lib/api";

type Analytics = {
  windowHours: number;
  generatedAt: string;
  summary: {
    submissions: number;
    completed: number;
    failed: number;
    timed_out: number;
    accepted: number;
    cpu_ms: number;
    wall_ms: number;
    wall_p50_ms: number | null;
    wall_p95_ms: number | null;
    wall_p99_ms: number | null;
    cpu_p50_ms: number | null;
    cpu_p95_ms: number | null;
    cpu_p99_ms: number | null;
    successRate: number;
    failureRate: number;
    throughputPerHour: number;
  };
  throughput: Array<{
    bucket: string;
    submissions: number;
    completed: number;
    unsuccessful: number;
  }>;
  runtimes: Array<{
    runtime_id: string;
    language: string;
    version: string;
    submissions: number;
    accepted: number;
    wall_p95_ms: number | null;
  }>;
  projects: Array<{
    id: string;
    name: string;
    submissions: number;
    accepted: number;
    cpu_ms: number;
    wall_p95_ms: number | null;
  }>;
};

const windows = [1, 6, 24, 72, 168];

function ms(value: number | null | undefined) {
  if (value == null) return "—";
  return `${Math.round(value)} ms`;
}

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

export default function PlatformAnalyticsPage() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api(`/v1/admin/analytics?hours=${hours}`));
    } catch (e) {
      setData(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    void load();
  }, [load]);

  const peak = useMemo(() => {
    if (!data?.throughput.length) return null;
    return data.throughput.reduce((best, row) =>
      row.submissions > best.submissions ? row : best,
    );
  }, [data]);

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Platform analytics</h1>
          <p>
            Global execution throughput, latency percentiles, failure rates, and
            tenant/runtime hotspots from persisted execution evidence.
          </p>
        </div>
        <div className="form-row">
          <select
            aria-label="Analytics window"
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
          >
            {windows.map((value) => (
              <option key={value} value={value}>
                Last {value}h
              </option>
            ))}
          </select>
          <button className="button small" disabled={loading} onClick={load}>
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="muted">Loading platform telemetry…</p>
      ) : data ? (
        <>
          <div className="cards">
            <div className="panel stat">
              <div className="label">Submissions</div>
              <div className="value">{data.summary.submissions}</div>
              <span className="eyebrow">{data.windowHours}h window</span>
            </div>
            <div className="panel stat">
              <div className="label">Throughput</div>
              <div className="value">{data.summary.throughputPerHour.toFixed(2)}</div>
              <span className="eyebrow">submissions / hour</span>
            </div>
            <div className="panel stat">
              <div className="label">Accepted</div>
              <div className="value">{pct(data.summary.successRate)}</div>
              <span className="eyebrow">accepted / all</span>
            </div>
            <div className="panel stat">
              <div className="label">Failure rate</div>
              <div className="value">{pct(data.summary.failureRate)}</div>
              <span className="eyebrow">failed + timed out</span>
            </div>
          </div>

          <div className="cards" style={{ marginTop: 20 }}>
            {[
              ["Wall p50", ms(data.summary.wall_p50_ms)],
              ["Wall p95", ms(data.summary.wall_p95_ms)],
              ["Wall p99", ms(data.summary.wall_p99_ms)],
              ["CPU p95", ms(data.summary.cpu_p95_ms)],
            ].map(([label, value]) => (
              <div className="panel stat" key={label}>
                <div className="label">{label}</div>
                <div className="value">{value}</div>
              </div>
            ))}
          </div>

          <section className="panel" style={{ marginTop: 20 }}>
            <div className="panel-head">
              <span>HOURLY THROUGHPUT</span>
              <span>
                Peak {peak ? `${peak.submissions} submissions` : "—"}
              </span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Hour</th>
                    <th>Submissions</th>
                    <th>Completed</th>
                    <th>Failed / timed out</th>
                  </tr>
                </thead>
                <tbody>
                  {data.throughput.map((row) => (
                    <tr key={row.bucket}>
                      <td>{new Date(row.bucket).toLocaleString()}</td>
                      <td>{row.submissions}</td>
                      <td>{row.completed}</td>
                      <td>{row.unsuccessful}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel" style={{ marginTop: 20 }}>
            <div className="panel-head">
              <span>RUNTIME HOTSPOTS</span>
              <span>Top 10</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Runtime</th>
                    <th>Submissions</th>
                    <th>Accepted</th>
                    <th>Wall p95</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runtimes.map((row) => (
                    <tr key={row.runtime_id}>
                      <td className="mono">
                        {row.language} {row.version}
                      </td>
                      <td>{row.submissions}</td>
                      <td>{row.accepted}</td>
                      <td>{ms(row.wall_p95_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel" style={{ marginTop: 20 }}>
            <div className="panel-head">
              <span>TENANT HOTSPOTS</span>
              <span>Top 10 projects</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Submissions</th>
                    <th>Accepted</th>
                    <th>CPU total</th>
                    <th>Wall p95</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((row) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td>{row.submissions}</td>
                      <td>{row.accepted}</td>
                      <td>{ms(Number(row.cpu_ms))}</td>
                      <td>{ms(row.wall_p95_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p className="muted code" style={{ marginTop: 14 }}>
            Generated {new Date(data.generatedAt).toLocaleString()} from persisted
            submission and usage records.
          </p>
        </>
      ) : null}
    </>
  );
}
