"use client";
import { use, useState, useEffect } from "react";
import Link from "next/link";
import { api } from "../../../lib/api";
export default function Page({
  params,
}: {
  params: Promise<{ action: string }>;
}) {
  const { action } = use(params),
    [token, setToken] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(
    () =>
      setToken(new URLSearchParams(window.location.search).get("token") || ""),
    [],
  );
  return (
    <main className="auth panel">
      <Link className="brand" href="/">
        ↳ codearena
      </Link>
      <h1>
        {action === "verify"
          ? "Verify your email"
          : action === "reset"
            ? "Choose a new password"
            : "Reset your password"}
      </h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const path =
              action === "verify"
                ? "verify-email"
                : action === "reset"
                  ? "reset-password"
                  : "forgot-password";
            const result = await api(`/v1/auth/${path}`, {
              method: "POST",
              body: JSON.stringify(
                action === "verify"
                  ? { token }
                  : action === "reset"
                    ? { token, password }
                    : { email },
              ),
            });
            setMessage(result.message || "Done. You can sign in now.");
          } catch (e) {
            setMessage((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {action === "reset" ? (
          <>
            <label htmlFor="password">New password</label>
            <input
              className="field"
              id="password"
              type="password"
              minLength={12}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        ) : action !== "verify" ? (
          <>
            <label htmlFor="email">Email</label>
            <input
              className="field"
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </>
        ) : (
          <p className="muted">Confirm ownership of your email address.</p>
        )}
        <button className="button primary" disabled={busy}>
          {action === "verify"
            ? "Verify email"
            : action === "reset"
              ? "Update password"
              : "Send reset link"}
        </button>
      </form>
      <p role="status">{message}</p>
      <Link href="/login">Return to sign in ↗</Link>
    </main>
  );
}
