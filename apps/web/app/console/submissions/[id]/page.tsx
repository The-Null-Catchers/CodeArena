"use client";
import { use, useEffect, useState } from "react";
import { api, downloadArtifact } from "../../../../lib/api";
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params),
    [data, setData] = useState<any>(null),
    [artifacts, setArtifacts] = useState<any[]>([]),
    [artifactError, setArtifactError] = useState(""),
    [downloading, setDownloading] = useState<string | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    Promise.all([
      api(`/v1/submissions/${id}`),
      api(`/v1/submissions/${id}/artifacts`).catch((e) => {
        setArtifactError(e.message);
        return { items: [] };
      }),
    ])
      .then(([submission, artifactList]) => {
        setData(submission);
        setArtifacts(artifactList.items || []);
      })
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
      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <span>ARTIFACTS</span>
          <span>{artifacts.length} file{artifacts.length === 1 ? "" : "s"}</span>
        </div>
        {artifactError ? (
          <p className="error" style={{ margin: 16 }}>{artifactError}</p>
        ) : artifacts.length === 0 ? (
          <p className="muted" style={{ padding: "4px 20px 20px" }}>
            No downloadable artifacts were captured for this submission.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Kind</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((artifact: any) => (
                  <tr key={artifact.id}>
                    <td className="mono">{artifact.filename}</td>
                    <td>{artifact.kind}</td>
                    <td>{artifact.mime_type}</td>
                    <td>{(Number(artifact.size_bytes || 0) / 1024).toFixed(1)} KB</td>
                    <td>
                      <button
                        className="button small"
                        disabled={downloading === artifact.id}
                        onClick={async () => {
                          setArtifactError("");
                          setDownloading(artifact.id);
                          try {
                            await downloadArtifact(artifact.id, artifact.filename);
                          } catch (e) {
                            setArtifactError(
                              e instanceof Error ? e.message : "Artifact download failed",
                            );
                          } finally {
                            setDownloading(null);
                          }
                        }}
                      >
                        {downloading === artifact.id ? "Downloading…" : "Download"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
