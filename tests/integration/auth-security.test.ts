import { beforeAll, afterAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import pg from "pg";
import { limitedFetch } from "./http.js";

const base = process.env.API_URL || "http://localhost:4000";
const db = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://codearena:development-db-password@localhost:5432/codearena",
});

const password = "Session-security-test-123";
let email = "";
let lockedEmail = "";

async function call(
  path: string,
  body?: unknown,
  token = "",
  method = body ? "POST" : "GET",
  retry429 = true,
) {
  const request: RequestInit = {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "User-Agent": "CodeArena integration evidence",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const response = retry429
    ? await limitedFetch(base + path, request)
    : await fetch(base + path, request);
  return {
    status: response.status,
    body: await response.json(),
    retryAfter: response.headers.get("retry-after"),
  };
}

beforeAll(async () => {
  email = `sessions-${crypto.randomUUID()}@example.com`;
  lockedEmail = `lockout-${crypto.randomUUID()}@example.com`;
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await db.query(
    "INSERT INTO users(email,password_hash) VALUES($1,$3),($2,$3)",
    [email, lockedEmail, passwordHash],
  );
});

afterAll(async () => {
  await db.query("DELETE FROM users WHERE email=ANY($1::text[])", [
    [email, lockedEmail],
  ]);
  await db.end();
});

describe("session management and password login protection", () => {
  it("lists active sessions and revokes one session without revoking another", async () => {
    const first = await call("/v1/auth/login", { email, password });
    const second = await call("/v1/auth/login", { email, password });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const listed = await call(
      "/v1/auth/sessions",
      undefined,
      second.body.accessToken,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(2);
    expect(listed.body.items.filter((item: any) => item.current)).toHaveLength(1);
    expect(listed.body.items[0].userAgent).toBe("CodeArena integration evidence");

    const oldSession = listed.body.items.find((item: any) => !item.current);
    const revoked = await call(
      `/v1/auth/sessions/${oldSession.id}`,
      undefined,
      second.body.accessToken,
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.current).toBe(false);
    expect(
      (await call("/v1/auth/sessions", undefined, first.body.accessToken)).status,
    ).toBe(401);
    expect(
      (await call("/v1/auth/sessions", undefined, second.body.accessToken)).status,
    ).toBe(200);

    expect(
      (await call("/v1/auth/logout", {}, second.body.accessToken)).status,
    ).toBe(200);
    expect(
      (await call("/v1/auth/sessions", undefined, second.body.accessToken)).status,
    ).toBe(401);
  });

  it("locks repeated password failures and recovers cleanly after expiry", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failed = await call(
        "/v1/auth/login",
        { email: lockedEmail, password: "Definitely-wrong-123" },
        "",
        "POST",
        false,
      );
      expect(failed.status).toBe(401);
    }

    const locked = await call(
      "/v1/auth/login",
      { email: lockedEmail, password: "Definitely-wrong-123" },
      "",
      "POST",
      false,
    );
    expect(locked.status).toBe(429);
    expect(Number(locked.retryAfter)).toBeGreaterThan(0);

    const correctWhileLocked = await call(
      "/v1/auth/login",
      { email: lockedEmail, password },
      "",
      "POST",
      false,
    );
    expect(correctWhileLocked.status).toBe(429);

    const state = (
      await db.query(
        "SELECT failed_login_count,login_locked_until FROM users WHERE email=$1",
        [lockedEmail],
      )
    ).rows[0];
    expect(state.failed_login_count).toBe(0);
    expect(new Date(state.login_locked_until).getTime()).toBeGreaterThan(Date.now());

    await db.query(
      "UPDATE users SET login_locked_until=now()-interval '1 second' WHERE email=$1",
      [lockedEmail],
    );
    const recovered = await call(
      "/v1/auth/login",
      { email: lockedEmail, password },
      "",
      "POST",
      false,
    );
    expect(recovered.status).toBe(200);

    const reset = (
      await db.query(
        "SELECT failed_login_count,login_locked_until,last_failed_login_at FROM users WHERE email=$1",
        [lockedEmail],
      )
    ).rows[0];
    expect(reset.failed_login_count).toBe(0);
    expect(reset.login_locked_until).toBeNull();
    expect(reset.last_failed_login_at).toBeNull();

    expect(
      (await call("/v1/auth/logout-all", {}, recovered.body.accessToken)).status,
    ).toBe(200);
    expect(
      (await call("/v1/auth/sessions", undefined, recovered.body.accessToken)).status,
    ).toBe(401);
  });
});
