import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { limitedFetch } from "../integration/http.js";

const base = process.env.API_URL || "http://localhost:4000";
let access = "";
let project = "";
let organization = "";
const submissions: string[] = [];
const openReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];

async function call(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const response = await limitedFetch(base + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function openControl(projectId: string) {
  const controller = new AbortController();
  const response = await fetch(
    `${base}/v1/control/events?projectId=${projectId}`,
    {
      headers: { Authorization: `Bearer ${access}` },
      signal: controller.signal,
    },
  );
  if (!response.ok || !response.body) {
    controller.abort();
    return { response, controller, reader: undefined };
  }
  const reader = response.body.getReader();
  openReaders.push(reader);
  return { response, controller, reader };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (value: string) => boolean,
  timeoutMs = 8000,
) {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (!predicate(buffer) && Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`CONTROL_LOAD_TIMEOUT:\n${buffer}`)),
          remaining,
        ),
      ),
    ]);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
  }
  expect(predicate(buffer), buffer).toBe(true);
  return buffer;
}

beforeAll(async () => {
  const registered = await call("/v1/auth/register", {
    email: `control-load-${crypto.randomUUID()}@example.com`,
    password: "Control-plane-load-qualification-123",
  });
  expect(registered.status).toBe(201);
  access = registered.body.accessToken;
  const defaultProject = (await call("/v1/projects")).body.items[0];
  project = defaultProject.id;
  organization = defaultProject.organization_id;
});

afterAll(async () => {
  await Promise.all(
    openReaders.map((reader) => reader.cancel().catch(() => undefined)),
  );
});

describe("control-plane load qualification", () => {
  it("fans one scheduled event out to five concurrent streams and enforces the connection cap", async () => {
    const streams = await Promise.all(
      Array.from({ length: 5 }, () => openControl(project)),
    );
    expect(streams.every((stream) => stream.response.status === 200)).toBe(true);

    await Promise.all(
      streams.map(({ reader }) =>
        readUntil(reader!, (value) => value.includes("event: snapshot")),
      ),
    );

    const overflow = await fetch(
      `${base}/v1/control/events?projectId=${project}`,
      { headers: { Authorization: `Bearer ${access}` } },
    );
    expect(overflow.status).toBe(429);
    await overflow.body?.cancel();

    const created = await call("/v1/submissions", {
      projectId: project,
      language: "python",
      version: "3.13",
      source: "import time; time.sleep(2); print('fanout')",
    });
    expect(created.status).toBe(202);
    submissions.push(created.body.id);

    const frames = await Promise.all(
      streams.map(({ reader }) =>
        readUntil(
          reader!,
          (value) =>
            value.includes("event: queue.scheduled") &&
            value.includes(created.body.id),
        ),
      ),
    );
    expect(frames).toHaveLength(5);

    for (const { reader, controller } of streams) {
      controller.abort();
      void reader!.cancel().catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("filters another project while continuing delivery for the selected tenant project", async () => {
    const selectedProject = await call("/v1/projects", {
      organizationId: organization,
      name: `Control selected ${crypto.randomUUID()}`,
    });
    expect(selectedProject.status).toBe(201);

    const selected = await openControl(selectedProject.body.id);
    expect(selected.response.status).toBe(200);
    await readUntil(
      selected.reader!,
      (value) => value.includes("event: snapshot"),
    );

    const otherProject = await call("/v1/projects", {
      organizationId: organization,
      name: `Control isolation ${crypto.randomUUID()}`,
    });
    expect(otherProject.status).toBe(201);

    const other = await call("/v1/submissions", {
      projectId: otherProject.body.id,
      language: "python",
      version: "3.13",
      source: "import time; time.sleep(2); print('other')",
    });
    expect(other.status).toBe(202);
    submissions.push(other.body.id);

    const own = await call("/v1/submissions", {
      projectId: selectedProject.body.id,
      language: "python",
      version: "3.13",
      source: "import time; time.sleep(2); print('selected')",
    });
    expect(own.status).toBe(202);
    submissions.push(own.body.id);

    const buffer = await readUntil(
      selected.reader!,
      (value) =>
        value.includes("event: queue.admitted") &&
        value.includes(own.body.id),
    );
    expect(buffer).not.toContain(other.body.id);

    selected.controller.abort();
    void selected.reader!.cancel().catch(() => undefined);
  });
});
