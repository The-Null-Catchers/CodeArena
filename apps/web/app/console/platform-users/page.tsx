"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api";

type PlatformUser = {
  id: string;
  email: string;
  disabled: boolean;
  platform_admin: boolean;
  created_at: string;
  memberships: number;
  active_sessions: number;
  submissions: number;
};

export default function PlatformUsersPage() {
  const [items, setItems] = useState<PlatformUser[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "disabled">("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ q: query, status, limit: "100" });
      const result = await api(`/v1/admin/users?${params.toString()}`);
      setItems(result.items || []);
      setTotal(result.total || 0);
    } catch (e) {
      setItems([]);
      setTotal(0);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const setDisabled = async (user: PlatformUser, disabled: boolean) => {
    setBusy(user.id);
    setError("");
    try {
      await api(`/v1/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled }),
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
          <h1>Platform users</h1>
          <p>
            Search accounts, inspect usage footprint, and suspend access with
            immediate session revocation.
          </p>
        </div>
        <button className="button small" disabled={loading} onClick={load}>
          Refresh
        </button>
      </div>

      <div className="form-row">
        <input
          className="field"
          type="search"
          placeholder="Search email"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          value={status}
          onChange={(event) =>
            setStatus(event.target.value as "all" | "active" | "disabled")
          }
        >
          <option value="all">All accounts</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <span>ACCOUNTS</span>
          <span>{total} matching</span>
        </div>
        {loading ? (
          <p className="muted">Loading accounts…</p>
        ) : items.length === 0 ? (
          <p className="muted code">No matching users.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Memberships</th>
                  <th>Sessions</th>
                  <th>Submissions</th>
                  <th>Created</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((user) => (
                  <tr key={user.id}>
                    <td className="mono">{user.email}</td>
                    <td>
                      {user.platform_admin ? (
                        <span className="state completed">Platform admin</span>
                      ) : (
                        <span className="muted">User</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={user.disabled ? "state failed" : "state completed"}
                      >
                        {user.disabled ? "Disabled" : "Active"}
                      </span>
                    </td>
                    <td>{user.memberships}</td>
                    <td>{user.active_sessions}</td>
                    <td>{user.submissions}</td>
                    <td>{new Date(user.created_at).toLocaleString()}</td>
                    <td>
                      <button
                        className={`button small ${user.disabled ? "" : "danger"}`}
                        disabled={busy === user.id}
                        onClick={() => void setDisabled(user, !user.disabled)}
                      >
                        {user.disabled ? "Enable" : "Disable"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="muted code" style={{ marginTop: 14 }}>
        Disabling an account revokes all active sessions immediately. The last
        active platform administrator cannot be disabled.
      </p>
    </>
  );
}
