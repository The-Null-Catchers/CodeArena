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
const password = "Membership-admin-test-123";
const suffix = crypto.randomUUID();
const emails = {
  owner: `membership-owner-${suffix}@example.com`,
  admin: `membership-admin-${suffix}@example.com`,
  developer: `membership-dev-${suffix}@example.com`,
  viewer: `membership-viewer-${suffix}@example.com`,
  candidate: `membership-candidate-${suffix}@example.com`,
};
let organizationId = "";
const ids: Record<string, string> = {};
let ownerToken = "";
let adminToken = "";

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

async function login(email: string) {
  const response = await limitedFetch(base + "/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  for (const [name, email] of Object.entries(emails)) {
    const row = await db.query(
      "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
      [email, passwordHash],
    );
    ids[name] = row.rows[0].id;
  }
  organizationId = (
    await db.query(
      "INSERT INTO organizations(name) VALUES($1) RETURNING id",
      [`Membership test ${suffix}`],
    )
  ).rows[0].id;
  await db.query(
    `INSERT INTO memberships(organization_id,user_id,role)
     VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'developer'),($1,$5,'viewer')`,
    [organizationId, ids.owner, ids.admin, ids.developer, ids.viewer],
  );
  ownerToken = await login(emails.owner);
  adminToken = await login(emails.admin);
});

afterAll(async () => {
  const userIds = Object.values(ids);
  await db.query("DELETE FROM audit_logs WHERE user_id=ANY($1::uuid[])", [userIds]);
  await db.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [userIds]);
  await db.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
  await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
  await db.end();
});

describe("organization membership administration", () => {
  it("enforces owner/admin role boundaries and protects ownership", async () => {
    const organizations = await request("/v1/organizations", ownerToken);
    expect(organizations.status).toBe(200);
    expect(
      organizations.body.items.some((item: any) => item.id === organizationId),
    ).toBe(true);

    const members = await request(
      `/v1/organizations/${organizationId}/members`,
      adminToken,
    );
    expect(members.status).toBe(200);
    expect(members.body.items).toHaveLength(4);

    const adminCannotGrantAdmin = await request(
      `/v1/organizations/${organizationId}/members`,
      adminToken,
      "POST",
      { email: emails.candidate, role: "admin" },
    );
    expect(adminCannotGrantAdmin.status).toBe(403);

    const added = await request(
      `/v1/organizations/${organizationId}/members`,
      adminToken,
      "POST",
      { email: emails.candidate, role: "developer" },
    );
    expect(added.status).toBe(201);
    expect(added.body.role).toBe("developer");

    const adminCannotPromote = await request(
      `/v1/organizations/${organizationId}/members/${ids.candidate}`,
      adminToken,
      "PATCH",
      { role: "admin" },
    );
    expect(adminCannotPromote.status).toBe(403);

    const promoted = await request(
      `/v1/organizations/${organizationId}/members/${ids.candidate}`,
      ownerToken,
      "PATCH",
      { role: "admin" },
    );
    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe("admin");

    const protectedOwner = await request(
      `/v1/organizations/${organizationId}/members/${ids.owner}`,
      ownerToken,
      "PATCH",
      { role: "viewer" },
    );
    expect(protectedOwner.status).toBe(409);

    const adminCannotRemoveAdmin = await request(
      `/v1/organizations/${organizationId}/members/${ids.candidate}`,
      adminToken,
      "DELETE",
    );
    expect(adminCannotRemoveAdmin.status).toBe(403);

    const removed = await request(
      `/v1/organizations/${organizationId}/members/${ids.candidate}`,
      ownerToken,
      "DELETE",
    );
    expect(removed.status).toBe(200);
    expect(removed.body.ok).toBe(true);

    const cannotRemoveSelf = await request(
      `/v1/organizations/${organizationId}/members/${ids.owner}`,
      ownerToken,
      "DELETE",
    );
    expect(cannotRemoveSelf.status).toBe(409);
  });
});
