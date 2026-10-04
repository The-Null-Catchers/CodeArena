"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api";

type Session = {
  id: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function describeAgent(value: string) {
  if (!value) return "Unknown client";
  return value.length > 90 ? `${value.slice(0, 87)}…` : value;
}

export default function SessionsPage() {
  const [items, setItems] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api("/v1/auth/sessions");
      setItems(result.items || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (session: Session) => {
    setBusy(session.id);
    setError("");
    try {
      await api(`/v1/auth/sessions/${session.id}`, { method: "DELETE" });
      if (session.current) {
        sessionStorage.removeItem("ca_access");
        sessionStorage.removeItem("ca_refresh");
        window.location.assign("/login");
        return;
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const logoutAll = async () => {
    setBusy("all");
    setError("");
    try {
      await api("/v1/auth/logout-all", { method: "POST" });
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
      return;
    }
    sessionStorage.removeItem("ca_access");
    sessionStorage.removeItem("ca_refresh");
    window.location.assign("/login");
  };

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Active sessions</h1>
          <p>
            Review signed-in clients and revoke access without exposing raw IP
            addresses.
          </p>
        </div>
        <div className="form-row">
          <button className="button small" disabled={loading} onClick={load}>
            Refresh
          </button>
          <button
            className="button small danger"
            disabled={busy === "all" || items.length === 0}
            onClick={logoutAll}
          >
            Sign out everywhere
          </button>
        </div>
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <span>SESSION SECURITY</span>
          <span>{items.length} active</span>
        </div>
        {loading ? (
          <p className="code muted">Loading active sessions…</p>
        ) : items.length === 0 ? (
          <p className="code muted">No active sessions found.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Created</th>
                  <th>Last seen</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((session) => (
                  <tr key={session.id}>
                    <td title={session.userAgent}>
                      <span className="mono">{describeAgent(session.userAgent)}</span>
                    </td>
                    <td>{formatDate(session.createdAt)}</td>
                    <td>{formatDate(session.lastSeenAt)}</td>
                    <td>{formatDate(session.expiresAt)}</td>
                    <td>
                      {session.current ? (
                        <span className="state completed">Current</span>
                      ) : (
                        <span className="muted">Active</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="button small danger"
                        disabled={busy === session.id || busy === "all"}
                        onClick={() => revoke(session)}
                      >
                        {session.current ? "Sign out" : "Revoke"}
                      </button>
                    </td>
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
