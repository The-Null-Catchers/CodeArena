"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../lib/api";

type Room = {
  id: string;
  title: string;
  status: "active" | "ended";
  role: "interviewer" | "candidate" | "observer";
  project_id: string;
  document_revision: number;
  created_at: string;
};
type Project = { id: string; name: string };
type StatusFilter = "all" | "active" | "ended";
type RoleFilter = "all" | Room["role"];

export default function InterviewsPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [r, p] = await Promise.all([
        api("/v1/interview-rooms"),
        api("/v1/projects"),
      ]);
      setRooms(r.items || []);
      setProjects(p.items || []);
      setProjectId((current) => current || p.items?.[0]?.id || "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filteredRooms = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rooms.filter((room) => {
      if (statusFilter !== "all" && room.status !== statusFilter) return false;
      if (roleFilter !== "all" && room.role !== roleFilter) return false;
      if (needle && !room.title.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [query, roleFilter, rooms, statusFilter]);

  const activeCount = rooms.filter((room) => room.status === "active").length;
  const interviewingCount = rooms.filter((room) => room.role === "interviewer").length;

  const create = async () => {
    if (!projectId || !title.trim()) return;
    setBusy(true);
    setError("");
    try {
      const room = await api("/v1/interview-rooms", {
        method: "POST",
        body: JSON.stringify({ projectId, title: title.trim() }),
      });
      window.location.assign(`/console/interviews/${room.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Interview rooms</h1>
          <p>Run collaborative coding interviews with durable shared state and live presence.</p>
        </div>
        <span className="pill">LIVE COLLABORATION</span>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 12, marginBottom: 16 }}>
        <section className="panel" style={{ padding: 16 }}><div className="muted">Total rooms</div><strong style={{ fontSize: 28 }}>{rooms.length}</strong></section>
        <section className="panel" style={{ padding: 16 }}><div className="muted">Active</div><strong style={{ fontSize: 28 }}>{activeCount}</strong></section>
        <section className="panel" style={{ padding: 16 }}><div className="muted">As interviewer</div><strong style={{ fontSize: 28 }}>{interviewingCount}</strong></section>
      </div>

      <section className="panel">
        <div className="panel-head"><span>CREATE ROOM</span><span>WebSocket + durable replay</span></div>
        <div className="form-row" style={{ padding: 16, alignItems: "end", flexWrap: "wrap" }}>
          <label style={{ minWidth: 220 }}>Project
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label style={{ flex: 1, minWidth: 260 }}>Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Senior backend interview" maxLength={120} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
          </label>
          <button className="button" disabled={busy || !projectId || !title.trim()} onClick={create}>{busy ? "Creating…" : "Create room"}</button>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><span>YOUR ROOMS</span><button className="button small" disabled={loading} onClick={() => void load()}>{loading ? "Refreshing…" : "Refresh"}</button></div>
        <div className="form-row" style={{ padding: 16, flexWrap: "wrap" }}>
          <input aria-label="Search interview rooms" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by room title" style={{ minWidth: 240, flex: 1 }} />
          <select aria-label="Room status filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="ended">Ended</option>
          </select>
          <select aria-label="Room role filter" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}>
            <option value="all">All roles</option>
            <option value="interviewer">Interviewer</option>
            <option value="candidate">Candidate</option>
            <option value="observer">Observer</option>
          </select>
        </div>
        {loading && rooms.length === 0 ? (
          <p className="code muted" style={{ padding: 16 }}>Loading interview rooms…</p>
        ) : filteredRooms.length === 0 ? (
          <p className="code muted" style={{ padding: 16 }}>{rooms.length === 0 ? "No interview rooms yet." : "No rooms match the current filters."}</p>
        ) : (
          <div className="table-wrap"><table><thead><tr><th>Room</th><th>Status</th><th>Role</th><th>Revision</th><th>Created</th></tr></thead><tbody>
            {filteredRooms.map((room) => <tr key={room.id}>
              <td><Link href={`/console/interviews/${room.id}`}>{room.title}</Link></td>
              <td><span className={`state ${room.status === "ended" ? "failed" : "completed"}`}>{room.status}</span></td>
              <td>{room.role}</td>
              <td className="mono">{room.document_revision}</td>
              <td>{new Date(room.created_at).toLocaleString()}</td>
            </tr>)}
          </tbody></table></div>
        )}
      </section>
    </>
  );
}
