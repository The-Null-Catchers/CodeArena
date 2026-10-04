import { limitedFetch } from "./http.js";
import { beforeAll, describe, expect, it } from "vitest";

const base = process.env.API_URL || "http://localhost:4000";
let token = "";
let project = "";

async function request(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const response = await limitedFetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}

async function submit(source: string) {
  const response = await request("/v1/submissions", {
    projectId: project,
    language: "python",
    version: "3.13",
    source,
    stdin: "",
  });
  expect(response.status).toBe(202);
  return response.data.id as string;
}

async function wait(id: string) {
  const response = await fetch(`${base}/v1/submissions/${id}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(90000),
  });
  expect(response.ok).toBe(true);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Unexpected end");
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (frame.startsWith(":")) continue;
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const state = JSON.parse(data.slice(6)).state;
        if (["completed", "failed", "cancelled", "timed_out"].includes(state))
          return (await request(`/v1/submissions/${id}`)).data;
      }
    }
  } finally {
    await reader.cancel();
  }
}

beforeAll(async () => {
  const response = await request("/v1/auth/register", {
    email: `generated-artifacts-${crypto.randomUUID()}@example.com`,
    password: "Integration-password-123",
  });
  expect(response.status).toBe(201);
  token = response.data.accessToken;
  project = (await request("/v1/projects")).data.items[0].id;
});

describe("generated sandbox artifacts", () => {
  it("captures direct regular files, sniffs MIME, and rejects symlinks", async () => {
    const result = await wait(
      await submit(`
from pathlib import Path
import os
p = Path("artifacts")
p.mkdir()
(p / "report.json").write_text('{"ok":true}', encoding="utf-8")
(p / "image.txt").write_bytes(bytes.fromhex("89504e470d0a1a0a"))
os.symlink("/etc/passwd", p / "leak.txt")
print("done")
`.trim()),
    );
    expect(result.result.verdict).toBe("accepted");

    const listed = await request(`/v1/submissions/${result.submission.id}/artifacts`);
    expect(listed.status).toBe(200);
    const generated = listed.data.items.filter((item: any) => item.kind === "generated");
    expect(generated).toHaveLength(2);
    expect(generated.find((item: any) => item.filename === "report.json")?.mime_type).toBe(
      "application/json",
    );
    expect(generated.find((item: any) => item.filename === "image.txt")?.mime_type).toBe(
      "image/png",
    );
    expect(generated.some((item: any) => item.filename === "leak.txt")).toBe(false);

    const report = generated.find((item: any) => item.filename === "report.json");
    const download = await limitedFetch(`${base}/v1/artifacts/${report.id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("application/json");
    expect(download.headers.get("content-disposition")).toContain("report.json");
    expect(await download.text()).toBe('{"ok":true}');
  });

  it("captures at most ten generated files", async () => {
    const result = await wait(
      await submit(`
from pathlib import Path
p = Path("artifacts")
p.mkdir()
for i in range(13):
    (p / f"file-{i:02d}.txt").write_text(str(i), encoding="utf-8")
`.trim()),
    );
    expect(result.result.verdict).toBe("accepted");
    const listed = await request(`/v1/submissions/${result.submission.id}/artifacts`);
    const generated = listed.data.items.filter((item: any) => item.kind === "generated");
    expect(generated).toHaveLength(10);
  });
});
