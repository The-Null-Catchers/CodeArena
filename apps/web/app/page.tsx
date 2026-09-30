import Link from "next/link";
import {
  ShieldCheck,
  Layers,
  Radio,
  ArrowUpRight,
  Terminal,
  Workflow,
  Code2,
} from "lucide-react";
export default function Landing() {
  return (
    <>
      <header className="topnav">
        <Link href="/" className="brand">
          <b className="brand-mark">↳</b>
          <span>
            code<small>arena</small>
          </span>
        </Link>
        <nav className="links">
          <Link href="/console/challenges">Challenges</Link>
          <Link href="/docs">Documentation</Link>
          <Link className="button small" href="/login">
            Open console <ArrowUpRight size={15} />
          </Link>
        </nav>
      </header>
      <main>
        <section className="hero">
          <div>
            <div className="label">
              <span className="dot" /> Execution infrastructure for builders
            </div>
            <h1>
              Run untrusted
              <br />
              code.
              <br />
              <em>Safely. At scale.</em>
            </h1>
            <p>
              From a single script to a distributed judge. Isolated sandboxes,
              deliberate resource limits, and a realtime view of every
              execution.
            </p>
            <div className="hero-actions">
              <Link className="button primary" href="/console/playground">
                Launch playground <ArrowUpRight size={16} />
              </Link>
              <Link className="button" href="/docs">
                Explore the API
              </Link>
            </div>
            <div className="eyebrow">
              SELF-HOSTED · OPEN ARCHITECTURE · SECURE DEFAULTS
            </div>
          </div>
          <div className="panel hero-terminal">
            <div className="panel-head">
              <span>
                <Terminal
                  size={14}
                  style={{ display: "inline", marginInlineEnd: 8 }}
                />
                execution.py
              </span>
              <span className="pill">EXAMPLE REQUEST</span>
            </div>
            <pre className="code">
              <span className="muted"># Python 3.13 · isolated execution</span>
              {"\n\n"}
              <span className="muted"># Your code. Our boundaries.</span>
              {"\n"}
              <span className="green">print</span>(
              <span className="orange">&quot;Hello, isolated world.&quot;</span>
              ){"\n\n"}
              <span className="muted">$ curl /v1/submissions</span>
              {"\n"}
              {"{"}
              {"\n"} <span className="green">&quot;language&quot;</span>:{" "}
              <span className="orange">&quot;python&quot;</span>,{"\n"}{" "}
              <span className="green">&quot;version&quot;</span>:{" "}
              <span className="orange">&quot;3.13&quot;</span>,{"\n"}{" "}
              <span className="green">&quot;limits&quot;</span>: {"{"}{" "}
              &quot;memoryMb&quot;: 256 {"}"}
              {"\n"}
              {"}"}
            </pre>
            <div className="panel-head">
              <span>
                <span className="dot" />
                Network: none
              </span>
              <span>Non-root · Read-only rootfs</span>
            </div>
          </div>
        </section>
        <section className="section">
          <div className="label" style={{ marginBottom: 24 }}>
            One API. Eight language runtimes.
          </div>
          <div className="language-row">
            {[
              "Python",
              "JavaScript",
              "TypeScript",
              "C",
              "C++",
              "Java",
              "Go",
              "Rust",
            ].map((x) => (
              <span key={x}>{x}</span>
            ))}
          </div>
        </section>
        <section className="section">
          <div className="label">Built beneath the editor</div>
          <h2>Infrastructure you can inspect.</h2>
          <div className="feature-grid">
            {[
              [
                ShieldCheck,
                "A boundary for every run",
                "No runtime networking or host mounts. Memory, processes, CPU time, filesystem and output are bounded.",
              ],
              [
                Layers,
                "Distributed by design",
                "API, scheduler and workers are separate services. Capacity reservations and execution leases live in PostgreSQL.",
              ],
              [
                Radio,
                "A live execution timeline",
                "Stream output and state changes through Redis Streams and SSE. Final results survive client disconnections.",
              ],
            ].map(([Icon, title, copy]) => {
              const I = Icon as typeof ShieldCheck;
              return (
                <article className="feature" key={String(title)}>
                  <I size={25} />
                  <h3>{String(title)}</h3>
                  <p>{String(copy)}</p>
                </article>
              );
            })}
          </div>
        </section>
        <section className="section">
          <div className="label">Execution lifecycle</div>
          <h2>From request to result.</h2>
          <div className="steps">
            <div>
              <Code2 size={20} />
              <h3>01 · Validate &amp; reserve</h3>
              <p className="muted">
                Authenticate, enforce scopes, reserve project capacity.
              </p>
            </div>
            <div>
              <Workflow size={20} />
              <h3>02 · Schedule &amp; isolate</h3>
              <p className="muted">
                Select a compatible worker and create a restricted sandbox.
              </p>
            </div>
            <div>
              <Terminal size={20} />
              <h3>03 · Judge &amp; deliver</h3>
              <p className="muted">
                Persist the verdict and emit signed webhook events.
              </p>
            </div>
          </div>
        </section>
      </main>
      <footer className="footer">
        <span>CodeArena / Execution infrastructure</span>
        <Link href="/docs">Build on your own terms ↗</Link>
      </footer>
    </>
  );
}
