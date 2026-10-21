"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../../../lib/api";

type Project = { id: string; name: string };
type Course = { id: string; title: string; description: string };
type Assignment = { id: string; title: string; instructions: string; max_attempts: number; due_at: string | null };
type Attempt = { id: string; attempt_number: number; submitted_at: string; submission_id: string | null; execution_state: string | null; verdict: string | null; score: number | null; override_score: string | null };

export default function LearnerEducationPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [attempts, setAttempts] = useState<Record<string, Attempt[]>>({});
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api("/v1/projects").then((data) => {
      const items: Project[] = data.items || [];
      setProjects(items);
      setProjectId(items[0]?.id || "");
    }).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setCourses([]);
    setCourseId("");
    setAssignments([]);
    setAttempts({});
    if (!projectId) return;
    let current = true;
    setLoading(true);
    setError("");
    api(`/v1/education/projects/${projectId}/courses`).then((data) => {
      if (current) setCourses(data.items || []);
    }).catch((e) => { if (current) setError((e as Error).message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [projectId]);

  useEffect(() => {
    setAssignments([]);
    setAttempts({});
    if (!courseId) return;
    let current = true;
    setLoading(true);
    setError("");
    api(`/v1/education/courses/${courseId}/assignments`).then((data) => {
      if (current) setAssignments(data.items || []);
    }).catch((e) => { if (current) setError((e as Error).message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [courseId]);

  async function refreshAttempts(assignmentId: string) {
    const data = await api(`/v1/education/assignments/${assignmentId}/attempts`);
    setAttempts((old) => ({ ...old, [assignmentId]: data.items || [] }));
  }

  async function reserve(assignmentId: string) {
    setBusyId(assignmentId);
    setError("");
    try {
      await api(`/v1/education/assignments/${assignmentId}/attempts`, {
        method: "POST", body: JSON.stringify({}),
      });
      await refreshAttempts(assignmentId);
    } catch (e) { setError((e as Error).message); }
    finally { setBusyId(""); }
  }

  async function viewAttempts(assignmentId: string) {
    setBusyId(assignmentId);
    setError("");
    try { await refreshAttempts(assignmentId); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyId(""); }
  }

  return (
    <>
      <div className="page-title"><div>
        <h1>My learning</h1>
        <p>View enrolled courses, published assignments and your private attempt history.</p>
      </div><span className="pill">LEARNER WORKSPACE</span></div>
      <p className="muted">Attempt reservation is available here. Code submission and grading run through the execution workflow separately.</p>
      {error && <div className="error" role="alert">{error}</div>}
      <section className="panel" style={{ padding: 16, marginBottom: 16 }}>
        <div className="form-row" style={{ flexWrap: "wrap" }}>
          <label>Project
            <select aria-label="Learning project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label>Enrolled course
            <select aria-label="Enrolled course" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
              <option value="">Select a course</option>
              {courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}
            </select>
          </label>
        </div>
        {loading && <p className="muted" role="status">Loading learning data…</p>}
        {!loading && !projects.length && <p className="muted">No projects available.</p>}
        {!loading && projectId && !courses.length && <p className="muted">No visible enrolled courses.</p>}
      </section>
      {courseId && <section className="panel">
        <div className="panel-head">PUBLISHED ASSIGNMENTS</div>
        {!loading && !assignments.length && <p className="muted" style={{ padding: 16 }}>No visible assignments.</p>}
        {assignments.map((assignment) => {
          const history = attempts[assignment.id];
          const remaining = Math.max(0, assignment.max_attempts - (history?.length ?? 0));
          const due = assignment.due_at ? new Date(assignment.due_at) : null;
          const expired = Boolean(due && due.getTime() <= Date.now());
          return <div key={assignment.id} style={{ padding: 16, borderBottom: "1px solid var(--border, #293345)" }}>
            <h3>{assignment.title}</h3>
            {assignment.instructions && <p>{assignment.instructions}</p>}
            <p className="muted">Maximum attempts: {assignment.max_attempts} · Deadline: {due ? due.toLocaleString() : "None"}</p>
            <div className="form-row" style={{ flexWrap: "wrap" }}>
              <button className="button" disabled={busyId === assignment.id} onClick={() => void viewAttempts(assignment.id)}>
                {busyId === assignment.id ? "Loading…" : "View my attempts"}
              </button>
              <button className="button primary" disabled={Boolean(busyId) || expired || Boolean(history && remaining === 0)}
                onClick={() => void reserve(assignment.id)}>Reserve attempt</button>
            </div>
            {expired && <p className="muted">Deadline has passed; new attempts are unavailable.</p>}
            {history && <div style={{ marginTop: 12 }}>
              <p className="muted">Used {history.length} of {assignment.max_attempts} attempts.</p>
              {!history.length ? <p className="muted">No attempts yet.</p> :
                <div className="table-wrap"><table><thead><tr><th>Attempt</th><th>Created</th><th>Execution</th><th>Result</th><th>Score</th></tr></thead>
                  <tbody>{history.map((attempt) => <tr key={attempt.id}>
                    <td>{attempt.attempt_number}</td><td>{new Date(attempt.submitted_at).toLocaleString()}</td>
                    <td>{attempt.submission_id
                      ? <Link href={`/console/submissions/${attempt.submission_id}`}>{attempt.execution_state || "Pending"}</Link>
                      : "Not linked"}</td>
                    <td>{attempt.verdict || "—"}</td>
                    <td>{attempt.override_score ?? attempt.score ?? "—"}</td>
                  </tr>)}</tbody></table></div>}
            </div>}
          </div>;
        })}
      </section>}
    </>
  );
}
