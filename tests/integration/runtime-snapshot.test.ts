import { beforeAll, afterAll, describe, it, expect } from "vitest";
import pg from "pg";
import { limitedFetch } from "./http.js";
const db = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://codearena:development-db-password@localhost:5432/codearena",
});
const base = process.env.API_URL || "http://localhost:4000";
let token = "",
  project = "";
async function request(path: string, body?: unknown) {
  const r = await limitedFetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  expect(r.ok, `${r.status} ${path}`).toBe(true);
  return r.json();
}
async function wait(id: string) {
  const response = await fetch(base + `/v1/submissions/${id}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  expect(response.ok).toBe(true);
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let pending = "";
  try {
    outer: for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw Error("Stream ended");
      pending += decoder.decode(chunk.value, { stream: true });
      let end;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (
          line &&
          ["completed", "failed", "timed_out", "cancelled"].includes(
            JSON.parse(line.slice(6)).state,
          )
        )
          break outer;
      }
    }
  } finally {
    await reader.cancel();
  }
  return request(`/v1/submissions/${id}`);
}
beforeAll(async () => {
  token = (
    await request("/v1/auth/register", {
      email: `runtime-${crypto.randomUUID()}@example.com`,
      password: "Runtime-qualification-123",
    })
  ).accessToken;
  project = (await request("/v1/projects")).items[0].id;
});
afterAll(async () => {
  await db.end();
});
describe("admission and scheduling use the same immutable runtime", () => {
  it("waits for a matching image and rejects snapshot replacement", async () => {
    const lock = await db.connect();
    let id = "";
    const advertised = (
      await db.query(
        "SELECT worker_id,image_id FROM worker_runtimes WHERE runtime_id='python:3.13'",
      )
    ).rows;
    expect(advertised.length).toBeGreaterThan(0);
    try {
      await lock.query("SELECT pg_advisory_lock(908302)");
      id = (
        await request("/v1/submissions", {
          projectId: project,
          language: "python",
          version: "3.13",
          source: "print('reproducible')",
        })
      ).id;
      const admitted = (await request(`/v1/submissions/${id}`)).submission;
      expect(admitted.state).toBe("queued");
      expect(admitted.runtime_snapshot_origin).toBe("admission");
      expect(admitted.runtime_definition.image).toBe(admitted.runtime_image_id);
      await expect(
        db.query("UPDATE submissions SET runtime_image_id=$2 WHERE id=$1", [
          id,
          `sha256:${"0".repeat(64)}`,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        db.query("UPDATE submissions SET runtime_definition='{}' WHERE id=$1", [
          id,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
      await db.query(
        "UPDATE worker_runtimes SET image_id=$1 WHERE runtime_id='python:3.13'",
        [`sha256:${"0".repeat(64)}`],
      );
      await lock.query("SELECT pg_advisory_unlock(908302)");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(
        (
          await db.query("SELECT state,attempt FROM submissions WHERE id=$1", [
            id,
          ])
        ).rows[0],
      ).toEqual({ state: "queued", attempt: 0 });
    } finally {
      for (const row of advertised)
        await db.query(
          "UPDATE worker_runtimes SET image_id=$2 WHERE worker_id=$1 AND runtime_id='python:3.13'",
          [row.worker_id, row.image_id],
        );
      await lock.query("SELECT pg_advisory_unlock(908302)");
      lock.release();
    }
    const final = await wait(id);
    expect(final.result.verdict).toBe("accepted");
    expect(final.result.stdout).toBe("reproducible\n");
    expect(
      final.events.find((event: any) => event.state === "completed").metadata
        .imageId,
    ).toBe(final.submission.runtime_image_id);
  });
  it("pins a migrated pending submission on its first upgraded claim", async () => {
    const id = (
      await db.query(
        "INSERT INTO submissions(project_id,runtime_id,source,stdin,mode,limits,state) SELECT project_id,runtime_id,$2,'','run',limits,'queued' FROM submissions WHERE project_id=$1 LIMIT 1 RETURNING id",
        [project, "print('legacy-upgrade')"],
      )
    ).rows[0].id;
    const final = await wait(id);
    expect(final.result.verdict).toBe("accepted");
    expect(final.result.stdout).toBe("legacy-upgrade\n");
    expect(final.submission.runtime_snapshot_origin).toBe("legacy-first-claim");
    expect(final.submission.runtime_image_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(final.submission.runtime_definition.image).toBe(
      final.submission.runtime_image_id,
    );
  });
});
