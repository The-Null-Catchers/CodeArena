import { beforeAll, describe, expect, it } from "vitest";
import { limitedFetch } from "./http.js";

const base = process.env.API_URL || "http://localhost:4000";
let token = "";
let projectId = "";
let challengeId = "";
const slug = `authoring-${crypto.randomUUID()}`;

async function request(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
  authenticated = true,
) {
  const response = await limitedFetch(base + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const registered = await request("/v1/auth/register", {
    email: `challenge-authoring-${crypto.randomUUID()}@example.com`,
    password: "Integration-password-123",
  });
  expect(registered.status).toBe(201);
  token = registered.body.accessToken;
  projectId = (await request("/v1/projects")).body.items[0].id;
  const created = await request("/v1/challenges", {
    projectId,
    title: "Revision zero",
    slug,
    description: "Initial published statement",
    difficulty: "easy",
    visibility: "public",
    languages: ["python", "javascript"],
    judge: "exact",
    tests: [
      { stdin: "1\n", expected: "1\n", hidden: false, weight: 1 },
      { stdin: "2\n", expected: "2\n", hidden: true, weight: 2, group: "core" },
    ],
  });
  expect(created.status).toBe(201);
  challengeId = created.body.id;
});

describe("challenge authoring lifecycle", () => {
  it("moves edits into a private draft revision and preserves desired visibility", async () => {
    const before = await request(`/v1/challenges/${slug}`, undefined, "GET", false);
    expect(before.status).toBe(200);

    const edited = await request(
      `/v1/challenge-authoring/${challengeId}`,
      {
        title: "Revision two",
        difficulty: "medium",
        visibility: "public",
        languages: ["python"],
        tags: ["arrays", "two-pointers"],
        tests: [
          { stdin: "3\n", expected: "3\n", hidden: false, weight: 2 },
          { stdin: "4\n", expected: "4\n", hidden: true, weight: 5, group: "core" },
        ],
      },
      "PATCH",
    );
    expect(edited.status).toBe(200);
    expect(edited.body.status).toBe("draft");
    expect(edited.body.current_revision).toBe(2);
    expect(edited.body.visibility).toBe("public");
    expect(edited.body.publishedVisibility).toBe("private");
    expect(edited.body.languages).toEqual(["python"]);
    expect(edited.body.tags).toEqual(["arrays", "two-pointers"]);

    const hidden = await request(`/v1/challenges/${slug}`, undefined, "GET", false);
    expect(hidden.status).toBe(404);
  });

  it("publishes the draft atomically and records immutable revision metadata", async () => {
    const published = await request(
      `/v1/challenge-authoring/${challengeId}/publish`,
      {},
      "POST",
    );
    expect(published.status).toBe(200);
    expect(published.body.status).toBe("published");
    expect(published.body.visibility).toBe("public");

    const publicChallenge = await request(
      `/v1/challenges/${slug}`,
      undefined,
      "GET",
      false,
    );
    expect(publicChallenge.status).toBe(200);
    expect(publicChallenge.body.title).toBe("Revision two");
    expect(publicChallenge.body.languages).toEqual(["python"]);
    expect(publicChallenge.body.samples).toEqual([{ stdin: "3\n", expected: "3\n" }]);

    const revisions = await request(
      `/v1/challenge-authoring/${challengeId}/revisions`,
    );
    expect(revisions.status).toBe(200);
    expect(revisions.body.items[0].revision).toBe(2);
    expect(revisions.body.items[0].published_at).toBeTruthy();
    expect(revisions.body.items[0].tags).toEqual(["arrays", "two-pointers"]);
  });

  it("stores reusable project-scoped challenge templates", async () => {
    const created = await request("/v1/challenge-templates", {
      projectId,
      name: "Array starter",
      title: "Array task",
      description: "Reusable authoring seed",
      difficulty: "medium",
      visibility: "private",
      judge: "whitespace",
      languages: ["python", "javascript"],
      tags: ["arrays"],
      tests: [{ stdin: "", expected: "", hidden: true, weight: 1 }],
    });
    expect(created.status).toBe(201);

    const listed = await request(
      `/v1/challenge-templates?projectId=${projectId}`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.items.some((item: any) => item.name === "Array starter")).toBe(true);
  });

  it("exposes a runtime-aware leaderboard endpoint", async () => {
    const leaderboard = await request(
      `/v1/challenges/${challengeId}/leaderboard?runtimeId=python:3.13`,
    );
    expect(leaderboard.status).toBe(200);
    expect(leaderboard.body.items).toEqual([]);
  });
});
