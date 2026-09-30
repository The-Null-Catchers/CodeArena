"use client";
import { use, useEffect, useState } from "react";
import { api } from "../../../../lib/api";
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params),
    [data, setData] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    api(`/v1/submissions/${id}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p>Loading submission…</p>;
  return (
    <>
      <div className="page-title">
        <div>
          <h1>Submission details</h1>
          <p className="mono">{id}</p>
        </div>
        <span className="pill">
          {data.result?.verdict || data.submission.state}
        </span>
      </div>
      <div className="cards">
        {[
          ["Runtime", data.submission.runtime_id],
          ["Wall time", `${data.result?.wall_ms || 0} ms`],
          [
            "Peak memory",
            `${(Number(data.result?.peak_memory_bytes || 0) / 1048576).toFixed(1)} MB`,
          ],
          ["Score", `${data.result?.score || 0}%`],
        ].map(([k, v]) => (
          <div className="panel stat" key={k}>
            <div className="label">{k}</div>
            <div className="value" style={{ fontSize: 22 }}>
              {v}
            </div>
          </div>
        ))}
      </div>
      <div className="two-col">
        <section className="panel">
          <div className="panel-head">SOURCE</div>
          <pre className="code">{data.submission.source}</pre>
        </section>
        <section className="panel">
          <div className="panel-head">OUTPUT</div>
          <pre className="code">
            {data.result?.stdout}
            {data.result?.stderr}
            {data.result?.compile_output}
          </pre>
          {data.result?.output_truncated && (
            <p className="error">Output truncated at the server limit.</p>
          )}
          <ul className="timeline">
            {data.events.map((e: any) => (
              <li key={e.id}>
                <strong>{e.state}</strong>
                {e.reason} · {new Date(e.created_at).toLocaleTimeString()}
              </li>
            ))}
          </ul>
        </section>
      </div>
      {data.tests.length > 0 && (
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="panel-head">
            TEST RESULTS · Hidden inputs and outputs remain private
          </div>
          <table>
            <thead>
              <tr>
                <th>Test</th>
                <th>Visibility</th>
                <th>Verdict</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {data.tests.map((t: any) => (
                <tr key={t.position}>
                  <td>{t.position + 1}</td>
                  <td>{t.hidden ? "Hidden" : "Sample"}</td>
                  <td>{t.verdict}</td>
                  <td>{t.wall_ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
