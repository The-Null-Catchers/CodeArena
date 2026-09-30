import { describe, it, expect } from "vitest";
import {
  judge,
  priorityAllowed,
  quotaExceeded,
  roleCan,
  canTransition,
  selectWorker,
  submissionSchema,
  limitSchema,
  type WorkerInfo,
} from "../../packages/shared/src/domain.js";
import { getRuntime, runtimes } from "../../packages/shared/src/runtimes.js";
import { containerOptions } from "../../packages/shared/src/sandbox.js";
describe("judging", () => {
  it("matches exact output without silently trimming", () => {
    expect(judge("a\n", "a", "exact")).toBe(false);
  });
  it("normalizes whitespace", () =>
    expect(judge("a   b\n", "a b", "whitespace")).toBe(true));
  it("compares case-insensitive strings", () =>
    expect(judge("ARENA", "arena", "case_insensitive")).toBe(true));
  it("uses bounded relative float tolerance", () => {
    expect(judge("1.0000001 3", "1 3", "float")).toBe(true);
    expect(judge("NaN", "NaN", "float")).toBe(false);
    expect(judge("1 2", "1", "float")).toBe(false);
    expect(judge("2", "3", "float")).toBe(false);
  });
});
describe("state machine", () => {
  it("allows the real pipeline", () =>
    expect(canTransition("scheduled", "preparing")).toBe(true));
  it("rejects resurrection and skipping queue", () => {
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("created", "running")).toBe(false);
  });
  it("permits bounded recovery states", () =>
    expect(canTransition("running", "queued")).toBe(true));
});
describe("limits", () => {
  it.each([
    "memoryMb",
    "maxProcesses",
    "wallTimeMs",
    "maxOutputKb",
    "maxFileSizeKb",
  ])("rejects excessive %s", (key) =>
    expect(limitSchema.safeParse({ [key]: 1e9 }).success).toBe(false),
  );
  it("rejects arbitrary execution properties", () =>
    expect(
      submissionSchema.safeParse({
        projectId: "a",
        language: "python",
        version: "3.13",
        source: "x",
        image: "attacker",
      }).success,
    ).toBe(false));
});
describe("runtimes", () => {
  it("has eight distinct centralized runtimes", () => {
    expect(runtimes).toHaveLength(8);
    expect(new Set(runtimes.map((r) => r.id)).size).toBe(8);
  });
  it("rejects unregistered versions", () =>
    expect(() => getRuntime("python", "attacker")).toThrow());
});
describe("scheduling", () => {
  const w = (
    id: string,
    active: number,
    extra: Partial<WorkerInfo> = {},
  ): WorkerInfo => ({
    id,
    slots: 4,
    active,
    status: "online",
    runtimes: ["python:3.13"],
    lastHeartbeat: 1000,
    ...extra,
  });
  it("selects the least loaded compatible worker", () =>
    expect(selectWorker([w("a", 3), w("b", 1)], "python:3.13", 2000)?.id).toBe(
      "b",
    ));
  it("does not schedule drained, full, stale, or incompatible workers", () =>
    expect(
      selectWorker(
        [
          w("a", 0, { status: "draining" }),
          w("b", 4),
          w("c", 0, { lastHeartbeat: -50000 }),
          w("d", 0, { runtimes: [] }),
        ],
        "python:3.13",
        2000,
      ),
    ).toBeUndefined());
});
describe("sandbox policy", () => {
  const c = containerOptions("sha256:reviewed", limitSchema.parse({}), {});
  it("requires non-root, private networking, dropped capabilities and read-only rootfs", () => {
    expect(c.User).toBe("65532:65532");
    expect(c.HostConfig?.NetworkMode).toBe("none");
    expect(c.HostConfig?.CapDrop).toEqual(["ALL"]);
    expect(c.HostConfig?.ReadonlyRootfs).toBe(true);
    expect(c.HostConfig?.Privileged).toBe(false);
    expect(c.HostConfig?.Binds).toBeUndefined();
    expect(c.HostConfig?.SecurityOpt).toContain("no-new-privileges");
  });
  it("applies cgroup memory, process, CPU and writable workspace bounds", () => {
    expect(c.HostConfig?.Memory).toBe(256 * 1024 * 1024);
    expect(c.HostConfig?.MemorySwap).toBe(c.HostConfig?.Memory);
    expect(c.HostConfig?.PidsLimit).toBe(32);
    expect(c.HostConfig?.NanoCpus).toBe(1e9);
    expect(c.HostConfig?.Tmpfs?.["/workspace"]).toContain("size=10240k");
    expect(c.HostConfig?.Tmpfs?.["/workspace"]).toContain(",exec,");
    expect(c.HostConfig?.Tmpfs?.["/tmp"]).toContain(",noexec,");
  });
});

describe("execution regressions", () => {
  it("finalizes compilation errors without pretending code ran", () => {
    expect(canTransition("compiling", "completed")).toBe(true);
    expect(canTransition("completed", "queued")).toBe(false);
  });
  it("enforces priority plans", () => {
    expect(priorityAllowed("high", "normal")).toBe(false);
    expect(priorityAllowed("system", "high")).toBe(false);
    expect(priorityAllowed("low", "normal")).toBe(true);
  });
  it("makes language toolchains available without inheriting platform env", () => {
    for (const r of runtimes) {
      expect(r.environment.join(" ")).not.toMatch(
        /DATABASE_URL|REDIS_URL|JWT_SECRET/,
      );
      expect(r.environment.find((e) => e.startsWith("PATH="))).toContain(
        "/usr/local/go/bin",
      );
    }
  });
});

describe("tenant policy", () => {
  it("reserves the final slot then rejects the next concurrent admission", () => {
    const plan = { maxOutstanding: 20, maxDaily: 1000 };
    expect(quotaExceeded({ outstanding: 19, daily: 999 }, plan)).toBe(false);
    expect(quotaExceeded({ outstanding: 20, daily: 999 }, plan)).toBe(true);
    expect(quotaExceeded({ outstanding: 0, daily: 1000 }, plan)).toBe(true);
  });
  it("denies viewer writes and unknown roles", () => {
    expect(roleCan("viewer", false)).toBe(true);
    expect(roleCan("viewer", true)).toBe(false);
    expect(roleCan("developer", true)).toBe(true);
    expect(roleCan("root", false)).toBe(false);
  });
});
