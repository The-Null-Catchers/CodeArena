import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import pg from "pg";
import { limitedFetch } from "./http.js";

const base = process.env.API_URL || "http://localhost:4000";
const db = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://codearena:development-db-password@localhost:5432/codearena",
});
const password = "Platform-user-admin-test-123";
const suffix = crypto.randomUUID();
const adminEmail = `user-admin-${suffix}@example.com`;
const userEmail = `managed-user-${suffix}@example.com`;
let adminId = "";
let userId = "";
let adminToken = "";
let userToken = "";

async function login(email: string) {
  const response = await limitedFetch(base + "/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: response.status, body: await response.json() };
}

async function request(
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
) {
  const response = await limitedFetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  adminId = (
    await db.query(
      "INSERT INTO users(email,password_hash,platform_admin) VALUES($1,$2,true) RETURNING id",
      [adminEmail, passwordHash],
    )
  ).rows[0].id;
  userId = (
    await db.query(
      "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
      [userEmail, passwordHash],
    )
  ).rows[0].id;
  const adminLogin = await login(adminEmail);
  const userLogin = await login(userEmail);
  expect(adminLogin.status).toBe(200);
  expect(userLogin.status).toBe(200);
  adminToken = adminLogin.body.accessToken;
  userToken = userLogin.body.accessToken;
});

afterAll(async () => {
  await db.query("DELETE FROM audit_logs WHERE user_id=ANY($1::uuid[])", [
    [adminId, userId],
  ]);
  await db.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [
    [adminId, userId],
  ]);
  await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [adminId, userId],
  ]);
  await db.end();
});

describe("platform user administration", () => {
  it("restricts account administration and revokes sessions on disable", async () => {
    const denied = await request("/v1/admin/users", userToken);
    expect(denied.status).toBe(403);

    const listed = await request(
      `/v1/admin/users?q=${encodeURIComponent(userEmail)}&status=active`,
      adminToken,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(1);
    expect(listed.body.items[0].id).toBe(userId);
    expect(listed.body.items[0].active_sessions).toBeGreaterThanOrEqual(1);

    const disabled = await request(
      `/v1/admin/users/${userId}`,
      adminToken,
      "PATCH",
      { disabled: true },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.disabled).toBe(true);
    expect(disabled.body.revokedSessions).toBeGreaterThanOrEqual(1);

    const revokedSession = await request("/v1/auth/sessions", userToken);
    expect(revokedSession.status).toBe(401);

    const disabledLogin = await login(userEmail);
    expect(disabledLogin.status).toBe(401);

    const enabled = await request(
      `/v1/admin/users/${userId}`,
      adminToken,
      "PATCH",
      { disabled: false },
    );
    expect(enabled.status).toBe(200);
    expect(enabled.body.disabled).toBe(false);
    expect(enabled.body.revokedSessions).toBe(0);

    const recovered = await login(userEmail);
    expect(recovered.status).toBe(200);
  });

  it("does not allow an administrator to disable its current account", async () => {
    const result = await request(
      `/v1/admin/users/${adminId}`,
      adminToken,
      "PATCH",
      { disabled: true },
    );
    expect(result.status).toBe(409);
  });
});
