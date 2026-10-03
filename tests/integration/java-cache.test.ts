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

async function submitJava(source: string) {
  const response = await request("/v1/submissions", {
    projectId: project,
    language: "java",
    version: "21",
    source,
    stdin: "arena",
  });
  expect(response.status).toBe(202);
  return response.data.id as string;
}

beforeAll(async () => {
  const response = await request("/v1/auth/register", {
    email: `java-cache-${crypto.randomUUID()}@example.com`,
    password: "Integration-password-123",
  });
  expect(response.status).toBe(201);
  token = response.data.accessToken;
  project = (await request("/v1/projects")).data.items[0].id;
});

describe("Java multi-output compilation cache", () => {
  it("restores the complete class directory including nested classes", async () => {
    const source = `
import java.util.Scanner;
public class Main {
  static class Echo {
    static String value(String input) { return input; }
  }
  public static void main(String[] args) {
    System.out.println(Echo.value(new Scanner(System.in).nextLine()));
  }
}`.trim();

    const first = await wait(await submitJava(source));
    expect(first.result.verdict).toBe("accepted");
    expect(first.result.stdout).toBe("arena\n");

    const second = await wait(await submitJava(source));
    expect(second.result.verdict).toBe("accepted");
    expect(second.result.stdout).toBe("arena\n");
    expect(second.result.compile_output).toContain("compilation cache hit");
    expect(second.submission.runtime_definition.cacheFiles).toEqual(["classes"]);
  });
});
