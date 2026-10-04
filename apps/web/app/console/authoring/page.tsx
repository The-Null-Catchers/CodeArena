"use client";
import { useEffect, useState } from "react";
import { api } from "../../../lib/api";

type TestCase = {
  stdin: string;
  expected: string;
  hidden: boolean;
  weight: number;
  wallTimeMs?: number;
  memoryMb?: number;
  group?: string;
};

type Challenge = {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  description: string;
  difficulty: "easy" | "medium" | "hard";
  visibility: "public" | "private";
  judge: "exact" | "whitespace" | "case_insensitive" | "float";
  status: "draft" | "published" | "archived";
  current_revision: number;
  languages: string[];
  tags: string[];
  tests: TestCase[];
};

const languages = ["python", "javascript", "typescript", "java", "c", "cpp", "go", "rust"];
const blankTest = (): TestCase => ({ stdin: "", expected: "", hidden: true, weight: 1 });

export default function AuthoringPage() {
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [revisions, setRevisions] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [createForm, setCreateForm] = useState({
    title: "",
    slug: "",
    description: "",
    difficulty: "medium",
    visibility: "private",
    judge: "whitespace",
  });

  useEffect(() => {
    api("/v1/projects")
      .then((r) => {
        setProjects(r.items);
        setProjectId(r.items[0]?.id || "");
      })
      .catch((e) => setError(e.message));
  }, []);

  const load = async (id = challengeId) => {
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      const [item, history] = await Promise.all([
        api(`/v1/challenge-authoring/${id}`),
        api(`/v1/challenge-authoring/${id}/revisions`),
      ]);
      setChallenge(item);
      setChallengeId(id);
      setRevisions(history.items || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!projectId || !createForm.title || !createForm.slug || !createForm.description) return;
    setBusy(true);
    setError("");
    try {
      const created = await api("/v1/challenges", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          ...createForm,
          languages: ["python"],
          tests: [blankTest()],
        }),
      });
      await load(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!challenge) return;
    setBusy(true);
    setError("");
    try {
      const next = await api(`/v1/challenge-authoring/${challenge.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: challenge.title,
          description: challenge.description,
          difficulty: challenge.difficulty,
          visibility: challenge.visibility,
          judge: challenge.judge,
          languages: challenge.languages,
          tags: challenge.tags,
          tests: challenge.tests.map(({ stdin, expected, hidden, weight, wallTimeMs, memoryMb, group }) => ({
            stdin,
            expected,
            hidden,
            weight,
            ...(wallTimeMs ? { wallTimeMs } : {}),
            ...(memoryMb ? { memoryMb } : {}),
            ...(group ? { group } : {}),
          })),
        }),
      });
      setChallenge(next);
      await load(next.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const action = async (kind: "publish" | "archive") => {
    if (!challenge) return;
    setBusy(true);
    try {
      await api(`/v1/challenge-authoring/${challenge.id}/${kind}`, { method: "POST" });
      await load(challenge.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Challenge authoring</h1>
          <p>Create, revise, publish, archive, and audit protected programming challenges.</p>
        </div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}

      <section className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">CREATE CHALLENGE</div>
        <div className="form-row">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="field" placeholder="Title" value={createForm.title} onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })} />
          <input className="field" placeholder="slug-like-this" value={createForm.slug} onChange={(e) => setCreateForm({ ...createForm, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
        </div>
        <textarea className="field" style={{ width: "100%", minHeight: 110 }} placeholder="Problem statement" value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} />
        <button className="button primary" disabled={busy} onClick={create}>Create and open editor</button>
      </section>

      <section className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">OPEN EXISTING</div>
        <div className="form-row">
          <input className="field" placeholder="Challenge UUID" value={challengeId} onChange={(e) => setChallengeId(e.target.value)} />
          <button className="button" disabled={busy || !challengeId} onClick={() => load()}>Open</button>
        </div>
      </section>

      {challenge && (
        <section className="panel">
          <div className="panel-head">
            <span>REVISION {challenge.current_revision} · {challenge.status.toUpperCase()}</span>
            <span>{challenge.slug}</span>
          </div>
          <div className="form-row">
            <input className="field" value={challenge.title} onChange={(e) => setChallenge({ ...challenge, title: e.target.value })} />
            <select value={challenge.difficulty} onChange={(e) => setChallenge({ ...challenge, difficulty: e.target.value as Challenge["difficulty"] })}>
              <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
            </select>
            <select value={challenge.visibility} onChange={(e) => setChallenge({ ...challenge, visibility: e.target.value as Challenge["visibility"] })}>
              <option value="private">Private</option><option value="public">Public</option>
            </select>
            <select value={challenge.judge} onChange={(e) => setChallenge({ ...challenge, judge: e.target.value as Challenge["judge"] })}>
              <option value="whitespace">Whitespace</option><option value="exact">Exact</option><option value="case_insensitive">Case insensitive</option><option value="float">Float</option>
            </select>
          </div>
          <textarea className="field" style={{ width: "100%", minHeight: 180 }} value={challenge.description} onChange={(e) => setChallenge({ ...challenge, description: e.target.value })} />

          <h3>Allowed languages</h3>
          <div className="form-row">
            {languages.map((language) => (
              <label key={language} className="pill">
                <input type="checkbox" checked={challenge.languages.includes(language)} onChange={(e) => setChallenge({ ...challenge, languages: e.target.checked ? [...challenge.languages, language] : challenge.languages.filter((x) => x !== language) })} /> {language}
              </label>
            ))}
          </div>
          <label>Tags</label>
          <input className="field" style={{ width: "100%" }} value={challenge.tags.join(", ")} onChange={(e) => setChallenge({ ...challenge, tags: e.target.value.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) })} />

          <h3>Tests</h3>
          {challenge.tests.map((test, index) => (
            <div className="panel" key={index} style={{ marginBottom: 12 }}>
              <div className="panel-head"><span>TEST {index + 1}</span><button className="button small danger" disabled={challenge.tests.length === 1} onClick={() => setChallenge({ ...challenge, tests: challenge.tests.filter((_, i) => i !== index) })}>Remove</button></div>
              <div className="two-col">
                <textarea className="field" placeholder="stdin" value={test.stdin} onChange={(e) => setChallenge({ ...challenge, tests: challenge.tests.map((t, i) => i === index ? { ...t, stdin: e.target.value } : t) })} />
                <textarea className="field" placeholder="expected output" value={test.expected} onChange={(e) => setChallenge({ ...challenge, tests: challenge.tests.map((t, i) => i === index ? { ...t, expected: e.target.value } : t) })} />
              </div>
              <div className="form-row">
                <label><input type="checkbox" checked={test.hidden} onChange={(e) => setChallenge({ ...challenge, tests: challenge.tests.map((t, i) => i === index ? { ...t, hidden: e.target.checked } : t) })} /> Hidden</label>
                <input className="field" type="number" min={1} max={100} value={test.weight} onChange={(e) => setChallenge({ ...challenge, tests: challenge.tests.map((t, i) => i === index ? { ...t, weight: Number(e.target.value) || 1 } : t) })} />
                <input className="field" placeholder="Group (optional)" value={test.group || ""} onChange={(e) => setChallenge({ ...challenge, tests: challenge.tests.map((t, i) => i === index ? { ...t, group: e.target.value || undefined } : t) })} />
              </div>
            </div>
          ))}
          <button className="button small" onClick={() => setChallenge({ ...challenge, tests: [...challenge.tests, blankTest()] })}>Add test</button>

          <div className="form-row" style={{ marginTop: 20 }}>
            <button className="button primary" disabled={busy || challenge.languages.length === 0} onClick={save}>Save revision</button>
            <button className="button" disabled={busy} onClick={() => action("publish")}>Publish</button>
            <button className="button danger" disabled={busy} onClick={() => action("archive")}>Archive</button>
          </div>

          <h3>Revision history</h3>
          <div className="table-wrap">
            <table><thead><tr><th>Revision</th><th>Title</th><th>Visibility</th><th>Published</th></tr></thead><tbody>
              {revisions.map((r) => <tr key={r.revision}><td>{r.revision}</td><td>{r.title}</td><td>{r.visibility}</td><td>{r.published_at || "draft"}</td></tr>)}
            </tbody></table>
          </div>
        </section>
      )}
    </>
  );
}
