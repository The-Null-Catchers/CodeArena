"use client";
import Link from "next/link";
import { api } from "../lib/api";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Terminal,
  Code2,
  History,
  Folder,
  Key,
  Users,
  Webhook,
  BarChart3,
  Server,
  ListOrdered,
  Box,
  BookOpen,
  LogOut,
  Radio,
} from "lucide-react";
const nav = [
  ["dashboard", "Overview", LayoutDashboard],
  ["playground", "Playground", Terminal],
  ["challenges", "Challenges", Code2],
  ["authoring", "Authoring", Code2],
  ["interviews", "Interviews", Radio],
  ["submissions", "Submissions", History],
  ["projects", "Projects", Folder],
  ["api-keys", "API keys", Key],
  ["sessions", "Sessions", Key],
  ["team", "Team", Users],
  ["webhooks", "Webhooks", Webhook],
  ["usage", "Usage", BarChart3],
  ["platform-analytics", "Platform analytics", BarChart3],
  ["platform-users", "Platform users", Users],
  ["workers", "Workers", Server],
  ["queue", "Queue", ListOrdered],
  ["runtimes", "Runtimes", Box],
] as const;
export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link className="brand" href="/">
          <b className="brand-mark">↳</b>
          <span>
            code<small>arena</small>
          </span>
        </Link>
        <div className="nav-section">EXECUTION CONSOLE</div>
        <nav>
          {nav.map(([slug, label, Icon]) => (
            <Link
              key={slug}
              href={`/console/${slug}`}
              className={path.includes(slug) ? "active" : ""}
            >
              <Icon />
              {label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link href="/docs" style={{ display: "flex", gap: 10 }}>
            <BookOpen size={16} />
            Documentation
          </Link>
          <p>API v1 · Self-hosted</p>
        </div>
      </aside>
      <div>
        <header className="main-header">
          <span className="mono muted">
            workspace / <span style={{ color: "#cfdfef" }}>console</span>
          </span>
          <button
            className="button small"
            onClick={async () => {
              try {
                await api("/v1/auth/logout", { method: "POST" });
              } finally {
                sessionStorage.removeItem("ca_access");
                sessionStorage.removeItem("ca_refresh");
                window.location.assign("/login");
              }
            }}
          >
            <LogOut size={14} />
            Sign out
          </button>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
