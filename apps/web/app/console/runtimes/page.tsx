"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api";

type Runtime = {
  id: string;
  language: string;
  version: string;
  enabled: boolean;
  updated_at?: string;
  updated_by_email?: string | null;
};

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function RuntimesPage() {
  const [items, setItems] = useState<Runtime[]>([]);
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const admin = await api("/v1/admin/runtimes");
      setItems(admin.items || []);
      setPlatformAdmin(true);
    } catch (adminError) {
      try {
        const publicInventory = await api("/v1/runtimes");
        setItems(publicInventory.items || []);
        setPlatformAdmin(false);
      } catch {
        setError((adminError as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (runtime: Runtime) => {
    setBusy(runtime.id);
    setError("");
    try {
      await api(`/v1/admin/runtimes/${encodeURIComponent(runtime.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !runtime.enabled }),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Runtime registry</h1>
          <p>
            Versioned language environments. Platform administrators can disable
            admission for new submissions without interrupting in-flight jobs.
          </p>
        </div>
        <button className="button small" disabled={loading} onClick={load}>
          Refresh
        </button>
      </div>

      {!platformAdmin && !loading && (
        <section className="panel" style={{ marginBottom: 20 }}>
          <div className="panel-head">
            <span>READ-ONLY INVENTORY</span>
          </div>
          <p className="muted code">
            Runtime changes require a platform administrator session.
          </p>
        </section>
      )}

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <span>RUNTIMES</span>
          <span>{items.length} configured</span>
        </div>
        {loading ? (
          <p className="muted">Loading runtime inventory…</p>
        ) : items.length === 0 ? (
          <p className="muted code">No runtimes configured.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Language</th>
                  <th>Version</th>
                  <th>Status</th>
                  {platformAdmin && <th>Last changed</th>}
                  {platformAdmin && <th>Changed by</th>}
                  {platformAdmin && <th>Action</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((runtime) => (
                  <tr key={runtime.id}>
                    <td>{runtime.language}</td>
                    <td className="mono">{runtime.version}</td>
                    <td>
                      <span
                        className={runtime.enabled ? "state completed" : "state failed"}
                      >
                        {runtime.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                    {platformAdmin && <td>{formatDate(runtime.updated_at)}</td>}
                    {platformAdmin && (
                      <td className="mono">{runtime.updated_by_email || "system"}</td>
                    )}
                    {platformAdmin && (
                      <td>
                        <button
                          className={`button small ${runtime.enabled ? "danger" : ""}`}
                          disabled={busy === runtime.id}
                          onClick={() => void toggle(runtime)}
                        >
                          {runtime.enabled ? "Disable" : "Enable"}
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
    </>
  );
}
