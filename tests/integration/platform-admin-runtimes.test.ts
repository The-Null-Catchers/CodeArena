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
const password = "Platform-admin-test-123";
const suffix = crypto.randomUUID();
const adminEmail = `platform-admin-${suffix}@example.com`;
const userEmail = `platform-user-${suffix}@example.com`;
let adminId = "";
let userId = "";
let adminToken = "";
let userToken = "";
let runtimeId = "";
let originalEnabled = true;

async function login(email: string) {
  const response = await limitedFetch(base + "/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).accessToken as string;
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
  const runtime = (
    await db.query("SELECT id,enabled FROM runtimes ORDER BY id LIMIT 1")
  ).rows[0];
  if (!runtime) throw new Error("No runtime fixture available");
  runtimeId = runtime.id;
  originalEnabled = runtime.enabled;
  adminToken = await login(adminEmail);
  userToken = await login(userEmail);
});

afterAll(async () => {
  if (runtimeId) {
    await db.query(
      "UPDATE runtimes SET enabled=$2,updated_by=NULL,updated_at=now() WHERE id=$1",
      [runtimeId, originalEnabled],
    );
  }
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

describe("platform administrator runtime controls", () => {
  it("restricts global runtime toggles and records administrator changes", async () => {
    const deniedInventory = await request("/v1/admin/runtimes", userToken);
    expect(deniedInventory.status).toBe(403);

    const inventory = await request("/v1/admin/runtimes", adminToken);
    expect(inventory.status).toBe(200);
    expect(inventory.body.items.some((item: any) => item.id === runtimeId)).toBe(
      true,
    );

    const deniedToggle = await request(
      `/v1/admin/runtimes/${encodeURIComponent(runtimeId)}`,
      userToken,
      "PATCH",
      { enabled: !originalEnabled },
    );
    expect(deniedToggle.status).toBe(403);

    const toggled = await request(
      `/v1/admin/runtimes/${encodeURIComponent(runtimeId)}`,
      adminToken,
      "PATCH",
      { enabled: !originalEnabled },
    );
    expect(toggled.status).toBe(200);
    expect(toggled.body.enabled).toBe(!originalEnabled);

    const persisted = (
      await db.query("SELECT enabled,updated_by FROM runtimes WHERE id=$1", [
        runtimeId,
      ])
    ).rows[0];
    expect(persisted.enabled).toBe(!originalEnabled);
    expect(persisted.updated_by).toBe(adminId);

    const audit = await db.query(
      "SELECT metadata FROM audit_logs WHERE action='platform.runtime.toggle' AND user_id=$1 AND target=$2 ORDER BY created_at DESC LIMIT 1",
      [adminId, runtimeId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].metadata.enabled).toBe(!originalEnabled);

    const publicInventory = await request("/v1/runtimes", adminToken);
    expect(publicInventory.status).toBe(200);
    expect(
      publicInventory.body.items.find((item: any) => item.id === runtimeId)
        .enabled,
    ).toBe(!originalEnabled);
  });
});
