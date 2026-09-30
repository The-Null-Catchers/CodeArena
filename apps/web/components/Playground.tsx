"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Play, Square, RotateCcw, Send } from "lucide-react";
import { api, stream } from "../lib/api";
const Editor = dynamic(
  async () => {
    const m = await import("@monaco-editor/react");
    m.loader.config({ paths: { vs: "/monaco/vs" } });
    return m.default;
  },
  {
    ssr: false,
    loading: () => <div className="code muted">Loading editor…</div>,
  },
);
const templates: Record<string, string> = {
  python: 'name = input()\nprint(f"Hello, {name}!")\n',
  javascript:
    'const fs = require("fs");\nconst name = fs.readFileSync(0, "utf8").trim();\nconsole.log(`Hello, ${name}!`);\n',
  typescript: 'console.log("Hello, CodeArena!");\n',
  c: '#include <stdio.h>\nint main(void) { puts("Hello, CodeArena!"); return 0; }\n',
  cpp: '#include <iostream>\nint main() { std::cout << "Hello, CodeArena!\\n"; }\n',
  java: 'public class Main { public static void main(String[] args) { System.out.println("Hello, CodeArena!"); } }\n',
  go: 'package main\nimport "fmt"\nfunc main() { fmt.Println("Hello, CodeArena!") }\n',
  rust: 'fn main() { println!("Hello, CodeArena!"); }\n',
};
export default function Playground({ challengeId }: { challengeId?: string }) {
  const [runtimes, setRuntimes] = useState<any[]>([]),
    [runtime, setRuntime] = useState("python:3.13"),
    [source, setSource] = useState(templates.python),
    [stdin, setStdin] = useState("CodeArena"),
    [output, setOutput] = useState(""),
    [stderr, setStderr] = useState(""),
    [state, setState] = useState("idle"),
    [error, setError] = useState(""),
    [id, setId] = useState(""),
    [result, setResult] = useState<any>(null),
    [events, setEvents] = useState<string[]>([]),
    [elapsed, setElapsed] = useState(0),
    [fontSize, setFontSize] = useState(14);
  const abort = useRef<AbortController | null>(null),
    started = useRef(0);
  const busy = [
      "created",
      "queued",
      "scheduled",
      "preparing",
      "compiling",
      "running",
      "judging",
    ].includes(state),
    language = runtime.split(":")[0];
  useEffect(() => {
    api("/v1/runtimes")
      .then((r) => setRuntimes(r.items))
      .catch((e) => setError(e.message));
    const draft = localStorage.getItem(
      `ca_draft_${challengeId || "playground"}_python:3.13`,
    );
    if (draft) setSource(draft);
    return () => abort.current?.abort();
  }, [challengeId]);
  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem(
        `ca_draft_${challengeId || "playground"}_${runtime}`,
        source,
      );
      if (challengeId)
        api(`/v1/drafts/${challengeId}`, {
          method: "PUT",
          body: JSON.stringify({ source, runtimeId: runtime }),
        }).catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [source, runtime, challengeId]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(
      () => setElapsed(Date.now() - started.current),
      100,
    );
    return () => clearInterval(timer);
  }, [busy]);
  const run = async (mode = "run") => {
    setError("");
    setOutput("");
    setStderr("");
    setResult(null);
    setEvents([]);
    setState("created");
    started.current = Date.now();
    try {
      const projects = await api("/v1/projects");
      if (!projects.items.length) throw new Error("Create a project first");
      const submission = await api("/v1/submissions", {
        method: "POST",
        body: JSON.stringify({
          projectId: projects.items[0].id,
          language,
          version: runtime.split(":")[1],
          source,
          stdin,
          mode,
          challengeId: mode === "challenge" ? challengeId : undefined,
        }),
      });
      setId(submission.id);
      setState("queued");
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      await stream(submission.id, controller.signal, (event, data) => {
        if (event === "output") {
          if (data.kind === "stdout")
            setOutput((o) => (o + data.text).slice(-1048576));
          else setStderr((o) => (o + data.text).slice(-1048576));
        } else if (data.state) {
          setState(data.state);
          setEvents((e) => [...e, data.state]);
          if (
            ["completed", "failed", "cancelled", "timed_out"].includes(
              data.state,
            )
          ) {
            api(`/v1/submissions/${submission.id}`)
              .then((r) => {
                setResult(r.result);
                setOutput(r.result?.stdout || "");
                setStderr(r.result?.stderr || r.result?.compile_output || "");
              })
              .catch((e) => setError(e.message));
            controller.abort();
          }
        }
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message);
        setState("failed");
      }
    }
  };
  return (
    <>
      <div className="workspace">
        <div className="panel editor-panel">
          <div className="editor-toolbar">
            <label className="screen-reader" htmlFor="runtime">
              Language and version
            </label>
            <select
              id="runtime"
              disabled={busy}
              value={runtime}
              onChange={(e) => {
                setRuntime(e.target.value);
                setSource(
                  localStorage.getItem(
                    `ca_draft_${challengeId || "playground"}_${e.target.value}`,
                  ) ||
                    templates[e.target.value.split(":")[0]] ||
                    "",
                );
              }}
            >
              {runtimes.map((r) => (
                <option key={r.id} value={r.id} disabled={!r.enabled}>
                  {r.language} {r.version}
                </option>
              ))}
            </select>
            <label className="screen-reader" htmlFor="font-size">
              Editor font size
            </label>
            <select
              id="font-size"
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
            >
              {[12, 14, 16, 18].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <div className="actions">
              <button
                aria-label="Reset source"
                title="Reset source"
                className="button small"
                disabled={busy}
                onClick={() => setSource(templates[language])}
              >
                <RotateCcw size={14} />
              </button>
              {busy ? (
                <button
                  className="button small danger"
                  onClick={() =>
                    api(`/v1/submissions/${id}/cancel`, {
                      method: "POST",
                    }).catch((e) => setError(e.message))
                  }
                  disabled={!id}
                >
                  <Square size={13} />
                  Stop
                </button>
              ) : (
                <button className="button small primary" onClick={() => run()}>
                  <Play size={13} />
                  Run
                </button>
              )}
              {challengeId && (
                <button
                  className="button small"
                  disabled={busy}
                  onClick={() => run("challenge")}
                >
                  <Send size={13} />
                  Submit
                </button>
              )}
            </div>
          </div>
          <div className="editor-area">
            <Editor
              height="100%"
              language={
                language === "cpp" || language === "c" ? "cpp" : language
              }
              theme="vs-dark"
              value={source}
              onChange={(v) => setSource(v || "")}
              options={{
                fontSize,
                minimap: { enabled: false },
                padding: { top: 20 },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                readOnly: busy,
              }}
              onMount={(editor, monaco) =>
                editor.addCommand(
                  monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
                  () => {
                    document
                      .querySelector<HTMLButtonElement>(".button.primary")
                      ?.click();
                  },
                )
              }
            />
          </div>
          <div className="editor-footer">
            <span>UTF-8 · {language} · autosaved</span>
            <span>⌘ / Ctrl + Enter to run</span>
          </div>
        </div>
        <div className="output-stack">
          <section className="panel">
            <div className="panel-head">
              <label htmlFor="stdin">STANDARD INPUT</label>
              <span>stdin</span>
            </div>
            <textarea
              className="stdin"
              id="stdin"
              value={stdin}
              onChange={(e) => setStdin(e.target.value)}
              spellCheck={false}
            />
          </section>
          <section className="panel">
            <div className="panel-head">
              <span>EXECUTION OUTPUT</span>
              <span className={`state ${state}`} aria-live="polite">
                <span className="dot" />
                {state}
              </span>
            </div>
            <pre aria-label="Standard output" className="output">
              {output ||
                (!busy
                  ? "Run your code to see output."
                  : "Waiting for output…")}
            </pre>
            {stderr && (
              <pre
                aria-label="Standard error"
                className="output"
                style={{
                  color: "#f6a4a4",
                  borderTop: "1px solid var(--border)",
                }}
              >
                {stderr}
              </pre>
            )}
            <div className="editor-footer">
              <span>
                {result
                  ? `${result.wall_ms} ms · ${(Number(result.peak_memory_bytes) / 1048576).toFixed(1)} MB`
                  : `${(elapsed / 1000).toFixed(1)}s`}
              </span>
              <span>{result?.verdict || "network: none"}</span>
            </div>
          </section>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error} <a href="/login">Sign in</a>
        </div>
      )}
      {events.length > 0 && (
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="panel-head">
            <span>EVENT TIMELINE</span>
            {id && <a href={`/console/submissions/${id}`}>View submission ↗</a>}
          </div>
          <div className="code muted">
            {events.join(" → ")}
            {result?.output_truncated && " · OUTPUT TRUNCATED"}
          </div>
        </section>
      )}
    </>
  );
}
