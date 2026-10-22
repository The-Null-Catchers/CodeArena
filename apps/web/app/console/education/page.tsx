"use client";

import { useEffect, useState } from "react";
import { API, api } from "../../../lib/api";

type Project = { id: string; name: string };
type Course = { id: string; title: string; description: string; status: string };
type Assignment = { id: string; title: string; status: string; max_attempts: number; due_at: string | null };
type Grade = { user_id: string; attempt_count: number; completed_count: number; best_score: string | null };

export default function EducationPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState("");
  const [courseTitle, setCourseTitle] = useState("");
  const [enrollmentUserId, setEnrollmentUserId] = useState("");
  const [enrollmentNotice, setEnrollmentNotice] = useState("");
  const [assignmentTitle, setAssignmentTitle] = useState("");
  const [maxAttempts, setMaxAttempts] = useState(1);
  const [challengeId, setChallengeId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api("/v1/projects").then((result) => {
      const items: Project[] = result.items || [];
      setProjects(items);
      setProjectId(items[0]?.id || "");
    }).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setCourseId("");
    setEnrollmentNotice("");
    setEnrollmentUserId("");
    setCourses([]);
    setAssignments([]);
    setGrades([]);
    if (!projectId) return;
    let active = true;
    setLoading(true);
    api(`/v1/education/projects/${projectId}/courses`).then((result) => {
      if (active) setCourses(result.items || []);
    }).catch((e) => { if (active) setError((e as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    setAssignments([]);
    setGrades([]);
    setSelectedAssignment("");
    if (!courseId) return;
    let active = true;
    api(`/v1/education/courses/${courseId}/assignments`).then((result) => {
      if (active) setAssignments(result.items || []);
    }).catch((e) => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [courseId]);

  async function createCourse() {
    if (!projectId || !courseTitle.trim()) return;
    setBusy(true);
    setError("");
    try {
      const course: Course = await api("/v1/education/courses", {
        method: "POST", body: JSON.stringify({ projectId, title: courseTitle.trim() }),
      });
      setCourses((old) => [course, ...old]);
      setCourseTitle("");
      setCourseId(course.id);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function updateCourseStatus(status: "published" | "archived") {
    if (!courseId) return;
    setBusy(true);
    setError("");
    try {
      const result: Course = await api(`/v1/education/courses/${courseId}/status`, {
        method: "PATCH", body: JSON.stringify({ status }),
      });
      setCourses((old) => old.map((item) => item.id === courseId ? { ...item, status: result.status } : item));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function enrollLearner() {
    if (!courseId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(enrollmentUserId.trim())) return;
    setBusy(true);
    setError("");
    setEnrollmentNotice("");
    try {
      const result: { enrolled: boolean } = await api(`/v1/education/courses/${courseId}/enrollments`, {
        method: "POST", body: JSON.stringify({ userId: enrollmentUserId.trim() }),
      });
      setEnrollmentNotice(result.enrolled ? "Learner enrolled successfully." : "Learner is already enrolled.");
      setEnrollmentUserId("");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function createAssignment() {
    if (!courseId || !assignmentTitle.trim()) return;
    setBusy(true);
    setError("");
    try {
      const item: Assignment = await api(`/v1/education/courses/${courseId}/assignments`, {
        method: "POST", body: JSON.stringify({ title: assignmentTitle.trim(), maxAttempts, challengeId: challengeId.trim() || null }),
      });
      setAssignments((old) => [item, ...old]);
      setAssignmentTitle("");
      setChallengeId("");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function publish(item: Assignment) {
    setBusy(true);
    setError("");
    try {
      const changed = await api(`/v1/education/courses/${courseId}/assignments/${item.id}/status`, {
        method: "PATCH", body: JSON.stringify({ status: "published" }),
      });
      setAssignments((old) => old.map((a) => a.id === item.id ? { ...a, status: changed.status } : a));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function loadGrades(id: string) {
    setSelectedAssignment(id);
    setGrades([]);
    setError("");
    try {
      const result = await api(`/v1/education/assignments/${id}/grades`);
      setGrades(result.items || []);
    } catch (e) { setError((e as Error).message); }
  }

  async function downloadGrades(assignmentId: string) {
    setBusy(true);
    setError("");
    try {
      const token = sessionStorage.getItem("ca_access");
      if (!token) throw new Error("Sign in to download grades");
      const response = await fetch(`${API}/v1/education/assignments/${assignmentId}/grades.csv`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) {
        let message = `Grade export failed (HTTP ${response.status})`;
        try { const error = await response.json(); message = error.error?.message || message; }
        catch { /* Non-JSON errors retain the status message. */ }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const element = document.createElement("a");
        element.href = url;
        element.download = `assignment-${assignmentId}-grades.csv`;
        document.body.appendChild(element);
        element.click();
        element.remove();
      } finally { URL.revokeObjectURL(url); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-title"><div><h1>Education</h1>
        <p>Manage project courses, programming assignments and learner grades.</p>
      </div><span className="pill">COURSES & ASSIGNMENTS</span></div>
      {error && <div className="error" role="alert">{error}</div>}
      <section className="panel" style={{ marginBottom: 16, padding: 16 }}>
        <label>Project
          <select aria-label="Education project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}
          </select>
        </label>
        {loading && <p className="muted">Loading education data…</p>}
        {!loading && !projects.length && <p className="muted">No projects available.</p>}
      </section>
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">COURSES</div>
        <div className="form-row" style={{ padding: 16, flexWrap: "wrap" }}>
          <input className="field" aria-label="New course title" maxLength={160}
            placeholder="New course title" value={courseTitle} onChange={(e) => setCourseTitle(e.target.value)} />
          <button className="button primary" disabled={busy || !projectId || !courseTitle.trim()} onClick={() => void createCourse()}>Create course</button>
          <select aria-label="Choose course" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            <option value="">Select a course</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.title} ({c.status})</option>)}
          </select>
        </div>
        {courseId && courses.find((c) => c.id === courseId)?.status !== "archived" && <div className="form-row" style={{ padding: 16 }}>
          {courses.find((c) => c.id === courseId)?.status === "draft" && <button className="button primary" disabled={busy} onClick={() => void updateCourseStatus("published")}>Publish course</button>}
          <button className="button danger" disabled={busy} onClick={() => { if (window.confirm("Archive this course permanently?")) void updateCourseStatus("archived"); }}>Archive course</button>
        </div>}
        {!loading && courses.length === 0 && <p className="muted" style={{ padding: 16 }}>No visible courses in this project.</p>}
      </section>
      {courseId && <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">ENROLL LEARNER</div>
        <div className="form-row" style={{ padding: 16, flexWrap: "wrap" }}>
          <label style={{ flex: 1, minWidth: 260 }}>Project member user ID
            <input className="field" aria-label="Learner user UUID" placeholder="Learner UUID"
              value={enrollmentUserId} onChange={(e) => setEnrollmentUserId(e.target.value)}
              maxLength={36} />
          </label>
          <button className="button" onClick={() => void enrollLearner()}
            disabled={busy || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(enrollmentUserId.trim())}>
            Enroll learner
          </button>
        </div>
        <p className="muted" style={{ padding: "0 16px 12px" }}>Only existing members of this project can be enrolled. Owner/admin permissions are enforced by the API.</p>
        {enrollmentNotice && <p role="status" style={{ padding: "0 16px 12px" }}>{enrollmentNotice}</p>}
      </section>}
      {courseId && <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">ASSIGNMENTS</div>
        <div className="form-row" style={{ padding: 16, flexWrap: "wrap" }}>
          <input className="field" maxLength={160} aria-label="New assignment title"
            placeholder="Assignment title" value={assignmentTitle} onChange={(e) => setAssignmentTitle(e.target.value)} />
          <label>Maximum attempts
            <input type="number" min={1} max={100} value={maxAttempts}
              onChange={(e) => setMaxAttempts(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
          </label>
          <input className="field" aria-label="Published challenge UUID" placeholder="Published challenge UUID (optional)" value={challengeId} onChange={(e) => setChallengeId(e.target.value)} />
          <button className="button primary" disabled={busy || !assignmentTitle.trim()} onClick={() => void createAssignment()}>Create draft</button>
        </div>
        {assignments.length === 0 ? <p className="muted" style={{ padding: 16 }}>No visible assignments.</p> :
          <div className="table-wrap"><table><thead><tr><th>Assignment</th><th>Status</th><th>Attempts</th><th>Actions</th></tr></thead>
            <tbody>{assignments.map((a) => <tr key={a.id}><td>{a.title}</td><td>{a.status}</td>
              <td>{a.max_attempts}</td><td>
                {a.status === "draft" && <button className="button small" disabled={busy} onClick={() => void publish(a)}>Publish</button>}
                <button className="button small" onClick={() => void loadGrades(a.id)}>View grades</button>
              </td></tr>)}</tbody></table></div>}
      </section>}
      {selectedAssignment && <section className="panel">
        <div className="panel-head">
          <span>GRADE SUMMARY · BEST COMPLETED ATTEMPT</span>
          <button className="button small" disabled={busy}
            onClick={() => void downloadGrades(selectedAssignment)}>Download grades CSV</button>
        </div>
        {grades.length === 0 ? <p className="muted" style={{ padding: 16 }}>No enrolled learners or grade summary available.</p> :
          <div className="table-wrap"><table><thead><tr><th>Learner ID</th><th>Attempts</th><th>Completed</th><th>Best score</th></tr></thead>
            <tbody>{grades.map((g) => <tr key={g.user_id}><td className="mono">{g.user_id}</td>
              <td>{g.attempt_count}</td><td>{g.completed_count}</td><td>{g.best_score ?? "—"}</td>
            </tr>)}</tbody></table></div>}
      </section>}
    </>
  );
}
