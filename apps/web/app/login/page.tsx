"use client";
import { useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";
export default function Login() {
  const [register, setRegister] = useState(false),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="auth panel">
      <Link className="brand" href="/">
        <b className="brand-mark">↳</b>
        <span>codearena</span>
      </Link>
      <h1>{register ? "Create your workspace" : "Welcome back."}</h1>
      <p className="muted">Your execution infrastructure starts here.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const r = await api(`/v1/auth/${register ? "register" : "login"}`, {
              method: "POST",
              body: JSON.stringify({ email, password }),
            });
            sessionStorage.setItem("ca_access", r.accessToken);
            sessionStorage.setItem("ca_refresh", r.refreshToken);
            window.location.assign("/console/playground");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="email">Email address</label>
        <input
          className="field"
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="password">Password</label>
        <input
          className="field"
          id="password"
          type="password"
          autoComplete={register ? "new-password" : "current-password"}
          minLength={12}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {register && <p className="muted">Use at least 12 characters.</p>}
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        <button className="button primary" disabled={busy}>
          {busy ? "Connecting…" : register ? "Create account" : "Sign in"}
        </button>
      </form>
      <p>
        <Link className="muted" href="/account/forgot">
          Forgot password?
        </Link>
      </p>
      <button
        className="button small"
        style={{ width: "100%" }}
        onClick={() => setRegister(!register)}
      >
        {register
          ? "Already have an account? Sign in"
          : "New here? Create an account"}
      </button>
    </main>
  );
}
