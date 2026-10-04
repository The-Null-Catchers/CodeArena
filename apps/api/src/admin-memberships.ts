import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, tx, audit } from "../../../packages/db/src/index.js";
import type { Actor } from "./auth.js";

const organizationIdSchema = z.object({ id: z.string().uuid() });
const memberParamsSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});
const assignableRole = z.enum(["admin", "developer", "viewer"]);

type ActorFn = (req: any) => Promise<Actor>;

async function requireOrganizationAdmin(
  organizationId: string,
  actor: Actor,
  ownerOnly = false,
) {
  if (!actor.userId)
    throw Object.assign(new Error("User session required"), { statusCode: 403 });

  const membership = (
    await pool.query(
      "SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2",
      [organizationId, actor.userId],
    )
  ).rows[0];

  if (
    !membership ||
    (ownerOnly
      ? membership.role !== "owner"
      : !["owner", "admin"].includes(membership.role))
  )
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });

  return membership.role as "owner" | "admin";
}

export function registerAdminMemberships(
  app: FastifyInstance,
  deps: { actor: ActorFn },
) {
  app.get("/v1/organizations", async (req) => {
    const a = await deps.actor(req);
    if (!a.userId)
      throw Object.assign(new Error("User session required"), { statusCode: 403 });
    return {
      items: (
        await pool.query(
          `SELECT o.id,o.name,o.created_at,m.role,
                  (SELECT count(*)::int FROM memberships x WHERE x.organization_id=o.id) member_count,
                  (SELECT count(*)::int FROM projects p WHERE p.organization_id=o.id) project_count
             FROM organizations o
             JOIN memberships m ON m.organization_id=o.id
            WHERE m.user_id=$1
            ORDER BY o.created_at`,
          [a.userId],
        )
      ).rows,
    };
  });

  app.get("/v1/organizations/:id/members", async (req) => {
    const { id } = organizationIdSchema.parse(req.params);
    const a = await deps.actor(req);
    await requireOrganizationAdmin(id, a);
    return {
      items: (
        await pool.query(
          `SELECT u.id,u.email,u.disabled,u.created_at,m.role
             FROM memberships m
             JOIN users u ON u.id=m.user_id
            WHERE m.organization_id=$1
            ORDER BY CASE m.role
              WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
              WHEN 'developer' THEN 2 ELSE 3 END,u.email`,
          [id],
        )
      ).rows,
    };
  });

  app.post("/v1/organizations/:id/members", async (req, reply) => {
    const { id } = organizationIdSchema.parse(req.params);
    const body = z
      .object({
        email: z.string().email().max(254).transform((value) => value.toLowerCase()),
        role: assignableRole.default("developer"),
      })
      .strict()
      .parse(req.body);
    const a = await deps.actor(req);
    const actorRole = await requireOrganizationAdmin(id, a);
    if (body.role === "admin" && actorRole !== "owner")
      throw Object.assign(new Error("Owner role required"), { statusCode: 403 });

    const member = await tx(async (client) => {
      const user = (
        await client.query("SELECT id,email,disabled FROM users WHERE email=$1", [
          body.email,
        ])
      ).rows[0];
      if (!user)
        throw Object.assign(new Error("User not found"), { statusCode: 404 });
      if (user.disabled)
        throw Object.assign(new Error("User disabled"), { statusCode: 409 });

      const inserted = (
        await client.query(
          `INSERT INTO memberships(organization_id,user_id,role)
           VALUES($1,$2,$3)
           RETURNING organization_id,user_id,role`,
          [id, user.id, body.role],
        )
      ).rows[0];
      await audit(client, "organization.member.add", a.userId ?? null, user.id, {
        organizationId: id,
        role: body.role,
      });
      return { ...inserted, email: user.email };
    });

    reply.code(201);
    return member;
  });

  app.patch("/v1/organizations/:id/members/:userId", async (req) => {
    const { id, userId } = memberParamsSchema.parse(req.params);
    const { role } = z.object({ role: assignableRole }).strict().parse(req.body);
    const a = await deps.actor(req);
    const actorRole = await requireOrganizationAdmin(id, a);

    return tx(async (client) => {
      const current = (
        await client.query(
          "SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE",
          [id, userId],
        )
      ).rows[0];
      if (!current)
        throw Object.assign(new Error("Member not found"), { statusCode: 404 });
      if (current.role === "owner")
        throw Object.assign(new Error("Owner role is protected"), {
          statusCode: 409,
        });
      if (
        actorRole !== "owner" &&
        (current.role === "admin" || role === "admin")
      )
        throw Object.assign(new Error("Owner role required"), { statusCode: 403 });

      const updated = (
        await client.query(
          `UPDATE memberships SET role=$3
            WHERE organization_id=$1 AND user_id=$2
            RETURNING organization_id,user_id,role`,
          [id, userId, role],
        )
      ).rows[0];
      await audit(client, "organization.member.role_update", a.userId ?? null, userId, {
        organizationId: id,
        previousRole: current.role,
        role,
      });
      return updated;
    });
  });

  app.delete("/v1/organizations/:id/members/:userId", async (req) => {
    const { id, userId } = memberParamsSchema.parse(req.params);
    const a = await deps.actor(req);
    const actorRole = await requireOrganizationAdmin(id, a);

    if (a.userId === userId)
      throw Object.assign(new Error("Use leave organization for your own membership"), {
        statusCode: 409,
      });

    return tx(async (client) => {
      const current = (
        await client.query(
          "SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE",
          [id, userId],
        )
      ).rows[0];
      if (!current)
        throw Object.assign(new Error("Member not found"), { statusCode: 404 });
      if (current.role === "owner")
        throw Object.assign(new Error("Owner role is protected"), {
          statusCode: 409,
        });
      if (current.role === "admin" && actorRole !== "owner")
        throw Object.assign(new Error("Owner role required"), { statusCode: 403 });

      await client.query(
        "DELETE FROM memberships WHERE organization_id=$1 AND user_id=$2",
        [id, userId],
      );
      await audit(client, "organization.member.remove", a.userId ?? null, userId, {
        organizationId: id,
        previousRole: current.role,
      });
      return { ok: true };
    });
  });
}
