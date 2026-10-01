import { limitedFetch } from "./http.js";
import { beforeAll, describe, it, expect } from "vitest";
const base = process.env.API_URL || "http://localhost:4000";
let token = "",
  project = "";
async function request(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const r = await limitedFetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
beforeAll(async () => {
  const email = `integration-${crypto.randomUUID()}@example.com`;
  const r = await request("/v1/auth/register", {
    email,
    password: "Integration-password-123",
  });
  expect(r.status).toBe(201);
  token = r.data.accessToken;
  project = (await request("/v1/projects")).data.items[0].id;
});
async function submit(source: string, extra: Record<string, unknown> = {}) {
  const r = await request("/v1/submissions", {
    projectId: project,
    language: "python",
    version: "3.13",
    source,
    stdin: "arena",
    ...extra,
  });
  expect(r.status).toBe(202);
  return r.data.id;
}
async function wait(id: string) {
  const response = await fetch(`${base}/v1/submissions/${id}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(90000),
  });
  expect(response.ok).toBe(true);
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) throw new Error("Unexpected end");
      pending += decoder.decode(r.value, { stream: true });
      let end;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (frame.startsWith(":")) continue;
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (
          data &&
          ["completed", "failed", "cancelled", "timed_out"].includes(
            JSON.parse(data.slice(6)).state,
          )
        )
          return (await request(`/v1/submissions/${id}`)).data;
      }
    }
  } finally {
    await reader.cancel();
  }
}
describe("full API → scheduler → Docker flow", () => {
  it("returns real stdin/stdout and a persisted timeline", async () => {
    const r = await wait(await submit("print(input())"));
    expect(r.result.stdout).toBe("arena\n");
    expect(r.events.map((e: any) => e.state)).toEqual(
      expect.arrayContaining([
        "created",
        "queued",
        "scheduled",
        "preparing",
        "running",
        "completed",
      ]),
    );
  });
  it("enforces execution timeout", async () => {
    const r = await wait(
      await submit("while True:pass", {
        limits: { wallTimeMs: 500, cpuTimeMs: 300 },
      }),
    );
    expect(r.submission.state).toBe("timed_out");
  });
  it("cancels queued or running execution idempotently", async () => {
    const id = await submit("while True:pass");
    await request(`/v1/submissions/${id}/cancel`, {});
    await request(`/v1/submissions/${id}/cancel`, {});
    expect((await wait(id)).submission.state).toBe("cancelled");
  });
  it("does not disclose hidden input/output through final results or SSE", async () => {
    const c = (await request("/v1/challenges/reverse-string")).data;
    expect(c.samples).toHaveLength(1);
    const id = await submit("import sys\nprint(sys.stdin.read())", {
      mode: "challenge",
      challengeId: c.id,
    });
    const r = await wait(id);
    expect(r.tests).toHaveLength(2);
    expect(r.result.stdout).toBe("");
    expect(r.result.stderr).toBe("");
    expect(JSON.stringify(r)).not.toContain("sandbox");
    expect(r.tests.some((t: any) => t.hidden)).toBe(true);
  });
  it("enforces API key scope and project ownership", async () => {
    const k = (
      await request("/v1/api-keys", {
        projectId: project,
        name: "Read-only",
        scopes: ["submissions:read"],
      })
    ).data;
    const old = token;
    try {
      token = k.secret;
      expect(
        (
          await request("/v1/submissions", {
            projectId: project,
            language: "python",
            version: "3.13",
            source: "print(1)",
          })
        ).status,
      ).toBe(403);
    } finally {
      token = old;
    }
  });
  it("rejects requests exceeding hard limits", async () =>
    expect(
      (
        await request("/v1/submissions", {
          projectId: project,
          language: "python",
          version: "3.13",
          source: "print(1)",
          limits: { memoryMb: 99999 },
        })
      ).status,
    ).toBe(400));
});

const languageCases = [
  { language: "python", version: "3.13", source: "print(input())" },
  {
    language: "javascript",
    version: "22",
    source: "console.log(require('fs').readFileSync(0, 'utf8'))",
  },
  { language: "typescript", version: "5.8", source: "console.log('arena')" },
  {
    language: "c",
    version: "14",
    source:
      '#include <stdio.h>\nint main(void) { char s[32]; if (scanf("%31s", s) == 1) puts(s); return 0; }',
  },
  {
    language: "cpp",
    version: "14",
    source:
      '#include <iostream>\n#include <string>\nint main() { std::string s; std::cin >> s; std::cout << s << "\\n"; }',
  },
  {
    language: "java",
    version: "21",
    source:
      "import java.util.Scanner;\npublic class Main { public static void main(String[] args) { System.out.println(new Scanner(System.in).nextLine()); } }",
  },
  {
    language: "go",
    version: "1.24",
    source:
      'package main\nimport "fmt"\nfunc main() { var s string; fmt.Scanln(&s); fmt.Println(s) }',
  },
  {
    language: "rust",
    version: "1.85",
    source:
      'use std::io;\nfn main() { let mut s = String::new(); io::stdin().read_line(&mut s).unwrap(); println!("{}", s.trim()); }',
  },
];
describe("qualified runtime matrix through the real queue", () => {
  it.each(languageCases)(
    "executes $language:$version with default limits",
    async (runtime) => {
      const r = await wait(
        await submit(runtime.source, {
          language: runtime.language,
          version: runtime.version,
        }),
      );
      expect(r.result.verdict, JSON.stringify(r.result)).toBe("accepted");
      expect(r.result.stdout).toBe("arena\n");
      expect(r.submission.runtime_snapshot_origin).toBe("admission");
      expect(r.submission.runtime_image_id).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(r.submission.runtime_definition.id).toBe(
        `${runtime.language}:${runtime.version}`,
      );
      expect(
        r.events.find((event: any) => event.state === "completed").metadata
          .imageId,
      ).toBe(r.submission.runtime_image_id);
      expect(r.events.some((e: any) => e.state === "compiling")).toBe(
        !["python", "javascript"].includes(runtime.language),
      );
    },
  );
  it.each(
    languageCases.filter((r) => !["python", "javascript"].includes(r.language)),
  )(
    "persists $language compilation errors without entering running",
    async (runtime) => {
      const r = await wait(
        await submit("this is not valid source !!!", {
          language: runtime.language,
          version: runtime.version,
        }),
      );
      expect(r.result.verdict, JSON.stringify(r.result)).toBe(
        "compilation_error",
      );
      expect(r.submission.state).toBe("completed");
      expect(r.result.compile_output.length).toBeGreaterThan(0);
      expect(r.events.some((e: any) => e.state === "running")).toBe(false);
    },
  );
});
